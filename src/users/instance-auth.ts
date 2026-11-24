// The instance login and its session (14-projects section 5, B140, D153). Native: listmonk has no
// account above a project. The rules are today's project login's (auth.ts): the same attempt limit,
// argon2id with a dummy hash for an unknown name, a TOTP challenge, and a session cookie with a CSRF
// token sent back as `X-CSRF-Token`. Only the cookie names differ, so both sessions live on the
// instance host: `instance_session`, `instance_csrf` and `instance_nonce`.
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import type { Clock } from "@/clock";
import { HttpError } from "@/server/response";
import type { AdminAccountStore, AdminCredentials } from "@/users/account";
import { cookie, defaultAuthPolicy, equal, PasswordWork } from "@/users/auth";
import type { AuthPolicy } from "@/users/auth";
import { hashPassword } from "@/users/password";
import { newSecret, verifyTOTP } from "@/users/totp";

export const INSTANCE_SESSION = "instance_session";
export const INSTANCE_CSRF = "instance_csrf";
export const INSTANCE_NONCE = "instance_nonce";

const tokenFormat = /^[A-Za-z0-9_-]{43}$/;

function randomValue(): string {
  return randomBytes(32).toString("base64url");
}

export interface InstanceSession {
  readonly id: string;
  readonly csrf: string;
}

export interface InstanceAuthOptions {
  readonly account: AdminAccountStore;
  readonly clock: Clock;
  /** `--root-url`: the instance host's origin, for the Origin check and the Secure attribute. */
  readonly rootUrl: string;
  /**
   * Writes new credentials: instance.db first, then every project's copy (D153). `keepSession` is
   * the instance session that made the change; every other instance session ends.
   */
  readonly change: (credentials: AdminCredentials, keepSession: string) => void;
  readonly policy?: AuthPolicy;
}

