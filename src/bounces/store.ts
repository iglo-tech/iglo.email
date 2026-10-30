// Adapted from listmonk internal/core/bounces.go and queries/bounces.sql at 6fcd95f. Native
// additions: `send_id`, a null `subscriber_id` for an unlinked send, and provider receipts.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import type { BounceTarget } from "@/messaging/sends";
import { sanitizeEmail } from "@/subscribers/email";
import type { SubscriberStore } from "@/subscribers/store";
import type { RecordedBounce } from "@/webhooks/effects";
import query from "@/bounces/query.sql" with { type: "text" };
import sql from "@/bounces/store.sql" with { type: "text" };

export const reUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const bounceTypes = ["soft", "hard", "complaint"] as const;
export type BounceType = (typeof bounceTypes)[number];
export interface BounceAction {
  count: number;
  action: string;
}
export interface BounceEvent {
  /** Takes precedence over `email`, as upstream's `CASE WHEN $1 != ''`. */
  subscriberUuid: string;
  email: string;
  campaignUuid: string;
  /** Native: the send the message identifies. A send that resolves settles who is named. */
  sendUuid: string;
  /**
   * Native, normalized: the address that bounced, which a message's identity must agree with. A
   * Message-ID names a message, and a copy of it has the same one. Empty for a caller's own claim.
   */
  recipient: string;
  type: BounceType;
  source: string;
  /** A JSON object. */
  meta: string;
  /** `meta` without provider text, for a row that no subscriber's wipe or export can reach. */
  bareMeta: string;
  createdAt: string;
}
export interface BounceFilter {
  id?: bigint | number;
  campaignId?: bigint | number;
  subscriberId?: bigint | number;
  source?: string;
  type?: string;
  orderBy?: string;
  order?: string;
  offset: number;
  /** 0 is no limit. */
  limit: number;
}
interface Row {
  total: bigint;
  id: bigint;
  type: string;
  source: string;
  meta: string;
  created_at: string;
  subscriber_id: bigint | null;
  send_id: bigint | null;
  campaign_id: bigint | null;
  subscriber_uuid: string | null;
  email: string | null;
  subscriber_status: string | null;
  campaign_name: string | null;
}
// Upstream's `campaign_name` names no column and fails with a 500 (07-api-and-ui.md).
const sortColumns: Record<string, string> = {
  email: "email",
  campaign_name: "c.name",
  source: "b.source",
  created_at: "b.created_at",
  type: "b.type",
};
const safeID = (id: bigint) =>
  id <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(id)
    : (JSON as typeof JSON & { rawJSON(value: string): object }).rawJSON(id.toString());
// models.Bounce: empty address fields are omitted, and `subscriber_status` never is.
const project = (row: Row) => ({
  id: safeID(row.id),
  type: row.type,
  source: row.source,
  meta: JSON.parse(row.meta) as unknown,
  created_at: row.created_at,
  ...(row.email ? { email: row.email } : {}),
  ...(row.subscriber_uuid === null ? {} : { subscriber_uuid: row.subscriber_uuid }),
  ...(row.subscriber_id === null ? {} : { subscriber_id: safeID(row.subscriber_id) }),
  subscriber_status: row.subscriber_status ?? "",
  ...(row.send_id === null ? {} : { send_id: safeID(row.send_id) }),
  campaign:
    row.campaign_id === null ? null : { id: safeID(row.campaign_id), name: row.campaign_name },
});

