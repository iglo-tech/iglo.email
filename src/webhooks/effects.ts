// Native: the state changes that queue outbound webhooks, called inside their own write
// transactions (docs/design/04-sending.md#outbound-webhooks).
import type { SubscriberStore } from "@/subscribers/store";
import { webhookID, type WebhookStore, type WebhookSubject } from "@/webhooks/store";

export interface EndedSend {
  uuid: string;
  source: string;
  kind: string;
  subscriber_id: bigint | null;
  list_id: bigint | null;
  status: string;
  error: string | null;
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
  subscribers: () => Pick<SubscriberStore, "get" | "memberships">,
) {
  const listIDs = (id: bigint) =>
    subscribers()
      .memberships(id)
      .map((m) => webhookID(m.list_id));
  return {
    /** Consent that really changed; a repeated request queues nothing. */
    consentChanged(change: { id: bigint; blocklisted: boolean; listIds: bigint[] }) {
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
    /**
     * D25. Every stored delivery loses the address and external ID. `subscriber.deleted` never
     * carries the address; it carries the external ID until the delivery ends, because that is
     * the key a receiver matches, and the delivery's end clears it too.
     */
    deleting(deleted: { id: bigint }[]) {
      webhooks.clearSubscribers(deleted.map(({ id }) => id));
      for (const { id } of deleted)
        webhooks.queueWebhook("subscriber.deleted", () => {
          const row = subscribers().get(id)!;
          return { subscriber: { ...subject(row), email: "" }, list_ids: listIDs(id) };
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
