// Native event retention for the shared retention loop (D70, docs/design/02-architecture.md,
// 03-data-model.md#events); no upstream source.
import type { Purge } from "@/loops/purge";
import type { EventStore } from "@/events/store";

export const DEFAULT_RETENTION_DAYS = 400;

/**
 * The events owner's purge for `startPurge`: events received more than `retentionDays` ago,
 * oldest IDs first, at most the pass limit per write transaction. The loop pauses between passes
 * and shares them with the other owners, so an expired backlog cannot hold back sends.
 */
export function createEventPurge(
  events: EventStore,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Purge {
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 36_500
  )
    throw new RangeError("Invalid event retention");
  const retentionMs = retentionDays * 86_400_000;
  return (now, limit) =>
    events.purge(new Date(now.getTime() - retentionMs), limit);
}
