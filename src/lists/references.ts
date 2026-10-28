// List label lookup adapted from listmonk queries/roles.sql at 6fcd95f.
import type { Database } from "bun:sqlite";
import { prepareNamedQueries } from "@/db/queries";
import sql from "@/lists/queries.sql" with { type: "text" };

export function createListReferences(db: Database) {
  const queries = prepareNamedQueries(db, [{ name: "lists/references", sql }]);
  return {
    name(id: bigint): string | null {
      return (queries.get("list-name").get(id) as { name: string } | null)?.name ?? null;
    },
    close: () => queries.close(),
  };
}

export type ListReferences = ReturnType<typeof createListReferences>;
