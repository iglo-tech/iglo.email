// Link registration, clicks and views for sends, adapted from listmonk
// internal/manager/manager.go (trackLink) and internal/core/campaigns.go at 6fcd95f.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import sql from "@/unsubscribe/tracking.sql" with { type: "text" };

/** Longer URLs are left untracked, as listmonk falls back when registration fails. */
const MAX_URL_BYTES = 8 * 1024;

export function createTracking(db: Database, clock: Clock) {
  const q = prepareNamedQueries(db, [{ name: "unsubscribe/tracking", sql }]);
  return {
    /** The link UUID for a URL, registering it once; null when it cannot be tracked. */
    link(url: string): string | null {
      if (Buffer.byteLength(url) > MAX_URL_BYTES) return null;
      const row = q.get("create-link").get(crypto.randomUUID(), url) as { uuid: string };
      return row.uuid;
    },
    get(uuid: string) {
      return q.get("get-link").get(uuid) as { id: bigint; url: string } | null;
    },
    click(sendId: bigint, linkId: bigint, subscriberId: bigint | null) {
      q.get("register-send-click").run(sendId, linkId, subscriberId, clock.now().toISOString());
    },
    view(sendId: bigint, subscriberId: bigint | null) {
      q.get("register-send-view").run(sendId, subscriberId, clock.now().toISOString());
    },
    subscriberClicks: (subscriberId: bigint) =>
      (q.get("subscriber-link-clicks").all(subscriberId) as { url: string; clicks: bigint }[]).map(
        (row) => ({ url: row.url, clicks: Number(row.clicks) }),
      ),
    close: () => q.close(),
  };
}
export type Tracking = ReturnType<typeof createTracking>;