export async function createInstanceAuth(options: InstanceAuthOptions) {
  const { account, clock } = options;
  const policy = options.policy ?? defaultAuthPolicy;
  const root = new URL(options.rootUrl);
  const work = new PasswordWork(policy);
  const dummy = await work.run(() => hashPassword(randomValue()));
  const attempts = new Map<string, { start: number; count: number }>();
  const challenges = new Map<string, { password: string; expires: number; failed: number }>();
  const secure = root.protocol === "https:" ? "; Secure" : "";
  const setCookie = (name: string, value: string, httpOnly: boolean, maxAge?: number) =>
    `${name}=${value}; Path=/; SameSite=Lax${httpOnly ? "; HttpOnly" : ""}${secure}${maxAge === undefined ? "" : `; Max-Age=${maxAge}`}`;

  function newSession(): InstanceSession & { duration: number } {
    const id = randomValue();
    const csrf = randomValue();
    const duration = policy.sessionDurationMs;
    if (!account.createSession(id, csrf, duration)) {
      throw new HttpError(403, "invalid session", {}, "invalid_credentials");
    }
    return { id, csrf, duration };
  }
  function challenge(token: string) {
    const time = clock.now().getTime();
    for (const [key, value] of challenges) {
      if (value.expires <= time || value.expires > time + policy.challengeTtlMs) {
        challenges.delete(key);
      }
    }
    return challenges.get(token);
  }
  /** The account as it is now, or nothing when its password changed since `password` was read. */
  function unchanged(password: string) {
    const current = account.get();
    return current && current.password === password ? current : null;
  }

  function checkOrigin(request: Request): void {
    const origin = request.headers.get("origin");
    if (origin === null) {
      return;
    }
    let allowed = false;
    try {
      allowed = new URL(origin).origin === root.origin && origin === new URL(origin).origin;
    } catch {
      /* foreign */
    }
    if (!allowed) {
      throw new HttpError(403, "invalid origin");
    }
  }

  return {
    /** Today's login limit (D60): attempts per address per window, and at most so many addresses. */
    limit(peer: string): void {
      const time = clock.now().getTime();
      for (const [key, entry] of attempts) {
        if (time - entry.start >= policy.loginWindowMs || time < entry.start) {
          attempts.delete(key);
        }
      }
      let current = attempts.get(peer);
      if (!current) {
        if (attempts.size >= policy.maxPeers) {
          throw new HttpError(429, "Too many requests", {
            "Retry-After": String(Math.ceil(policy.loginWindowMs / 1000)),
          });
        }
        current = { start: time, count: 0 };
        attempts.set(peer, current);
      }
      if (current.count >= policy.loginAttempts) {
        throw new HttpError(429, "Too many requests", {
          "Retry-After": String(Math.ceil((current.start + policy.loginWindowMs - time) / 1000)),
        });
      }
      current.count++;
    },
    checkOrigin,
    /** A session, a TOTP challenge token, or null for anything else (no account included). */
    async login(
      username: string,
      password: string,
    ): Promise<(InstanceSession & { duration: number }) | { token: string } | null> {
      const current = account.get();
      const candidate =
        current && current.username === username && current.password.startsWith("$argon2id$")
          ? current
          : null;
      let valid: boolean;
      try {
        valid = await work.run(() => Bun.password.verify(password, candidate?.password ?? dummy));
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }
        return null;
      }
      if (!valid || !candidate) {
        return null;
      }
      const now = unchanged(candidate.password);
      if (!now) {
        return null;
      }
      if (now.twofaType === "totp" && now.twofaKey) {
        if (challenges.size >= policy.challengeCapacity) {
          throw new HttpError(429, "Too many requests");
        }
        const token = randomValue();
        challenges.set(token, {
          password: now.password,
          expires: clock.now().getTime() + policy.challengeTtlMs,
          failed: 0,
        });
        return { token };
      }
      return newSession();
    },
    challengeExists: (token: string): boolean => !!challenge(token),
    verifyChallenge(token: string, code: string): (InstanceSession & { duration: number }) | null {
      const entry = challenge(token);
      if (!entry) {
        return null;
      }
      const current = unchanged(entry.password);
      if (!current || current.twofaType !== "totp" || !current.twofaKey) {
        challenges.delete(token);
        return null;
      }
      if (!verifyTOTP(current.twofaKey, code, clock.now())) {
        if (++entry.failed >= 5) {
          challenges.delete(token);
        }
        return null;
      }
      challenges.delete(token);
      return newSession();
    },
    /** The request's instance session, or null. */
    session(request: Request): InstanceSession | null {
      const id = cookie(request, INSTANCE_SESSION);
      if (!tokenFormat.test(id)) {
        return null;
      }
      const found = account.session(id);
      return found ? { id, csrf: found.csrf } : null;
    },
    /**
     * The session of an instance JSON request. API credentials are never accepted (401), nor is a
     * request without a session; a state-changing request also needs its Origin and CSRF token.
     */
    authorize(request: Request): InstanceSession {
      if (request.headers.has("authorization")) {
        throw new HttpError(
          401,
          "API credentials are not accepted here",
          {},
          "invalid_credentials",
        );
      }
      const id = cookie(request, INSTANCE_SESSION);
      const found = tokenFormat.test(id) ? account.session(id) : null;
      if (!found) {
        throw new HttpError(401, "invalid session", {}, "invalid_credentials");
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        checkOrigin(request);
        if (!equal(request.headers.get("x-csrf-token") ?? "", found.csrf)) {
          throw new HttpError(403, "invalid CSRF token");
        }
      }
      return { id, csrf: found.csrf };
    },
    endSession(id: string): void {
      account.deleteSession(id);
    },
    username: (): string | null => account.get()?.username ?? null,
    twofa: (): "none" | "totp" => account.get()?.twofaType ?? "none",
    nonce: randomValue,
    nonceValid(request: Request, value: string): boolean {
      const present = cookie(request, INSTANCE_NONCE);
      return tokenFormat.test(present) && equal(present, value);
    },
    nonceCookie: (value: string): string => setCookie(INSTANCE_NONCE, value, true),
    sessionCookies(session: InstanceSession & { duration: number }): Array<string> {
      const age = Math.floor(session.duration / 1000);
      return [
        setCookie(INSTANCE_SESSION, session.id, true, age),
        setCookie(INSTANCE_CSRF, session.csrf, false, age),
      ];
    },
    clearCookies: (): Array<string> => [
      setCookie(INSTANCE_SESSION, "", true, 0),
      setCookie(INSTANCE_CSRF, "", false, 0),
    ],
    /** True when `password` is the account's. */
    async verifyPassword(password: string): Promise<boolean> {
      const current = account.get();
      return work
        .run(() => Bun.password.verify(password, current?.password ?? dummy))
        .then((valid) => valid && !!current);
    },
    /** The Account page's password change: the current password first, as a profile change asks. */
    async changePassword(
      session: InstanceSession,
      current: string,
      next: string,
    ): Promise<boolean> {
      const before = account.get();
      if (!before) {
        return false;
      }
      if (!(await work.run(() => Bun.password.verify(current, before.password)))) {
        return false;
      }
      const hash = await work.run(() => hashPassword(next));
      const now = unchanged(before.password);
      if (!now || !account.session(session.id)) {
        throw new HttpError(403, "invalid session", {}, "invalid_credentials");
      }
      options.change(
        { password: hash, twofaType: now.twofaType, twofaKey: now.twofaKey },
        session.id,
      );
      return true;
    },
    /** A new TOTP secret and its QR code, as the project 2FA flow offers one (factor.ts). */
    async totpSecret(): Promise<{ secret: string; qr: string }> {
      const current = account.get();
      if (!current || current.twofaType === "totp") {
        throw new HttpError(400, "TOTP is already enabled");
      }
      const secret = newSecret();
      const uri = new URL(`otpauth://totp/${encodeURIComponent(`iglo.email:${current.username}`)}`);
      uri.search = new URLSearchParams({
        secret,
        issuer: "iglo.email",
        period: "30",
        digits: "6",
        algorithm: "SHA1",
      }).toString();
      const qr = (await QRCode.toBuffer(uri.toString(), { type: "png", width: 200 })).toString(
        "base64",
      );
      return { secret, qr };
    },
    enableTotp(session: InstanceSession, secret: string, code: string): void {
      const current = account.get();
      if (!current) {
        throw new HttpError(403, "invalid session", {}, "invalid_credentials");
      }
      if (current.twofaType === "totp") {
        throw new HttpError(400, "TOTP is already enabled");
      }
      if (!secret || !verifyTOTP(secret, code, clock.now())) {
        throw new HttpError(400, "Invalid TOTP code");
      }
      options.change(
        { password: current.password, twofaType: "totp", twofaKey: secret },
        session.id,
      );
    },
    async disableTotp(session: InstanceSession, password: string): Promise<void> {
      const before = account.get();
      if (!before || before.twofaType !== "totp") {
        throw new HttpError(400, "TOTP is not enabled");
      }
      if (!(await work.run(() => Bun.password.verify(password, before.password)))) {
        throw new HttpError(403, "Invalid password", {}, "invalid_credentials");
      }
      const now = unchanged(before.password);
      if (!now || now.twofaType !== "totp" || !account.session(session.id)) {
        throw new HttpError(403, "invalid session", {}, "invalid_credentials");
      }
      options.change({ password: now.password, twofaType: "none", twofaKey: null }, session.id);
    },
  };
}

export type InstanceAuth = Awaited<ReturnType<typeof createInstanceAuth>>;
