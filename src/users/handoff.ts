// The handoff that signs the instance admin into a project with one sign-in (14-projects section 5,
// B140, D153). Native. The instance mints a token for one project; the project redeems it in-process
// and gives the admin's copy a normal project session, as a password login would.
import { randomBytes } from "node:crypto";
import type { Clock } from "@/clock";
import type { Handler } from "@/server/context";
import { HttpError } from "@/server/response";
import type { Router } from "@/server/router";
import type { Authentication } from "@/users/auth";
import type { UserStore } from "@/users/store";

/** How long a token lives, on the injected clock. */
export const HANDOFF_TTL_MS = 60_000;
/** Tokens held at once; a mint beyond it is refused until older ones expire or are spent. */
const CAPACITY = 1024;

/** Starts with `//`, or holds a backslash, a space or a control character. */
function unsafe(text: string): boolean {
  return (
    text.startsWith("//") ||
    Array.from(text).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127 || character === "\\";
    })
  );
}

/**
 * A handoff target: a local path that starts with one `/`. Backslashes and control characters, also
 * percent-encoded, and a path that decodes to `//` are refused; anything refused becomes `/admin`.
 */
export function safeNext(value: string | null): string {
  if (!value || value.length > 2000 || !value.startsWith("/") || value.startsWith("//")) {
    return "/admin";
  }
  if (unsafe(value)) {
    return "/admin";
  }
  const path = value.split(/[?#]/, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return "/admin";
  }
  return unsafe(decoded) ? "/admin" : value;
}

/** The instance's tokens, in memory only: a restart spends them all. */
export function createHandoffTokens(clock: Clock) {
  const tokens = new Map<string, { slug: string; expires: number }>();
  const sweep = (time: number) => {
    for (const [token, entry] of tokens) {
      if (entry.expires <= time) {
        tokens.delete(token);
      }
    }
  };
  return {
    /** A new single-use token for `slug`, or null while the store is full. */
    mint(slug: string): string | null {
      const time = clock.now().getTime();
      sweep(time);
      if (tokens.size >= CAPACITY) {
        return null;
      }
      const token = randomBytes(32).toString("base64url");
      tokens.set(token, { slug, expires: time + HANDOFF_TTL_MS });
      return token;
    },
    /** True once for a live token minted for `slug`. Any presented token is spent. */
    redeem(slug: string, token: string): boolean {
      const entry = tokens.get(token);
      if (!entry) {
        return false;
      }
      tokens.delete(token);
      return entry.slug === slug && entry.expires > clock.now().getTime();
    },
  };
}

export type HandoffTokens = ReturnType<typeof createHandoffTokens>;

/**
 * `GET /admin/handoff?token=…&next=…` on a project: a valid token gives the admin's copy a session,
 * with today's cookies, and answers 303 to `next`. Anything else is 403 with no session.
 */
export function registerHandoffRoute(
  router: Router,
  store: UserStore,
  auth: Authentication,
  redeem: (token: string) => boolean,
): void {
  const handoff: Handler = (context) => {
    const token = context.url.searchParams.get("token") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !redeem(token)) {
      throw new HttpError(403, "invalid handoff");
    }
    const copy = store.copy();
    const session = copy ? auth.createSession(copy.id) : null;
    if (!session) {
      throw new HttpError(403, "invalid handoff");
    }
    auth.replaceSession(context.request);
    const headers = new Headers({
      Location: safeNext(context.url.searchParams.get("next")),
      "Cache-Control": "no-store",
    });
    for (const value of auth.sessionCookies(session.id, session.csrf, session.duration)) {
      headers.append("Set-Cookie", value);
    }
    return new Response(null, { status: 303, headers });
  };
  router.route("GET", "/admin/handoff", handoff);
}
