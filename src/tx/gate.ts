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
  /**
   * How many later arrivals that fit may be admitted ahead of the oldest waiter by `admit`. Past
   * it they queue behind that waiter, so a steady stream of small sends cannot starve it.
   */
  maxOvertakes?: number;
}) {
  let bytes = 0;
  let holders = 0;
  const waiting: Array<{
    cost: number;
    /** Arrivals `admit` let in ahead of this entry while it was first in line. */
    overtaken: number;
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

  function queue(cost: number): Promise<Reservation | null> {
    if (waiting.length >= (options.maxWaiters ?? 16)) return Promise.resolve(null);
    return new Promise<Reservation | null>((resolve) => {
      const timeout = new AbortController();
      const entry = {
        cost,
        overtaken: 0,
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
  }

  return {
    /** Null when `cost` can never fit or the wait ran out. Strictly in arrival order. */
    async acquire(cost: number): Promise<Reservation | null> {
      if (cost > options.maxBytes) return null;
      if (!waiting.length && fits(cost)) return open(cost);
      return queue(cost);
    },
    /**
     * For a send that holds nothing yet. Null at once when it does not fit now. When it fits it
     * goes ahead of a waiter that cannot fit yet, so a few hundred bytes are not refused for a
     * large upload's sake; but only
     * `maxOvertakes` times per waiter. After that it queues behind the waiter like `acquire`,
     * which bounds what can pass a waiter to the holders it already had plus that many.
     */
    async admit(cost: number): Promise<Reservation | null> {
      if (cost > options.maxBytes) return null;
      if (!fits(cost)) return null;
      const head = waiting[0];
      if (!head) return open(cost);
      if (head.overtaken < (options.maxOvertakes ?? 8)) {
        head.overtaken++;
        return open(cost);
      }
      return queue(cost);
    },
    stats: () => ({ bytes, holders, waiting: waiting.length }),
  };
}
export type ByteGate = ReturnType<typeof createByteGate>;
