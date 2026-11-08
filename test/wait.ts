// A bounded wait for a condition that depends on real I/O (a write on the thread pool, a loopback
// SMTP sink answering) or on steps of an injected clock.
//
// A wait stops after `wallMs` of real time or `limit` iterations, whichever comes first, and fails
// with a diagnostic that names the limit it reached. The wall bound is the limit that matters: an
// iteration of zero-length yields costs microseconds, so an iteration count cannot bound a wait
// that needs real time (docs/perf/B49-drive-bound.md).

/**
 * Real-time budget of a wait. Bun's default per-test timeout is 5 s for `bun test <path>`, and
 * `bun run test` / `check` pass 30 s. Fixture setup runs inside a test too, so a stuck wait must
 * report its state before 5 s: 3 s leaves room for setup (B49, "Why 3 s").
 */
export const WAIT_WALL_MS = 3_000;

export interface WaitOptions {
  /** Starts a failure message, so the wait is named by the test that owns it. */
  label?: string;
  /** Moves an injected clock forward by `ms` after each unmet check. */
  advance?: (ms: number) => void;
  /** Clock step per unmet check, used with `advance`. */
  step?: number;
  /** Runaway guard on iterations. The wall bound ends a wait long before this in practice. */
  limit?: number;
  /** Real-time budget. */
  wallMs?: number;
  /** Adds the state a test is waiting on to the failure message. */
  describe?: () => string | Promise<string>;
}

/**
 * Resolves once `done()` is true. Each unmet check lets I/O and microtasks run (three zero-length
 * sleeps) and advances the clock by `step`. Rejects with the reason it stopped.
 */
export async function waitWall(
  done: () => boolean | Promise<boolean>,
  options: WaitOptions = {},
): Promise<void> {
  const {
    label = "wait",
    advance,
    step = 50,
    limit = 10_000_000,
    wallMs = WAIT_WALL_MS,
    describe,
  } = options;
  const started = performance.now();
  let last = false;
  let i = 0;
  for (; i < limit && performance.now() - started < wallMs; i++) {
    for (let j = 0; j < 3; j++) await Bun.sleep(0);
    last = await done();
    if (last) return;
    advance?.(step);
  }
  const reason = i >= limit ? `iteration limit ${limit}` : `wall limit ${wallMs} ms`;
  const detail = describe
    ? await Promise.resolve()
        .then(describe)
        .catch((error: unknown) => `state unavailable (${error})`)
    : "";
  const clock = advance ? `, step ${step} ms` : "";
  throw new Error(
    `${label}: condition not reached after ${i} iterations (${reason}${clock}): ` +
      `last condition value ${last}; wall ${Math.round(performance.now() - started)} ms` +
      (detail ? `; ${detail}` : ""),
  );
}
