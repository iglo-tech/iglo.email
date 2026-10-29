// Lifecycle compared with listmonk's internal/manager/manager.go and pipe.go.
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "@/app";
import type { Clock } from "@/clock";
import { writeTransaction } from "@/db/transaction";

export interface LoopOptions<T> {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: ErrorLogger;
  readonly intervalMs: number;
  readonly leaseMs: number;
  readonly batchSize: number;
  readonly signal?: AbortSignal | undefined;
  claim(now: Date, leaseUntil: Date, batchSize: number): readonly T[];
  process(item: T): Promise<void> | void;
}

export interface RunningLoop {
  readonly done: Promise<void>;
  stop(): Promise<void>;
  wake(): void;
}

export function startLoop<T>(options: LoopOptions<T>): RunningLoop {
  for (const [name, value, max] of [
    ["intervalMs", options.intervalMs, 2_147_483_647],
    ["leaseMs", options.leaseMs, 2_147_483_647],
    ["batchSize", options.batchSize, 1000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new RangeError(`Invalid ${name}`);
  }
  if (Object.prototype.toString.call(options.claim) === "[object AsyncFunction]") {
    throw new TypeError("Claim callback must be synchronous");
  }
  const controller = new AbortController();
  const stopFromSignal = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) stopFromSignal();
  else options.signal?.addEventListener("abort", stopFromSignal, { once: true });
  let idle: AbortController | undefined;
  let notified = false;
  const run = async () => {
    try {
      while (!controller.signal.aborted) {
        const now = options.clock.now();
        const until = new Date(now.getTime() + options.leaseMs);
        if (!Number.isFinite(now.getTime()) || !Number.isFinite(until.getTime()))
          throw new Error("Clock returned an invalid claim time");
        const items = writeTransaction(options.db, () => {
          const claimed: unknown = options.claim(now, until, options.batchSize);
          if (claimed instanceof Promise) void claimed.catch(() => undefined);
          if (!Array.isArray(claimed) || claimed.length > options.batchSize) {
            throw new Error("Claim callback must return an array within the configured batch size");
          }
          return claimed as T[];
        });
        for (const item of items) {
          if (controller.signal.aborted) break;
          await options.process(item);
        }
        // A synchronous or already-resolved processor only yields microtasks.
        // Yield through the injected clock after every bounded batch for I/O and stop delivery.
        if (!controller.signal.aborted) {
          try {
            if (!items.length && notified) {
              notified = false;
              continue;
            }
            idle = new AbortController();
            const abortIdle = () => idle?.abort();
            controller.signal.addEventListener("abort", abortIdle, { once: true });
            try {
              await options.clock.sleep(items.length ? 0 : options.intervalMs, idle.signal);
            } finally {
              controller.signal.removeEventListener("abort", abortIdle);
              idle = undefined;
            }
          } catch (error) {
            if (!controller.signal.aborted && !notified) throw error;
            notified = false;
          }
        }
      }
    } catch (error) {
      try {
        options.logger.error(error);
      } catch {
        /* Keep the original loop failure. */
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", stopFromSignal);
    }
  };
  const done = run();
  // The caller can await `done` later without an interim unhandled rejection.
  void done.catch(() => undefined);
  return {
    done,
    wake() {
      notified = true;
      idle?.abort();
    },
    stop() {
      controller.abort();
      return done;
    },
  };
}