export function createBounceStore(
  db: Database,
  clock: Clock,
  deps: {
    subscribers: () => Pick<
      SubscriberStore,
      | "get"
      | "byUuid"
      | "byEmail"
      | "bounceBlocklist"
      | "bounceUnsubscribe"
      | "remove"
      | "blocklist"
    >;
    sendTarget: (uuid: string) => BounceTarget | null;
    campaignID: (uuid: string) => bigint | null;
    recorded: (bounce: RecordedBounce) => void;
    actions: () => Record<string, BounceAction>;
  },
) {
  const q = prepareNamedQueries(db, [{ name: "bounces/store", sql }]);
  const json = (ids: (bigint | number)[]) => JSON.stringify(ids.map(String));
  const rows = (filter: BounceFilter) => {
    const direction = filter.order === "asc" ? "ASC" : "DESC";
    const column = sortColumns[filter.orderBy ?? ""] ?? "b.created_at";
    // Postgres sorts nulls as the largest value; the ID settles ties in stored rows.
    const order = `${column} ${direction} NULLS ${direction === "ASC" ? "LAST" : "FIRST"}, b.id DESC`;
    return db
      .query<Row, (string | number | bigint)[]>(query.replace("%order%", order))
      .all(
        filter.id ?? 0,
        filter.campaignId ?? 0,
        filter.subscriberId ?? 0,
        filter.source ?? "",
        filter.type ?? "",
        filter.offset,
        filter.limit < 1 ? -1 : filter.limit,
      );
  };
  /**
   * Who a bounce names, or null when nobody is left to link. A send that resolves is the answer
   * and matching stops there: an anonymized send names nobody, and an unlinked one no subscriber,
   * whoever holds its address now. An event that disagrees with the delivery is someone else's
   * (a copy, an address since changed): it is noted for no subscriber or send, because a row
   * linked to the send reads as that delivery's bounce, with its address.
   */
  const identify = (event: BounceEvent) => {
    const owner = deps.subscribers();
    const addressed = (email: string) =>
      !event.recipient || sanitizeEmail(email) === event.recipient;
    const send = event.sendUuid ? deps.sendTarget(event.sendUuid) : null;
    if (send) {
      if (!send.to_email) return null;
      const subscriber = send.subscriber_id === null ? null : owner.get(send.subscriber_id);
      const claimed =
        !subscriber || !event.subscriberUuid || subscriber.uuid === event.subscriberUuid;
      if (addressed(send.to_email) && claimed) return { subscriber, send, meta: event.meta };
      const meta = { ...(JSON.parse(event.bareMeta) as object), send_uuid: send.uuid };
      return { subscriber: null, send: null, meta: JSON.stringify(meta) };
    }
    const subscriber = event.subscriberUuid
      ? owner.byUuid(event.subscriberUuid)
      : event.email
        ? owner.byEmail(event.email)
        : null;
    if (!subscriber) return null;
    return addressed(subscriber.email)
      ? { subscriber, send: null, meta: event.meta }
      : { subscriber: null, send: null, meta: event.bareMeta };
  };
  /** Bounce actions at the count (record-bounce's block1, block2 and final delete). */
  const act = (subscriber: { id: bigint; status: string }, action: string) => {
    const owner = deps.subscribers();
    if (action === "delete") owner.remove([subscriber.id]);
    else if (subscriber.status === "blocklisted") return;
    else if (action === "blocklist") owner.bounceBlocklist(subscriber.id);
    else if (action === "unsubscribe") owner.bounceUnsubscribe(subscriber.id);
  };
  return {
    query(filter: BounceFilter) {
      const found = rows(filter);
      return { results: found.map(project), total: Number(found[0]?.total ?? 0) };
    },
    get(id: bigint | number) {
      const [row] = rows({ id, offset: 0, limit: 1 });
      return row ? project(row) : null;
    },
    /**
     * record-bounce, inside the caller's write transaction. Rows stop at the count and for a
     * blocklisted subscriber, but the action still applies past the count. A malformed campaign
     * UUID drops the event, as upstream's failed cast does.
     */
    record(event: BounceEvent) {
      const action = deps.actions()[event.type];
      if (!action || (event.campaignUuid && !reUUID.test(event.campaignUuid))) return;
      const named = identify(event);
      if (!named) return;
      const { subscriber, send, meta } = named;
      const campaignId = event.campaignUuid ? deps.campaignID(event.campaignUuid) : null;
      const num = subscriber
        ? Number((q.get("bounce-count").get(subscriber.id, event.type) as { n: bigint }).n) + 1
        : 1;
      if (subscriber?.status !== "blocklisted" && (!subscriber || num <= action.count)) {
        const inserted = q
          .get("bounce-insert")
          .get(
            subscriber?.id ?? null,
            campaignId,
            send?.id ?? null,
            event.type,
            event.source,
            meta,
            event.createdAt,
          ) as { id: bigint };
        if (subscriber || send)
          deps.recorded({
            id: inserted.id,
            type: event.type,
            source: event.source,
            subscriber_id: subscriber?.id ?? null,
            campaign_uuid: campaignId === null ? null : event.campaignUuid,
            send,
          });
      }
      if (subscriber && num >= action.count) act(subscriber, action.action);
    },
    /**
     * Note a provider delivery inside the caller's write transaction, so a rollback forgets it.
     * False when it was already noted.
     */
    receive(key: string, expiresAt: Date) {
      q.get("receipts-expire").run(clock.now().toISOString());
      return q.get("receipt-insert").run(key, expiresAt.toISOString()).changes === 1;
    },
    deleteIDs(ids: (bigint | number)[]) {
      q.get("bounces-delete-ids").run(json(ids));
    },
    deleteFiltered(campaignId: number, source: string, type: string) {
      q.get("bounces-delete-filtered").run(campaignId, source, type);
    },
    deleteBySubscriber(id: bigint | number) {
      q.get("bounces-delete-subscriber").run(id);
    },
    /** D25: bounces of sends about to be anonymized, whose provider text names the person. */
    deleteForSends(ids: bigint[]) {
      if (ids.length) q.get("bounces-delete-sends").run(json(ids));
    },
    /** blocklist-bounced-subscribers, through the subscribers' owner. The caller holds the write. */
    blocklist(ids: (bigint | number)[], campaignId: number, source: string, type: string) {
      const selected = (
        ids.length
          ? q.get("bounced-subscribers-ids").all(json(ids))
          : q.get("bounced-subscribers-filtered").all(campaignId, source, type)
      ) as { subscriber_id: bigint }[];
      if (selected.length) deps.subscribers().blocklist(selected.map((row) => row.subscriber_id));
    },
    /** The subscriber's own export. */
    forExport(id: bigint, limit: number) {
      const found = q.get("bounces-export").all(id, limit) as { meta: string }[];
      return found.map((row) => ({ ...row, meta: JSON.parse(row.meta) as unknown }));
    },
    close: () => q.close(),
  };
}
export type BounceStore = ReturnType<typeof createBounceStore>;
