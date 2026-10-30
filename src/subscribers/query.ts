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
import type { QueryRunner, RunnerError } from "@/subscribers/query-runner";
import { noSubscriberEffects, type SubscriberEffects } from "@/subscribers/store";
import querySql from "@/subscribers/query.sql" with { type: "text" };
import exportSql from "@/subscribers/export.sql" with { type: "text" };

/** IDs per statement and per streamed batch: bounds memory and statement size. */
export const BATCH = 500;
/**
 * Large selections (`per_page=all` or oversized pages, exports and raw-SQL bulk actions) hold
 * their matching IDs, about 40 bytes each, in the parent while they run. Two at once keeps the
 * worst case at twice one full selection (docs/perf/M1.7-query.md) and matches the raw-query
 * child pool; these are rare admin operations, so excess requests are refused with 429.
 */
export const LARGE_SELECTIONS = 2;

const json = (ids: bigint[]) => `[${ids.join(",")}]`;

export function createSubscriberQuery(options: {
  /** The write connection; bulk actions run here in one transaction. */
  db: Database;
  /** A read-only connection for built-in filters and export rows. */
  readonly: Database;
  clock: Clock;
  /** Runs statements that embed a raw fragment in a time-limited child process. */
  runner: QueryRunner;
  /** Large selections admitted at once (default LARGE_SELECTIONS). */
  largeSelections?: number;
  /** Consent effects of bulk blocklisting and unsubscribing. */
  effects?: SubscriberEffects;
}) {
  const { db, readonly, clock, runner } = options;
  const effects = options.effects ?? noSubscriberEffects;
  const largeLimit = options.largeSelections ?? LARGE_SELECTIONS;
  let large = 0;
  const writes = prepareNamedQueries(db, [{ name: "subscribers/query", sql: querySql }]);
  const reads = prepareNamedQueries(readonly, [{ name: "subscribers/export", sql: exportSql }]);
  const column = (connection: Database, sql: string, args: Arg[]) =>
    (connection.query(sql).values(...args) as unknown[][]).map((row) => row[0] as bigint);
  return {
    /** Admit one large selection; returns its idempotent release, or undefined when full. */
    admitLarge(): (() => void) | undefined {
      if (large >= largeLimit) return undefined;
      large++;
      let held = true;
      return () => {
        if (held) large--;
        held = false;
      };
    },
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
        return {
          total,
          ids: total ? column(readonly, page.sql, page.args) : [],
        };
      } finally {
        readonly.run("COMMIT");
      }
    },
    /**
     * Matching IDs in ascending batches. With a fragment the first item is yielded once the
     * child has validated the statement, so errors surface before a response starts.
     * `onError` reports a raw query that failed or timed out while nobody was consuming.
     */
    async *ids(
      filter: SubscriberFilter,
      only: bigint[] = [],
      onError?: (error: RunnerError) => void,
    ): AsyncGenerator<bigint[]> {
      if (filter.fragment) {
        // As upstream's export, a COUNT() over the same snapshot runs first, so a failing
        // or timed-out query is reported before any row is streamed.
        const select = idsSQL(filter, { only });
        const statements = [
          { sql: `SELECT COUNT(*) FROM (${select.sql})`, args: select.args },
          select,
        ];
        for await (const [index, values] of runner.run(statements, onError)) {
          if (index === 0) continue;
          for (let i = 0; i < values.length || i === 0; i += BATCH)
            yield values.slice(i, i + BATCH);
        }
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
      effects.deleting?.(
        writes.get("emails-by-ids").all(json(ids)) as {
          id: bigint;
          email: string;
        }[],
      );
      writes.get("delete-by-ids").run(json(ids));
    },
    blocklist(ids: bigint[]) {
      const now = clock.now().toISOString();
      const before = (effects.changed ? writes.get("consent-by-ids").all(json(ids)) : []) as {
        id: bigint;
        status: string;
        lists: string;
      }[];
      writes.get("blocklist-by-ids").run(now, json(ids));
      writes.get("blocklist-memberships-by-ids").run(now, json(ids));
      effects.blocklisted(ids);
      for (const { id, status, lists } of before) {
        const listIds = (JSON.parse(lists) as string[]).map(BigInt);
        if (status !== "blocklisted" || listIds.length)
          effects.changed!({ id, blocklisted: status !== "blocklisted", listIds });
      }
    },
    addLists(ids: bigint[], lists: bigint[], status: string) {
      const now = clock.now().toISOString();
      writes
        .get("add-memberships-by-ids")
        .run(status || "unconfirmed", now, now, json(ids), json(lists));
      // Existing memberships keep their status; only those now unsubscribed end enrollments.
      if (status !== "unsubscribed") return;
      const pairs = writes.get("unsubscribed-memberships-by-ids").all(json(ids), json(lists)) as {
        subscriber_id: bigint;
        list_id: bigint;
      }[];
      const byList = new Map<bigint, bigint[]>();
      for (const { subscriber_id, list_id } of pairs)
        byList.set(list_id, [...(byList.get(list_id) ?? []), subscriber_id]);
      for (const [list, subscribers] of byList) effects.unsubscribed(subscribers, [list]);
    },
    removeLists(ids: bigint[], lists: bigint[]) {
      writes.get("delete-memberships-by-ids").run(json(ids), json(lists));
    },
    unsubscribeLists(ids: bigint[], lists: bigint[]) {
      const ended = new Map<bigint, bigint[]>();
      if (effects.changed)
        for (const { subscriber_id, list_id } of writes
          .get("subscribed-memberships-by-ids")
          .all(json(ids), json(lists)) as { subscriber_id: bigint; list_id: bigint }[])
          ended.set(subscriber_id, [...(ended.get(subscriber_id) ?? []), list_id]);
      writes
        .get("unsubscribe-memberships-by-ids")
        .run(clock.now().toISOString(), json(ids), json(lists));
      effects.unsubscribed(ids, lists);
      for (const [id, listIds] of ended) effects.changed!({ id, blocklisted: false, listIds });
    },
    close() {
      writes.close();
      reads.close();
    },
  };
}
export type SubscriberQuery = ReturnType<typeof createSubscriberQuery>;
