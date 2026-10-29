// Adapted from listmonk queries/templates.sql delete-template at 6fcd95f.
import type { Database } from "bun:sqlite";
import { prepareNamedQueries } from "@/db/queries";
import sql from "@/campaigns/template-references.sql" with { type: "text" };

export function createCampaignTemplateReferences(db: Database) {
  const queries = prepareNamedQueries(db, [{ name: "campaigns/template-references", sql }]);
  return {
    reassign(from: bigint, to: bigint): void {
      queries.get("reassign-primary-template").run(to, from);
    },
    close: () => queries.close(),
  };
}
export type CampaignTemplateReferences = ReturnType<typeof createCampaignTemplateReferences>;
