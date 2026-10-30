// Campaign audience and recipient batches adapted from listmonk queries/campaigns.sql
// (next-campaigns, next-campaign-subscribers) and cmd/manager_store.go (NextSubscribers)
// at 6fcd95f.
import type { Database } from "bun:sqlite";
import { prepareNamedQueries } from "@/db/queries";
import sql from "@/subscribers/campaign-recipients.sql" with { type: "text" };

export interface CampaignAudience {
  /** The campaign's lists and their opt-in types. */
  lists: { id: bigint; optin: string }[];
  type: "regular" | "optin";
}
export interface CampaignRecipient {
  id: bigint;
  uuid: string;
  email: string;
  name: string;
  attribs: string;
  external_id: string | null;
}

export function createCampaignRecipients(db: Database) {
  const q = prepareNamedQueries(db, [{ name: "subscribers/campaign-recipients", sql }]);
  const lists = (audience: CampaignAudience) =>
    JSON.stringify(audience.lists.map((l) => ({ id: l.id.toString(), optin: l.optin }))).replace(
      /"id":"(\d+)"/g,
      '"id":$1',
    );
  return {
    /** to_send and max_subscriber_id: distinct qualifying subscribers and the highest ID. */
    measure(audience: CampaignAudience): { count: bigint; max: bigint } {
      return q.get("campaign-audience").get(lists(audience), audience.type) as {
        count: bigint;
        max: bigint;
      };
    },
    /**
     * The next `limit` qualifying subscribers above `after` and at most `max`, in ID order.
     * Fewer than `limit` only when the range is exhausted.
     */
    next(audience: CampaignAudience, after: bigint, max: bigint, limit: number) {
      const ids = q
        .get("campaign-recipient-ids")
        .all(lists(audience), audience.type, after, max, limit) as { id: bigint }[];
      const recipient = q.get("campaign-recipient");
      return ids.map(({ id }) => recipient.get(id) as CampaignRecipient);
    },
    /** Whether the subscriber still qualifies (not unsubscribed or blocklisted since). */
    eligible(audience: CampaignAudience, id: bigint): boolean {
      const row = q.get("campaign-recipient-eligible").get(lists(audience), audience.type, id) as {
        eligible: bigint;
      };
      return row.eligible === 1n;
    },
    close: () => q.close(),
  };
}
export type CampaignRecipients = ReturnType<typeof createCampaignRecipients>;
