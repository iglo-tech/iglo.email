// Adapted from listmonk internal/core/subscribers.go (QuerySubscribers, ExportSubscribers,
// getSubscriberCount, execSubQueryTpl, DeleteSubscribersByQuery, BlocklistSubscribersByQuery)
// and internal/core/subscriptions.go (*SubscriptionsByQuery, UnsubscribeListsByQuery) at 6fcd95f.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import type { ExportRow } from "@/subscribers/export";
import {
  countSQL,
  idsSQL,
  pageSQL,
  type Arg,
  type SubscriberFilter,
} from "@/subscribers/query-filter";
import type { QueryRunner } from "@/subscribers/query-runner";
import querySql from "@/subscribers/query.sql" with { type: "text" };
import exportSql from "@/subscribers/export.sql" with { type: "text" };

/** IDs per statement and per streamed batch: bounds memory and statement size. */
export const BATCH = 500;

const json = (ids: bigint[]) => `[${ids.join(",")}]`;

export function createSubscriberQuery(options: {
  /** The write connection; bulk actions run here in one transaction. */
  db: Database;
  /** A read-only connection for built-in filters and export rows. */
  readonly: Database;
  clock: Clock;
  /** Runs statements that embed a raw fragment in a time-limited child process. */
  runner: QueryRunner;
}) {
  const { db, readonly, clock, runner } = options;
  const writes = prepareNamedQueries(db, [{ name: "subscribers/query", sql: querySql }]);
  const reads = prepareNamedQueries(readonly, [{ name: "subscribers/export", sql: exportSql }]);
  const column = (connection: Database, sql: string, args: Arg[]) =>
    (connection.query(sql).values(...args) as unknown[][]).map((row) => row[0] as bigint);
  return {
    /** The total and one page of IDs, from one snapshot. */
    async page(
      filter: SubscriberFilter,
      orderBy: string,
      order: string,
      offset: number,
      limit: number,
    ): Promise<{ total: number; ids: bigint[] }> {
      const count = countSQL(filter),
        page = pageSQL(filter, orderBy, order, offset, limit);
      if (filter.fragment) {
        const [total, ids] = await runner.all([count, page]);
        return { total: Number(total![0] ?? 0n), ids: ids! };
      }
      readonly.run("BEGIN");
      try {
        const total = Number(column(readonly, count.sql, count.args)[0] ?? 0n);
        return { total, ids: total ? column(readonly, page.sql, page.args) : [] };
      } finally {
        readonly.run("COMMIT");
      }
    },
    /**
     * Matching IDs in ascending batches. With a fragment the first item is yielded once the
     * child has validated the statement, so errors surface before a response starts.
     */
    async *ids(filter: SubscriberFilter, only: bigint[] = []): AsyncGenerator<bigint[]> {
      if (filter.fragment) {
        for await (const [, values] of runner.run([idsSQL(filter, { only })]))
          for (let i = 0; i < values.length || i === 0; i += BATCH)
            yield values.slice(i, i + BATCH);
        return;
      }
      yield [];
      let after = 0n;
      while (true) {
        const s = idsSQL(filter, { only, after, limit: BATCH });
        const batch = column(readonly, s.sql, s.args);
        if (!batch.length) return;
        yield batch;
        after = batch.at(-1)!;
      }
    },
    exportRows: (ids: bigint[]) =>
      ids.length ? (reads.get("export-rows").all(json(ids)) as ExportRow[]) : [],
    /**
     * Apply an action to the subscribers matching `filter` inside the caller's write
     * transaction. `candidates` are IDs a raw fragment selected in its snapshot; the built-in
     * filters and current permissions are rechecked here so a concurrent change cannot
     * redirect the action. Without a fragment the whole selection happens here.
     */
    apply(filter: SubscriberFilter, candidates: bigint[] | null, act: (ids: bigint[]) => void) {
      const builtIn = { ...filter, fragment: "" };
      if (candidates) {
        for (let i = 0; i < candidates.length; i += BATCH) {
          const s = idsSQL(builtIn, { only: candidates.slice(i, i + BATCH) });
          const ids = column(db, s.sql, s.args);
          if (ids.length) act(ids);
        }
        return;
      }
      let after = 0n;
      while (true) {
        const s = idsSQL(builtIn, { after, limit: BATCH });
        const ids = column(db, s.sql, s.args);
        if (!ids.length) return;
        act(ids);
        after = ids.at(-1)!;
      }
    },
    transaction(fn: () => void): void {
      writeTransaction(db, fn);
    },
    remove(ids: bigint[]) {
      writes.get("delete-by-ids").run(json(ids));
    },
    blocklist(ids: bigint[]) {
      const now = clock.now().toISOString();
      writes.get("blocklist-by-ids").run(now, json(ids));
      writes.get("blocklist-memberships-by-ids").run(now, json(ids));
    },
    addLists(ids: bigint[], lists: bigint[], status: string) {
      const now = clock.now().toISOString();
      writes
        .get("add-memberships-by-ids")
        .run(status || "unconfirmed", now, now, json(ids), json(lists));
    },
    removeLists(ids: bigint[], lists: bigint[]) {
      writes.get("delete-memberships-by-ids").run(json(ids), json(lists));
    },
    unsubscribeLists(ids: bigint[], lists: bigint[]) {
      writes
        .get("unsubscribe-memberships-by-ids")
        .run(clock.now().toISOString(), json(ids), json(lists));
    },
    close() {
      writes.close();
      reads.close();
    },
  };
}
export type SubscriberQuery = ReturnType<typeof createSubscriberQuery>;
