// Native (15-external-sources sections 3 and 4, D171): the realtime stream's tables: one resume
// marker per subscribed topic, the dedupe entries `(kind, record_id, stamp)` and the per-record
// retry queue. Stamps are PocketBase's date text (`YYYY-MM-DD HH:mm:ss.sssZ`), which orders as
// text; queue times are the injected clock's ISO text.
import type { Database } from "bun:sqlite";
import { prepareNamedQueries } from "@/db/queries";
import { sourceDate } from "@/sources/filter";
import type { StreamKind } from "@/sources/stream-record";
import sql from "@/sources/stream.sql" with { type: "text" };

/** A claimed retry row. */
export interface RetryClaim {
  id: bigint;
  kind: StreamKind;
  record_id: string;
  stamp: string;
  attempts: bigint;
  first_failed_at: string;
}

/** A retry queue row as the queue view reads it. */
export interface RetryRow extends RetryClaim {
  next_attempt_at: string;
  last_error: string;
  terminal: bigint;
}

/** The longest error text kept on a retry row. */
const MAX_ERROR = 500;

export function createStreamStore(db: Database) {
  const q = prepareNamedQueries(db, [{ name: "sources/stream", sql }]);
  return {
    /** Every marker, by topic. */
    markers(): Map<string, string> {
      const rows = q.get("markers").all() as Array<{ topic: string; marker: string }>;
      return new Map(rows.map((row) => [row.topic, row.marker]));
    },
    /** Keeps exactly `topics`: drops the others, and starts a missing one at `start` (in a transaction). */
    keepMarkers(topics: ReadonlyArray<string>, start: Date) {
      q.get("markers-keep").run(JSON.stringify(topics));
      const at = sourceDate(start);
      for (const topic of topics) {
        q.get("marker-insert").run(topic, at);
      }
    },
    /** Moves the markers of `topics` forward to `stamp` (in a transaction). */
    advance(topics: ReadonlyArray<string>, stamp: Date) {
      q.get("markers-advance").run(JSON.stringify(topics), sourceDate(stamp));
    },
    seen(kind: StreamKind, id: string, stamp: Date): boolean {
      return q.get("seen").get(kind, id, sourceDate(stamp)) !== null;
    },
    /** Records a record as handled; throws when it was already (in a transaction). */
    markSeen(kind: StreamKind, id: string, stamp: Date) {
      q.get("seen-insert").run(kind, id, sourceDate(stamp));
    },
    /** Drops the dedupe entries of `kind` stamped before `before` (in a transaction). */
    prune(kind: StreamKind, before: Date) {
      q.get("seen-prune").run(kind, sourceDate(before));
    },
    seenCount(): number {
      return Number((q.get("seen-count").get() as { n: bigint }).n);
    },
    /** Queues a record (in a transaction); `terminal` rows are kept for the attention view. */
    enqueue(
      kind: StreamKind,
      id: string,
      stamp: Date,
      now: Date,
      next: Date,
      error: string,
      terminal: boolean,
    ) {
      q.get("retry-insert").run(
        kind,
        id,
        sourceDate(stamp),
        now.toISOString(),
        next.toISOString(),
        error.slice(0, MAX_ERROR),
        terminal ? 1 : 0,
      );
    },
    /** Claims due rows until `leaseUntil` (in a transaction). */
    claim(now: Date, leaseUntil: Date, limit: number): Array<RetryClaim> {
      return q
        .get("retry-claim")
        .all(leaseUntil.toISOString(), now.toISOString(), limit) as Array<RetryClaim>;
    },
    /** Ends a claimed row after its record was handled; throws when the claim was lost. */
    done(claim: Pick<RetryClaim, "id" | "attempts">) {
      if (q.get("retry-done").run(claim.id, claim.attempts).changes !== 1) {
        throw new Error("The retry queue row is no longer claimed");
      }
    },
    /** Sets a claimed row's next attempt, or makes it terminal (in a transaction). */
    failed(
      claim: Pick<RetryClaim, "id" | "attempts">,
      next: Date,
      error: string,
      terminal: boolean,
    ) {
      return (
        q
          .get("retry-failed")
          .run(
            next.toISOString(),
            error.slice(0, MAX_ERROR),
            terminal ? 1 : 0,
            claim.id,
            claim.attempts,
          ).changes === 1
      );
    },
    /** Drops terminal rows that became terminal before `before` (in a transaction). */
    expire(before: Date) {
      q.get("retry-expire").run(before.toISOString());
    },
    /** The queue, oldest first, at most `limit` rows. */
    retries(limit = 1000): Array<RetryRow> {
      return q.get("retries").all(limit) as Array<RetryRow>;
    },
    close: () => q.close(),
  };
}
export type StreamStore = ReturnType<typeof createStreamStore>;
