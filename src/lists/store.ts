// Adapted from listmonk internal/core/lists.go, internal/core/core.go and queries/lists.sql at 6fcd95f.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import type { ListCounts } from "@/subscribers/list-counts";
import type { CampaignListReferences } from "@/campaigns/list-references";
import sql from "@/lists/store.sql" with { type: "text" };

interface Row {
  id: bigint;
  uuid: string;
  name: string;
  type: string;
  optin: string;
  status: string;
  tags: string | null;
  description: string;
  created_at: string | null;
  updated_at: string | null;
}
export interface ListInput {
  name: string;
  type: string;
  optin: string;
  status: string;
  tags: string[];
  description: string | null;
}
export interface ListFilter {
  query: string;
  type: string;
  optin: string;
  status: string;
  tags: string[];
}
export interface ListScope {
  all: boolean;
  ids: bigint[];
}
const normalize = (s: string) => s.trim().replace(/[\t\n\v\f\r ]+/g, " ");
// bytes.TrimSpace uses Go Unicode whitespace (including NEL, excluding BOM).
const trimTag = (tag: string) =>
  tag.replace(
    /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,
    "",
  );
export const normalizeTags = (tags: string[]) =>
  tags.map((tag) => trimTag(tag).replace(/[\t\n\v\f\r ]+/g, "-")).filter(Boolean);

export function createListStore(
  db: Database,
  clock: Clock,
  counts: ListCounts,
  campaigns: CampaignListReferences,
) {
  const queries = prepareNamedQueries(db, [{ name: "lists/store", sql }]);
  const byId = (id: bigint) => queries.get("list-by-id").get(id) as Row | null;
  const rows = () => queries.get("all-lists").all() as Row[];
  const visible = (row: Row, scope: ListScope) => scope.all || scope.ids.includes(row.id);
  const matches = (row: Row, filter: ListFilter, scope: ListScope) => {
    const tags: string[] = row.tags ? JSON.parse(row.tags) : [];
    return (
      visible(row, scope) &&
      row.name.toLowerCase().includes(normalize(filter.query).toLowerCase()) &&
      (!filter.type || row.type === filter.type) &&
      (!filter.optin || row.optin === filter.optin) &&
      (!filter.status || row.status === filter.status) &&
      filter.tags.every((tag) => tags.includes(tag))
    );
  };
  const project = (row: Row, statuses: Record<string, number> | null) => ({
    id:
      row.id <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(row.id)
        : (JSON as typeof JSON & { rawJSON(value: string): object }).rawJSON(row.id.toString()),
    created_at: row.created_at,
    updated_at: row.updated_at,
    uuid: row.uuid,
    name: row.name,
    type: row.type,
    optin: row.optin,
    status: row.status,
    tags: row.tags ? JSON.parse(row.tags) : [],
    description: row.description,
    subscriber_count: statuses ? Object.values(statuses).reduce((a, b) => a + b, 0) : 0,
    subscriber_statuses: statuses,
    subscription_created_at: null,
    subscription_updated_at: null,
  });
  const get = (id: bigint) => {
    const row = byId(id);
    return row ? project(row, counts.all().get(id) ?? {}) : null;
  };
  return {
    get,
    query(
      filter: ListFilter,
      scope: ListScope,
      minimal: boolean,
      orderBy: string,
      order: string,
      page: number,
      perPage: number,
    ) {
      let matched = rows().filter((row) =>
        minimal
          ? visible(row, scope) && (!filter.status || row.status === filter.status)
          : matches(row, filter, scope),
      );
      const aggregates = minimal ? new Map<bigint, Record<string, number>>() : counts.all();
      if (minimal) matched.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      else {
        const field = ["name", "status", "created_at", "updated_at", "subscriber_count"].includes(
          orderBy,
        )
          ? orderBy
          : "created_at";
        const direction = !order || order === "asc" ? 1 : -1;
        const value = (row: Row) =>
          field === "subscriber_count"
            ? Object.values(aggregates.get(row.id) ?? {}).reduce((a, b) => a + b, 0)
            : (row[field as keyof Row] ?? "");
        matched.sort((a, b) => {
          const x = value(a),
            y = value(b);
          return direction * (x < y ? -1 : x > y ? 1 : 0);
        });
      }
      const total = matched.length;
      if (!minimal && perPage > 0) matched = matched.slice((page - 1) * perPage, page * perPage);
      // Upstream's window total is unavailable if an out-of-range page returns no rows.
      const actualTotal = matched.length === 0 ? 0 : total;
      return {
        results: matched.map((row) =>
          project(row, minimal ? null : (aggregates.get(row.id) ?? {})),
        ),
        total: actualTotal,
      };
    },
    create(input: ListInput) {
      const now = clock.now().toISOString();
      const row = queries
        .get("insert-list")
        .get(
          crypto.randomUUID(),
          input.name,
          input.type || "private",
          input.optin || "single",
          input.status || "active",
          JSON.stringify(normalizeTags(input.tags)),
          input.description ?? "",
          now,
          now,
        ) as { id: bigint };
      return get(row.id)!;
    },
    update(id: bigint, input: ListInput) {
      return writeTransaction(db, () => {
        const old = byId(id);
        if (!old) return null;
        queries
          .get("update-list")
          .run(
            input.name,
            input.type || old.type,
            input.optin || old.optin,
            input.status || old.status,
            JSON.stringify(normalizeTags(input.tags)),
            input.description ?? old.description,
            clock.now().toISOString(),
            id,
          );
        campaigns.rename(id, input.name);
        return get(id);
      });
    },
    remove(ids: bigint[], filter: ListFilter, scope: ListScope) {
      return writeTransaction(db, () => {
        const selected = ids.length
          ? rows().filter((row) => ids.includes(row.id))
          : rows().filter((row) => matches(row, filter, scope));
        for (const row of selected) queries.get("delete-list").run(row.id);
      });
    },
    close: () => queries.close(),
  };
}
export type ListStore = ReturnType<typeof createListStore>;
