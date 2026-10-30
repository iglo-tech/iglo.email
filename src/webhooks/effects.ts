// Native: the state changes that queue outbound webhooks, called inside their own write
// transactions (docs/design/04-sending.md#outbound-webhooks).
import { HttpError } from "@/server/response";
import type { BulkAction, ImportSpend, SubscriberStore } from "@/subscribers/store";
import {
  webhookID,
  type WebhookEvent,
  type WebhookStore,
  type WebhookSubject,
} from "@/webhooks/store";

/**
 * Delivery rows one bulk action may queue. They share its synchronous transaction, so this
 * bounds how long it holds the event loop (docs/perf/M2.6-webhooks.md).
 */
export const MAX_BULK_DELIVERIES = 50_000;
const bulkEvents: Record<BulkAction, WebhookEvent[]> = {
  delete: ["subscriber.deleted"],
  blocklist: ["subscriber.blocklisted", "subscriber.unsubscribed"],
  unsubscribe: ["subscriber.unsubscribed"],
};

export interface EndedSend {
  uuid: string;
  source: string;
  kind: string;
  subscriber_id: bigint | null;
  list_id: bigint | null;
  status: string;
  error: string | null;
}
export interface RecordedBounce {
  id: bigint;
  type: string;
  source: string;
  subscriber_id: bigint | null;
  campaign_uuid: string | null;
  send: {
    uuid: string;
    source: string;
    kind: string;
    subscriber_id: bigint | null;
    list_id: bigint | null;
  } | null;
}
const subject = (row: {
  id: bigint;
  uuid: string;
  email: string;
  external_id: string | null;
}): WebhookSubject => ({
  id: webhookID(row.id),
  uuid: row.uuid,
  email: row.email,
  external_id: row.external_id,
});

/** `subscribers` is resolved late: the store takes these effects when it is created. */
export function createWebhookEffects(
  webhooks: WebhookStore,
  subscribers: () => Pick<
    SubscriberStore,
    "get" | "memberships" | "webhookBlocklisted" | "webhookDeleted" | "webhookUnsubscribed"
  >,
) {
  const listIDs = (id: bigint) =>
    subscribers()
      .memberships(id)
      .map((m) => webhookID(m.list_id));
  const unsubscribing = (ids: bigint[], listIds: bigint[] | null) =>
    webhooks.queueMany("subscriber.unsubscribed", () =>
      subscribers().webhookUnsubscribed(ids, listIds),
    );
  return {
    subscriberEffects: {
      /** Consent that really changed; a repeated request queues nothing. */
      changed(change: { id: bigint; blocklisted: boolean; listIds: bigint[] }) {
        const row = () => subscribers().get(change.id)!;
        if (change.listIds.length)
          webhooks.queueWebhook("subscriber.unsubscribed", () => ({
            subscriber: subject(row()),
            list_ids: change.listIds.map(webhookID),
          }));
        if (change.blocklisted)
          webhooks.queueWebhook("subscriber.blocklisted", () => ({
            subscriber: subject(row()),
            list_ids: listIDs(change.id),
          }));
      },
      /** Before the write, so its queries see what is about to change. */
      blocklisting(ids: bigint[]) {
        unsubscribing(ids, null);
        webhooks.queueMany("subscriber.blocklisted", () => subscribers().webhookBlocklisted(ids));
      },
      unsubscribing,
      /** Refuse a bulk action over the budget. `selected` runs only if a webhook wants it. */
      admitBulk(action: BulkAction, selected: () => number) {
        const perSubscriber = bulkEvents[action].reduce(
          (total, event) => total + webhooks.subscribed(event),
          0,
        );
        const deliveries = perSubscriber && selected() * perSubscriber;
        if (deliveries > MAX_BULK_DELIVERIES)
          throw new HttpError(
            400,
            `This action would queue ${deliveries.toLocaleString("en-US")} webhook deliveries, ` +
              `over the limit of ${MAX_BULK_DELIVERIES.toLocaleString("en-US")} per bulk action. ` +
              "Narrow the selection and try again.",
          );
      },
      /**
       * One batch of an import, with the budget of one bulk action across all its batches. The
       * webhooks of the batches before it are committed, so they stay and the import ends here.
       */
      admitImportBatch(spent: ImportSpend, batch: { unsubscribed: number; blocklisted: number }) {
        const deliveries =
          spent.deliveries +
          batch.unsubscribed * webhooks.subscribed("subscriber.unsubscribed") +
          batch.blocklisted * webhooks.subscribed("subscriber.blocklisted");
        if (deliveries > MAX_BULK_DELIVERIES)
          throw new HttpError(
            400,
            `This import would reach ${deliveries.toLocaleString("en-US")} webhook deliveries, ` +
              `over the limit of ${MAX_BULK_DELIVERIES.toLocaleString("en-US")} per bulk action. ` +
              "It stopped before this batch: earlier batches stay, with their webhooks.",
          );
        spent.deliveries = deliveries;
      },
    },
    /**
     * D25. Every stored delivery loses the address and external ID. `subscriber.deleted` never
     * carries the address. An administrative delete keeps the external ID until the delivery
     * ends, because that is the key a receiver matches, and the delivery's end clears it. A
     * subscriber's own wipe stores neither, since an external ID can hold personal data, and
     * no list IDs on any delivery, since a membership tied to the kept UUID is personal too.
     */
    deleting(deleted: { id: bigint }[], wipe = false) {
      const ids = deleted.map(({ id }) => id);
      if (!ids.length) return;
      webhooks.clearSubscribers(ids, wipe);
      webhooks.queueMany("subscriber.deleted", () => subscribers().webhookDeleted(ids, wipe));
    },
    /**
     * A bounce row was stored. Its provider text stays out of the payload, and so does the
     * address of a send to a non-subscriber; a later deletion clears this row like the others.
     * A bounce of an address the send's subscriber has left names no list: the row is stored
     * for no subscriber, so their wipe could not clear it.
     */
    bounceRecorded(bounce: RecordedBounce) {
      webhooks.queueWebhook("bounce.recorded", () => {
        const { id, type, source, subscriber_id, campaign_uuid, send } = bounce;
        const row = subscriber_id === null ? null : subscribers().get(subscriber_id);
        return {
          subscriber: row ? subject(row) : null,
          list_ids: row
            ? listIDs(row.id)
            : !send || send.list_id === null || send.subscriber_id !== null
              ? []
              : [webhookID(send.list_id)],
          bounce: { id: webhookID(id), type, source },
          ...(send ? { send: { uuid: send.uuid, source: send.source, kind: send.kind } } : {}),
          ...(campaign_uuid === null ? {} : { campaign: { uuid: campaign_uuid } }),
        };
      });
    },
    /** A send became `failed` or `unknown`. An unlinked address stays out of the payload. */
    sendEnded(send: EndedSend) {
      webhooks.queueWebhook("send.failed", () => {
        const id = send.subscriber_id;
        const row = id === null ? null : subscribers().get(id);
        return {
          subscriber: row ? subject(row) : null,
          list_ids: send.list_id === null ? [] : [webhookID(send.list_id)],
          send: {
            uuid: send.uuid,
            source: send.source,
            kind: send.kind,
            status: send.status,
            error: send.error,
          },
        };
      });
    },
  };
}
export type WebhookEffects = ReturnType<typeof createWebhookEffects>;
