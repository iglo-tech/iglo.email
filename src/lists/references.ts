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
    subscriberMetadata(id: bigint) {
      const row = queries.get("subscriber-list-metadata").get(id) as {
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
      } | null;
      if (!row) return null;
      const tags = row.tags ? (JSON.parse(row.tags) as unknown[]) : null;
      // Upstream lazy subscriber projection embeds raw list tags, unlike the
      // standalone list API. normalizeTags stores NULL for an empty result.
      return { ...row, id: Number(row.id), tags: tags?.length ? tags : null };
    },
    close: () => queries.close(),
  };
}

export type ListReferences = ReturnType<typeof createListReferences>;
