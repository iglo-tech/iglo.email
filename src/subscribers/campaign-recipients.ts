// Campaign audience and recipient batches adapted from listmonk queries/campaigns.sql
// (next-campaigns, next-campaign-subscribers) and cmd/manager_store.go (NextSubscribers)
// at 6fcd95f.
import type { Database } from "bun:sqlite";
import { prepareNamedQueries } from "@/db/queries";
import sql from "@/subscribers/campaign-recipients.sql" with { type: "text" };

export interface CampaignAudience {
  /** The campaign's lists and their opt-in types. */
  lists: Array<{ id: bigint; optin: string }>;
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

const lists = (audience: CampaignAudience) =>
  JSON.stringify(audience.lists.map((l) => ({ id: l.id.toString(), optin: l.optin }))).replaceAll(
    /"id":"(\d+)"/g,
    '"id":$1',
  );
export function createCampaignRecipients(db: Database) {
  const q = prepareNamedQueries(db, [{ name: "subscribers/campaign-recipients", sql }]);
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
        .all(lists(audience), audience.type, after, max, limit) as Array<{ id: bigint }>;
      const recipient = q.get("campaign-recipient");
      return ids.map(({ id }) => recipient.get(id) as CampaignRecipient);
    },
    /**
     * Whether the subscriber still qualifies, rechecked at the push. `unavailable`: no subscriber
     * now. `changed`: it has not the UUID and email its message was rendered for. `blocklisted`
     * and `unsubscribed` say why it no longer qualifies (B116, D131).
     */
    eligible(
      audience: CampaignAudience,
      recipient: Pick<CampaignRecipient, "id" | "uuid" | "email">,
    ): "eligible" | "unavailable" | "changed" | "blocklisted" | "unsubscribed" {
      const row = q
        .get("campaign-recipient-eligible")
        .get(lists(audience), audience.type, recipient.id) as {
        uuid: string | null;
        email: string | null;
        status: string | null;
        eligible: bigint;
      };
      if (row.uuid === null) {
        return "unavailable";
      }
      if (row.uuid !== recipient.uuid || row.email !== recipient.email) {
        return "changed";
      }
      if (row.eligible === 1n) {
        return "eligible";
      }
      return row.status === "blocklisted" ? "blocklisted" : "unsubscribed";
    },
    close: () => q.close(),
  };
}
export type CampaignRecipients = ReturnType<typeof createCampaignRecipients>;
