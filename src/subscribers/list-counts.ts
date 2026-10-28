// Adapted from listmonk schema.sql mat_list_subscriber_stats at 6fcd95f.
import type { Database } from "bun:sqlite";
import { prepareNamedQueries } from "@/db/queries";
import sql from "@/subscribers/list-counts.sql" with { type: "text" };

export function createListCounts(db: Database) {
  const queries = prepareNamedQueries(db, [{ name: "subscribers/list-counts", sql }]);
  return {
    all(): Map<bigint, Record<string, number>> {
      const result = new Map<bigint, Record<string, number>>();
      for (const row of queries.get("membership-counts").all() as {
        list_id: bigint;
        status: string;
        count: bigint;
      }[]) {
        let counts = result.get(row.list_id);
        if (!counts) result.set(row.list_id, (counts = {}));
        counts[row.status] = Number(row.count);
      }
      return result;
    },
    close: () => queries.close(),
  };
}
export type ListCounts = ReturnType<typeof createListCounts>;
