// Native retention loop over the owner modules' purges (D70); no upstream source.
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "@/app";
import type { Clock } from "@/clock";
import { startLoop } from "@/loops/loop";

export const PURGE_INTERVAL_MS = 3_600_000;
const BATCH = 100;
/** Sends get the writer between passes (docs/perf/B2-retention.md). */
const PAUSE_MS = 250;

/** One short pass of a module over its own rows; at most `limit`, and `[]` when none are due. */
export type Purge = (now: Date, limit: number) => readonly unknown[];

/**
 * Run the owners' purges in turn, one write transaction and one owner per pass, so a backlog
 * costs the same however many tables have one. A pass with rows is followed by the next after a
 * pause; when every owner has nothing, the loop waits `intervalMs`. The rows are the state, so a
 * restart resumes.
 */
export function startPurge(options: {
  db: Database;
  clock: Clock;
  logger: ErrorLogger;
  purges: readonly Purge[];
  batchSize?: number;
}) {
  const { purges } = options;
  let next = 0;
  return startLoop<unknown>({
    db: options.db,
    clock: options.clock,
    logger: options.logger,
    intervalMs: PURGE_INTERVAL_MS,
    pauseMs: PAUSE_MS,
    // Deleting is the whole claim; there is no lease to hold.
    leaseMs: 1,
    batchSize: options.batchSize ?? BATCH,
    claim(now, _lease, batchSize) {
      for (let tried = 0; tried < purges.length; tried++) {
        const purge = purges[next]!;
        next = (next + 1) % purges.length;
        const taken = purge(now, batchSize);
        if (taken.length) return taken;
      }
      return [];
    },
    process: () => {},
  });
}
