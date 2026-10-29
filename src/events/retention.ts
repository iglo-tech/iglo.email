// Native event retention for the maintenance loop (docs/design/02-architecture.md,
// 03-data-model.md#events); no upstream source.
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "@/app";
import type { Clock } from "@/clock";
import type { EventStore } from "@/events/store";
import { startLoop } from "@/loops/loop";

export const DEFAULT_RETENTION_DAYS = 400;
const HOUR = 3_600_000;

/**
 * Purge events received more than `retentionDays` ago, at most `batchSize` per short write
 * transaction, oldest IDs first. A nonempty batch is followed at once by the next; an empty
 * one waits `intervalMs` (hourly by default).
 */
export function startEventRetention(options: {
  db: Database;
  clock: Clock;
  logger: ErrorLogger;
  events: EventStore;
  retentionDays?: number;
  batchSize?: number;
  intervalMs?: number;
}) {
  const days = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isSafeInteger(days) || days < 1 || days > 36_500)
    throw new RangeError("Invalid event retention");
  const retentionMs = days * 86_400_000;
  return startLoop<bigint>({
    db: options.db,
    clock: options.clock,
    logger: options.logger,
    intervalMs: options.intervalMs ?? HOUR,
    // Deleting is the whole claim; there is no lease to hold.
    leaseMs: 1,
    batchSize: options.batchSize ?? 500,
    claim: (now, _lease, batchSize) =>
      options.events.purge(new Date(now.getTime() - retentionMs), batchSize),
    process: () => {},
  });
}
