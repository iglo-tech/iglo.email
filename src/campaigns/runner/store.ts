// Campaign runner persistence adapted from listmonk cmd/manager_store.go and
// queries/campaigns.sql (next-campaigns, update-campaign-counts, update-campaign-status) at
// 6fcd95f. Callers hold the write transaction where a step must be atomic.
import type { Database } from "bun:sqlite";
import { prepareNamedQueries } from "@/db/queries";
import sql from "@/campaigns/runner/store.sql" with { type: "text" };
import type { ContentType } from "@/campaigns/store";

export interface RunnableCampaign {
  id: bigint;
  uuid: string;
  type: "regular" | "optin";
  name: string;
  subject: string;
  from_email: string;
  body: string;
  altbody: string | null;
  content_type: ContentType;
  headers: string;
  attribs: string;
  messenger: string;
  template_id: bigint | null;
  status: string;
  last_subscriber_id: bigint;
  max_subscriber_id: bigint;
  runner_generation: bigint;
}
export type DeliveryStatus = "sent" | "failed" | "unknown" | "skipped";

export function createRunnerStore(db: Database) {
  const q = prepareNamedQueries(db, [{ name: "campaigns/runner/store", sql }]);
  return {
    due(now: string): bigint[] {
      return (q.get("due-campaigns").all(now) as { id: bigint }[]).map((r) => r.id);
    },
    /** Takes the lease when the campaign is due and no live lease holds it. */
    acquire(id: bigint, token: string, until: string, now: string): RunnableCampaign | null {
      return q.get("acquire-campaign").get(id, token, until, now) as RunnableCampaign | null;
    },
    listIds(id: bigint): bigint[] {
      return (q.get("campaign-list-ids").all(id) as { list_id: bigint }[]).map((r) => r.list_id);
    },
    /** Records to_send and max_subscriber_id and sets the campaign running. */
    start(id: bigint, token: string, toSend: bigint, max: bigint, now: string) {
      return q.get("start-campaign").get(id, toSend, max, now, token) as {
        last_subscriber_id: bigint;
        max_subscriber_id: bigint;
      } | null;
    },
    renew(id: bigint, token: string, until: string): boolean {
      return q.get("renew-lease").run(id, token, until).changes > 0;
    },
    release(id: bigint, token: string): void {
      q.get("release-lease").run(id, token);
    },
    state(id: bigint) {
      return q.get("campaign-run-state").get(id) as {
        status: string;
        runner_lease: string | null;
        runner_generation: bigint;
        last_subscriber_id: bigint;
        max_subscriber_id: bigint;
      } | null;
    },
    advance(id: bigint, cursor: bigint, now: string): void {
      q.get("advance-cursor").run(id, cursor, now);
    },
    /** Moves the cursor back to `cursor` while this runner still holds the lease. */
    rewind(id: bigint, token: string, cursor: bigint, now: string): void {
      q.get("rewind-cursor").run(id, token, cursor, now);
    },
    addSent(id: bigint, count: number, now: string): void {
      if (count > 0) q.get("add-sent").run(id, count, now);
    },
    /** False when the subscriber already has a delivery for this campaign. */
    claim(id: bigint, subscriberId: bigint, now: string): boolean {
      return q.get("claim-delivery").run(id, subscriberId, now).changes > 0;
    },
    settle(id: bigint, subscriberId: bigint, status: DeliveryStatus, at: string): void {
      q.get("set-delivery").run(id, subscriberId, status, at);
    },
    /** Releases a claim whose message was never handed to the emailer. */
    unclaim(id: bigint, subscriberId: bigint): void {
      q.get("unclaim-delivery").run(id, subscriberId);
    },
    /** Marks claims left by a stopped runner as unknown and returns their range. */
    abandon(id: bigint, now: string): { count: number; first: bigint | null; last: bigint | null } {
      const found = q.get("abandoned-deliveries").get(id) as {
        count: bigint;
        first: bigint | null;
        last: bigint | null;
      };
      if (found.count > 0n) q.get("mark-abandoned").run(id, now);
      return { count: Number(found.count), first: found.first, last: found.last };
    },
    finish(id: bigint, now: string): boolean {
      return q.get("finish-campaign").run(id, now).changes > 0;
    },
    pause(id: bigint, now: string): boolean {
      return q.get("pause-campaign").run(id, now).changes > 0;
    },
    cancel(id: bigint, now: string): boolean {
      return q.get("cancel-campaign").run(id, now).changes > 0;
    },
    /**
     * The latest campaign delivery counted by the marketing frequency cap, or null.
     * `outstanding` is set while a claim awaits its outcome: it holds the cap at any age.
     */
    lastDelivery(subscriberId: bigint): { at: string; outstanding: boolean } | null {
      const row = q.get("last-delivery").get(subscriberId) as {
        at: string | null;
        outstanding: bigint;
      } | null;
      return row?.at ? { at: row.at, outstanding: row.outstanding === 1n } : null;
    },
    close: () => q.close(),
  };
}
export type RunnerStore = ReturnType<typeof createRunnerStore>;
