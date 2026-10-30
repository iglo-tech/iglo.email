// Per-peer public rate limits (docs/design/07-api-and-ui.md) and the opt-in mail throttle
// adapted from listmonk internal/throttle at 6fcd95f. Both are in memory, bounded and on the
// injected clock.
import type { Clock } from "@/clock";
import { publicMessage } from "@/public/message";
import { HttpError } from "@/server/response";
import type { Middleware } from "@/server/context";

export interface LimitPolicy {
  /** Requests each peer may make per window. */
  limit: number;
  windowMs: number;
  /** Peers tracked at once; beyond it the oldest entry goes, so a flood locks nobody out. */
  maxPeers: number;
}

export function createRateLimit(clock: Clock, policy: LimitPolicy) {
  const peers = new Map<string, { start: number; count: number }>();
  let sweepAt = 0;
  /** Milliseconds until the peer may retry, or 0 when the request is allowed. */
  return (peer: string): number => {
    const time = clock.now().getTime();
    if (time >= sweepAt || time < sweepAt - policy.windowMs) {
      for (const [key, entry] of peers)
        if (time - entry.start >= policy.windowMs || time < entry.start) peers.delete(key);
      sweepAt = time + policy.windowMs;
    }
    let current = peers.get(peer);
    if (current && (time - current.start >= policy.windowMs || time < current.start)) {
      peers.delete(peer);
      current = undefined;
    }
    if (!current) {
      if (peers.size >= policy.maxPeers) peers.delete(peers.keys().next().value!);
      current = { start: time, count: 0 };
      peers.set(peer, current);
    }
    if (current.count >= policy.limit) return current.start + policy.windowMs - time;
    current.count++;
    return 0;
  };
}

/** Excess requests get 429: JSON under /api/, the public message page elsewhere. */
export function rateLimited(clock: Clock, policy: LimitPolicy, siteName: () => string): Middleware {
  const check = createRateLimit(clock, policy);
  return (context, next) => {
    const wait = check(context.peerAddress);
    if (!wait) return next();
    if (context.url.pathname.startsWith("/api/")) throw new HttpError(429, "Too many requests");
    const t = context.app.i18n;
    return publicMessage(
      t,
      {
        status: 429,
        title: t.T("globals.terms.error"),
        message: "Too many requests",
        siteName: siteName(),
      },
      { "Retry-After": String(Math.ceil(wait / 1000)) },
    );
  };
}

/** listmonk throttle.Throttle with exceedCap: past the cap new keys pass unrecorded. */
export function createThrottle(clock: Clock, ttlMs: number, capacity: number) {
  const expires = new Map<string, number>();
  let cleanAt = 0;
  return (key: string): boolean => {
    const time = clock.now().getTime();
    if (time >= cleanAt) {
      for (const [item, expiry] of expires) if (time >= expiry) expires.delete(item);
      cleanAt = time + Math.min(ttlMs, 60_000);
    }
    const expiry = expires.get(key);
    if (expiry !== undefined) {
      if (time < expiry) return false;
    } else if (expires.size >= capacity) return true;
    expires.set(key, time + ttlMs);
    return true;
  };
}
