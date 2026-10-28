// Adapted from listmonk internal/auth/auth.go, cmd/auth.go and cmd/init.go at 6fcd95f.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Clock } from "@/clock";
import type { Roles } from "@/roles/roles";
import type { Middleware, RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";
import type { Identity, UserRow } from "@/users/models";
import type { UserStore } from "@/users/store";

export interface AuthPolicy {
  readonly sessionDurationMs: number;
  readonly loginWindowMs: number;
  readonly loginAttempts: number;
  readonly maxPeers: number;
  readonly maxHashWorkers: number;
  readonly maxHashQueue: number;
}

export const defaultAuthPolicy: AuthPolicy = Object.freeze({
  sessionDurationMs: 7 * 24 * 60 * 60 * 1000,
  loginWindowMs: 60_000,
  loginAttempts: 20,
  maxPeers: 4096,
  maxHashWorkers: 4,
  maxHashQueue: 32,
});

function randomValue(): string {
  return randomBytes(32).toString("base64url");
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function cookie(request: Request, name: string): string {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : "";
}

function parseAuthorization(header: string): { user: string; token: string } {
  let pair: string;
  if (header.startsWith("token")) {
    pair = header.slice(5).replace(/^ +| +$/g, "");
  } else if (header.startsWith("Basic")) {
    const encoded = header.slice(5).replace(/^ +| +$/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
      throw new HttpError(
        403,
        "code=400, message=invalid Base64 value in Basic Authorization header",
      );
    pair = Buffer.from(encoded, "base64").toString("utf8");
  } else throw new HttpError(403, "code=400, message=unknown Authorization scheme");
  const separator = pair.indexOf(":");
  if (separator === -1) throw new HttpError(403, "code=400, message=api_key:token missing");
  const user = pair.slice(0, separator),
    token = pair.slice(separator + 1);
  if (!user || !token) throw new HttpError(403, "code=400, message=empty `api_key` or `token`");
  return { user, token };
}

class PasswordWork {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly policy: AuthPolicy) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.policy.maxHashWorkers) {
      if (this.waiting.length >= this.policy.maxHashQueue)
        throw new HttpError(429, "Too many requests");
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export async function createAuthentication(
  store: UserStore,
  roles: Roles,
  clock: Clock,
  rootUrl: string,
  policy: AuthPolicy,
) {
  if (
    policy.sessionDurationMs < 1 ||
    policy.loginWindowMs < 1 ||
    policy.loginAttempts < 1 ||
    policy.maxPeers < 1 ||
    policy.maxHashWorkers < 1 ||
    policy.maxHashQueue < 0
  )
    throw new Error("Invalid authentication policy");
  const root = new URL(rootUrl);
  const work = new PasswordWork(policy);
  const dummy = await work.run(() => Bun.password.hash(randomValue(), { algorithm: "argon2id" }));
  const attempts = new Map<string, { start: number; count: number }>();
  function checkOrigin(request: Request): void {
    const origin = request.headers.get("origin");
    if (origin === null) return;
    let allowed = false;
    try {
      allowed = new URL(origin).origin === root.origin && origin === new URL(origin).origin;
    } catch {
      /* foreign */
    }
    if (!allowed) throw new HttpError(403, "invalid origin");
  }
  function limit(peer: string): void {
    const time = clock.now().getTime();
    for (const [key, entry] of attempts)
      if (time - entry.start >= policy.loginWindowMs || time < entry.start) attempts.delete(key);
    let current = attempts.get(peer);
    if (!current) {
      if (attempts.size >= policy.maxPeers) throw new HttpError(429, "Too many requests");
      current = { start: time, count: 0 };
      attempts.set(peer, current);
    }
    if (current.count >= policy.loginAttempts) throw new HttpError(429, "Too many requests");
    current.count++;
  }
  function identity(request: Request): Identity {
    const authorization = (request.headers.get("authorization") ?? "").trim();
    let user: UserRow | null = null;
    let transport: "header" | "session";
    let sessionId: string | undefined;
    let csrf: string | undefined;
    if (authorization) {
      const pair = parseAuthorization(authorization);
      user = store.byName(pair.user);
      const digest = createHash("sha256").update(pair.token).digest("hex");
      const eligible =
        user?.type === "api" &&
        user.status === "enabled" &&
        /^[a-f0-9]{64}$/.test(user.password ?? "");
      const stored = eligible ? user!.password! : "0".repeat(64);
      if (!equal(digest, stored) || !eligible) throw new HttpError(403, "invalid API credentials");
      transport = "header";
    } else {
      sessionId = cookie(request, "session");
      if (!/^[A-Za-z0-9_-]{43}$/.test(sessionId)) throw new HttpError(403, "invalid session");
      const session = store.session(sessionId, policy.sessionDurationMs);
      if (!session) throw new HttpError(403, "invalid session");
      user = session.user;
      csrf = session.csrf;
      transport = "session";
    }
    if (!user) throw new HttpError(403, "invalid session");
    const role = roles.userRole(user.user_role_id);
    if (!role) throw new HttpError(403, "invalid session");
    return {
      user,
      role,
      transport,
      ...(sessionId ? { sessionId } : {}),
      ...(csrf ? { csrf } : {}),
    };
  }
  function authorize(context: RequestContext, permission?: string): Identity {
    const principal = identity(context.request);
    if (!["GET", "HEAD", "OPTIONS"].includes(context.request.method)) {
      checkOrigin(context.request);
      if (
        principal.transport === "session" &&
        !equal(context.request.headers.get("x-csrf-token") ?? "", principal.csrf ?? "")
      )
        throw new HttpError(403, "invalid CSRF token");
    }
    if (permission && !roles.can(principal.role, permission))
      throw new HttpError(403, `permission denied: ${permission}`);
    return principal;
  }
  function middleware(permission?: string): Middleware {
    return (context, next) => {
      context.identity = authorize(context, permission);
      return next();
    };
  }
  const secure = root.protocol === "https:" ? "; Secure" : "";
  function setCookie(name: string, value: string, httpOnly: boolean, maxAge?: number): string {
    return `${name}=${value}; Path=/; SameSite=Lax${httpOnly ? "; HttpOnly" : ""}${secure}${maxAge === undefined ? "" : `; Max-Age=${maxAge}`}`;
  }
  return {
    middleware,
    revalidate(context: RequestContext, permission?: string): void {
      const prior = context.identity;
      if (!prior) throw new Error("Authenticated identity is required");
      const current = authorize(context, permission);
      if (
        current.user.id !== prior.user.id ||
        current.transport !== prior.transport ||
        current.sessionId !== prior.sessionId
      )
        throw new HttpError(403, "invalid session");
      context.identity = current;
    },
    checkOrigin,
    limit,
    nonce(): string {
      return randomValue();
    },
    nonceValid(request: Request, value: string): boolean {
      const present = cookie(request, "nonce");
      return /^[A-Za-z0-9_-]{43}$/.test(present) && equal(present, value);
    },
    nonceCookie(value: string): string {
      return setCookie("nonce", value, true);
    },
    sessionCookies(id: string, csrf: string): string[] {
      const age = Math.floor(policy.sessionDurationMs / 1000);
      return [setCookie("session", id, true, age), setCookie("csrf", csrf, false, age)];
    },
    clearCookies(): string[] {
      return [setCookie("session", "", true, 0), setCookie("csrf", "", false, 0)];
    },
    async hash(password: string): Promise<string> {
      return work.run(() => Bun.password.hash(password, { algorithm: "argon2id" }));
    },
    async login(username: string, password: string): Promise<{ id: string; csrf: string } | null> {
      const user = store.byName(username);
      const candidate =
        user?.type === "user" &&
        user.status === "enabled" &&
        user.password_login !== 0n &&
        user.twofa_type === "none" &&
        user.password?.startsWith("$argon2id$")
          ? user
          : null;
      let valid = false;
      try {
        valid = await work.run(() => Bun.password.verify(password, candidate?.password ?? dummy));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        await work.run(() => Bun.password.verify(password, dummy));
        return null;
      }
      if (!valid || !candidate) return null;
      const id = randomValue(),
        csrf = randomValue();
      return store.createSession(candidate, id, csrf) ? { id, csrf } : null;
    },
    endSession(context: RequestContext): void {
      if (context.identity?.sessionId) store.deleteSession(context.identity.sessionId);
    },
    replaceSession(request: Request): void {
      const prior = cookie(request, "session");
      if (/^[A-Za-z0-9_-]{43}$/.test(prior)) store.deleteSession(prior);
    },
  };
}

export type Authentication = Awaited<ReturnType<typeof createAuthentication>>;
