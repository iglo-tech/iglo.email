// Adapted from listmonk queries/lists.sql update-list at 6fcd95f.
import type { Database } from "bun:sqlite";
import { prepareNamedQueries } from "@/db/queries";
import sql from "@/campaigns/list-references.sql" with { type: "text" };

export function createCampaignListReferences(db: Database) {
  const queries = prepareNamedQueries(db, [{ name: "campaigns/list-references", sql }]);
  return {
    rename(id: bigint, name: string): void {
      queries.get("update-campaign-list-name").run(name, id);
    },
    close: () => queries.close(),
  };
}
export type CampaignListReferences = ReturnType<typeof createCampaignListReferences>;
