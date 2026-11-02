// Bounded memory for synchronous transactional sends that carry attachments (B6, D74); native.
import type { Clock } from "@/clock";

/** A reservation of bytes; `release` is idempotent. */
export interface Reservation {
  /** Bytes currently held. */
  readonly bytes: number;
  /** Take on `bytes` more without waiting; false when the budget cannot cover it. */
  grow(bytes: number): boolean;
  /** Give back down to `bytes` held. */
  shrink(bytes: number): void;
  release(): void;
}

/**
 * A byte budget with a bounded number of holders. `acquire` waits up to `waitMs` for room, in
 * arrival order, and returns null when it does not come. A reservation is only ever grown without
 * waiting, so no holder waits on another and the gate cannot deadlock.
 */
export function createByteGate(options: {
  clock: Clock;
  maxBytes: number;
  maxHolders: number;
  waitMs: number;
  /** Waiters beyond this are refused at once, so waiting itself holds nothing unbounded. */
  maxWaiters?: number;
}) {
  let bytes = 0;
  let holders = 0;
  const waiting: Array<{
    cost: number;
    wake: (reservation: Reservation | null) => void;
  }> = [];
  const fits = (cost: number) => holders < options.maxHolders && bytes + cost <= options.maxBytes;

  function open(cost: number): Reservation {
    let held = cost;
    let released = false;
    bytes += cost;
    holders++;
    return {
      get bytes() {
        return held;
      },
      grow(more) {
        if (released || bytes + more > options.maxBytes) return false;
        held += more;
        bytes += more;
        return true;
      },
      shrink(to) {
        if (released || to >= held) return;
        bytes -= held - to;
        held = to;
        drain();
      },
      release() {
        if (released) return;
        released = true;
        bytes -= held;
        holders--;
        drain();
      },
    };
  }
  function drain() {
    while (waiting.length && fits(waiting[0]!.cost)) {
      const next = waiting.shift()!;
      next.wake(open(next.cost));
    }
  }

  return {
    /** Null when `cost` can never fit or the wait ran out. */
    async acquire(cost: number): Promise<Reservation | null> {
      if (cost > options.maxBytes) return null;
      if (!waiting.length && fits(cost)) return open(cost);
      if (waiting.length >= (options.maxWaiters ?? 16)) return null;
      return new Promise<Reservation | null>((resolve) => {
        const timeout = new AbortController();
        const entry = {
          cost,
          wake: (reservation: Reservation | null) => {
            timeout.abort();
            resolve(reservation);
          },
        };
        options.clock.sleep(options.waitMs, timeout.signal).then(
          () => {
            const at = waiting.indexOf(entry);
            if (at < 0) return;
            waiting.splice(at, 1);
            resolve(null);
            drain();
          },
          () => {},
        );
        waiting.push(entry);
      });
    },
    /** Take `cost` now or not at all. */
    tryAcquire: (cost: number): Reservation | null =>
      !waiting.length && cost <= options.maxBytes && fits(cost) ? open(cost) : null,
    stats: () => ({ bytes, holders, waiting: waiting.length }),
  };
}
export type ByteGate = ReturnType<typeof createByteGate>;
