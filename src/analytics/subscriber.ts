// Adapted from listmonk internal/core/subscribers.go (GetSubscriberActivity,
// DeleteSubscriberActivity) at 6fcd95f.
import type { Database } from "bun:sqlite";
import sql from "@/analytics/subscriber.sql" with { type: "text" };
import { prepareNamedQueries } from "@/db/queries";

const numbers = <T extends object>(row: T) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "bigint" ? Number(value) : value,
    ]),
  );

export function createSubscriberTracking(db: Database) {
  const q = prepareNamedQueries(db, [{ name: "analytics/subscriber", sql }]);
  const clear = {
    campaign_views: q.get("delete-subscriber-campaign-views"),
    link_clicks: q.get("delete-subscriber-link-clicks"),
  };
  return {
    /** The subscriber's views by campaign and clicks by link and campaign, newest first. */
    activity: (id: bigint) => ({
      campaign_views: (q.get("subscriber-activity-views").all(id) as object[]).map(numbers),
      link_clicks: (q.get("subscriber-activity-clicks").all(id) as object[]).map(numbers),
    }),
    /** False for a type that is not one of the two. */
    clear(id: bigint, type: string) {
      if (type !== "campaign_views" && type !== "link_clicks") return false;
      clear[type].run(id);
      return true;
    },
    close: () => q.close(),
  };
}
