// Marketing consent follows listmonk queries/campaigns.sql (next-campaign-subscribers) at
// 6fcd95f: double opt-in lists need `confirmed`, single opt-in lists any status but
// `unsubscribed`. The frequency cap is native (docs/design/04-sending.md).
import type { ListReferences } from "@/lists/references";
import type { MarketingPolicy } from "@/messaging/sends";
import { intervalStart } from "@/settings/duration";
import type { SubscriberStore } from "@/subscribers/store";

/** Privacy and marketing settings read for each message and page. */
export interface MarketingSettings {
  rootUrl: string;
  siteName: string;
  /** ISO 8601 `marketing.min_interval`; "" disables the cap. */
  minInterval: string;
  unsubscribeHeader: boolean;
  allowBlocklist: boolean;
  individualTracking: boolean;
  disableTracking: boolean;
}
type Settings = Record<string, any>;
export function marketingSettings(current: Settings): MarketingSettings {
  return {
    rootUrl: current["app.root_url"],
    siteName: current["app.site_name"],
    minInterval: current["marketing.min_interval"],
    unsubscribeHeader: current["privacy.unsubscribe_header"],
    allowBlocklist: current["privacy.allow_blocklist"],
    individualTracking: current["privacy.individual_tracking"],
    disableTracking: current["privacy.disable_tracking"],
  };
}
const fallbackInterval = "P7D";

export function createMarketingPolicy(deps: {
  subscribers: SubscriberStore;
  lists: ListReferences;
  settings: () => MarketingSettings;
  /** Campaign deliveries, which count toward the cap (04-sending.md#frequency-cap). */
  campaignDeliveries?: { lastDelivery(subscriberId: bigint): string | null };
}): MarketingPolicy {
  return {
    consent({ subscriberId, listId }) {
      if (subscriberId === null) return "not_subscribed";
      if (listId === null) return "list_unavailable";
      const list = deps.lists.subscriberMetadata(listId);
      if (!list) return "list_unavailable";
      const membership = deps.subscribers.membership(subscriberId, listId);
      if (!membership) return "not_subscribed";
      if (membership.status === "unsubscribed") return "unsubscribed";
      if (membership.status === "confirmed") return null;
      return list.optin === "double" ? "unconfirmed" : null;
    },
    capStart(now) {
      const start = intervalStart(deps.settings().minInterval, now);
      // Settings validation rejects invalid values; a corrupt stored one keeps the default.
      return start === undefined ? intervalStart(fallbackInterval, now)! : start;
    },
    lastCampaignDelivery(subscriberId) {
      const at = deps.campaignDeliveries?.lastDelivery(subscriberId);
      return at ? new Date(at) : null;
    },
  };
}
