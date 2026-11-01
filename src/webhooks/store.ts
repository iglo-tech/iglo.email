// Native outbound webhooks (docs/design/04-sending.md#outbound-webhooks); listmonk has no
// equivalent. This module owns `webhooks` and `webhook_deliveries`.
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import sql from "@/webhooks/store.sql" with { type: "text" };

export const webhookEvents = [
  "subscriber.unsubscribed",
  "subscriber.blocklisted",
  "subscriber.deleted",
  "bounce.recorded",
  "send.failed",
] as const;
export type WebhookEvent = (typeof webhookEvents)[number];
/** At most this many deliveries per event, and at most this many targets for the loop. */
export const MAX_WEBHOOKS = 20;
/** Retried for this long from first queueing, then `failed`. */
export const DELIVERY_WINDOW_MS = 86_400_000;
/** Finished deliveries stay this long after their last change (D70). */
export const DELIVERY_RETENTION_MS = 30 * 86_400_000;
const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 3_600_000;
/** Delivery rows of one disabled webhook advanced per claim. */
const HELD_BATCH = 100;

export interface WebhookSubject {
  id: number | object;
  uuid: string;
  email: string;
  external_id: string | null;
}
export interface WebhookData {
  /** Null for a send to an address that is not a subscriber. */
  subscriber: WebhookSubject | null;
  list_ids: (number | object)[];
  [key: string]: unknown;
}
interface Row {
  id: bigint;
  url: string;
  events: string;
  enabled: bigint;
  created_at: string;
  updated_at: string;
}
export interface WebhookTarget {
  id: bigint;
  url: string;
  secret: string;
}
interface DeliveryRow {
  id: bigint;
  uuid: string;
  webhook_id: bigint;
  event: string;
  status: string;
  attempts: bigint;
  next_attempt_at: string | null;
  last_error: string | null;
  claimed_until: string | null;
  created_at: string;
  updated_at: string;
}
export interface ClaimedDelivery {
  id: bigint;
  uuid: string;
  event: string;
  attempts: bigint;
  created_at: string;
  claimed_until: string;
  target: WebhookTarget;
}
export interface WebhookInput {
  url: string;
  events: string[];
  enabled: boolean;
}

const safeID = (id: bigint) =>
  id <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(id)
    : (JSON as typeof JSON & { rawJSON(value: string): object }).rawJSON(id.toString());
export const webhookID = safeID;
const project = (row: Row) => ({
  id: safeID(row.id),
  url: row.url,
  events: JSON.parse(row.events) as string[],
  enabled: row.enabled === 1n,
  created_at: row.created_at,
  updated_at: row.updated_at,
});
const projectDelivery = (row: DeliveryRow) => ({
  id: safeID(row.id),
  uuid: row.uuid,
  webhook_id: safeID(row.webhook_id),
  event: row.event,
  status: row.status,
  attempts: Number(row.attempts),
  next_attempt_at: row.next_attempt_at,
  last_error: row.last_error,
  claimed_until: row.claimed_until,
  created_at: row.created_at,
  updated_at: row.updated_at,
});
const page = (rows: unknown[], total: bigint, page: number, perPage: number) => ({
  results: rows,
  total: Number(total),
  per_page: perPage,
  page,
});
/** Generated secrets are 256 random bits. */
export const generateSecret = () => randomBytes(32).toString("hex");

export function createWebhookStore(db: Database, clock: Clock) {
  const q = prepareNamedQueries(db, [{ name: "webhooks/store", sql }]);
  const count = (name: string, ...args: bigint[]) => (q.get(name).get(...args) as { n: bigint }).n;
  const iso = () => clock.now().toISOString();
  /** The next attempt, clamped to the window's end; null when the window is over. */
  const nextAttempt = (delay: number, createdAt: string) => {
    const now = clock.now().getTime();
    const deadline = Date.parse(createdAt) + DELIVERY_WINDOW_MS;
    return now >= deadline ? null : new Date(Math.min(now + delay, deadline)).toISOString();
  };
  const retryDelay = (attempts: bigint) =>
    Math.min(FIRST_RETRY_MS * 2 ** Math.min(Number(attempts) - 1, 20), MAX_RETRY_MS);
  let wake = () => {};
  const subscribed = (event: WebhookEvent) => q.get("webhooks-for-event").all(event).length;
  return {
    list(pageNumber: number, perPage: number) {
      const rows = q.get("webhook-list").all(perPage, (pageNumber - 1) * perPage) as Row[];
      return page(rows.map(project), count("webhook-count"), pageNumber, perPage);
    },
    get(id: bigint) {
      const row = q.get("webhook-get").get(id) as Row | null;
      return row && project(row);
    },
    /** Inside the caller's write transaction. Null when the configured limit is reached. */
    create(input: WebhookInput, secret: string) {
      if (count("webhook-count") >= BigInt(MAX_WEBHOOKS)) return null;
      const now = iso();
      const row = q
        .get("webhook-insert")
        .get(
          input.url,
          secret,
          JSON.stringify(input.events),
          input.enabled ? 1 : 0,
          now,
          now,
        ) as Row;
      return { ...project(row), secret };
    },
    update(id: bigint, input: WebhookInput) {
      const row = q
        .get("webhook-update")
        .get(
          input.url,
          JSON.stringify(input.events),
          input.enabled ? 1 : 0,
          iso(),
          id,
        ) as Row | null;
      return row && project(row);
    },
    remove(id: bigint) {
      return q.get("webhook-delete").run(id).changes > 0;
    },
    deliveries(id: bigint, pageNumber: number, perPage: number) {
      const rows = q.get("delivery-list").all(id, perPage, (pageNumber - 1) * perPage);
      return page(
        (rows as DeliveryRow[]).map(projectDelivery),
        count("delivery-count", id),
        pageNumber,
        perPage,
      );
    },
    /**
     * Queue one delivery per enabled webhook subscribed to `event`, in the caller's write
     * transaction, so a rollback queues nothing and a commit loses nothing. `data` runs only
     * when a webhook wants the event. The row stores the exact body, sent unchanged by retries.
     */
    queueWebhook(event: WebhookEvent, data: () => WebhookData) {
      if (!db.inTransaction) throw new Error("Webhooks are queued in the caller's transaction");
      const hooks = q.get("webhooks-for-event").all(event) as { id: bigint }[];
      if (!hooks.length) return;
      const at = iso();
      const snapshot = data();
      const subscriber = snapshot.subscriber
        ? BigInt(JSON.stringify(snapshot.subscriber.id))
        : null;
      for (const hook of hooks) {
        const uuid = crypto.randomUUID();
        const body = JSON.stringify({ id: uuid, event, occurred_at: at, data: snapshot });
        q.get("delivery-insert").run(uuid, hook.id, event, body, subscriber, at, at, at);
      }
      // Writes are synchronous, so the woken loop runs only after this transaction ends.
      wake();
    },
    /**
     * `queueWebhook` for a batch of subscribers, in one statement: `data` returns a JSON array
     * of what `queueWebhook`'s callback returns, so no row passes through JavaScript.
     */
    queueMany(event: WebhookEvent, data: () => string) {
      if (!db.inTransaction) throw new Error("Webhooks are queued in the caller's transaction");
      if (!subscribed(event)) return;
      q.get("delivery-insert-many").run(event, data(), iso());
      wake();
    },
    /** Enabled webhooks subscribed to `event`. */
    subscribed,
    /**
     * D25: clear the address and external ID from every stored delivery of these subscribers,
     * whatever its status, and on a subscriber's own wipe their list IDs too. Pending rows stay
     * and go out cleared.
     */
    clearSubscribers(ids: bigint[], wipe = false) {
      if (!db.inTransaction) throw new Error("Deliveries are cleared in the caller's transaction");
      if (!ids.length) return;
      const selected = JSON.stringify(ids.map(String));
      q.get("delivery-clear-subscribers").run(iso(), selected);
      if (wipe) q.get("delivery-clear-memberships").run(selected);
    },
    /**
     * The body to send now, which a deletion may have cleared since the claim. Null when the
     * row no longer holds this claim, as when its webhook was deleted.
     */
    claimedPayload(delivery: ClaimedDelivery) {
      const row = q.get("delivery-claimed-payload").get(delivery.id, delivery.claimed_until) as {
        payload: string;
      } | null;
      return row?.payload ?? null;
    },
    /** One process owns the table: a lease that survived a restart is an abandoned attempt. */
    recover() {
      q.get("delivery-recover").run(iso());
    },
    /**
     * Claim due rows of each webhook up to its free slots, in the loop's claim transaction.
     * A disabled webhook sends nothing: its due rows follow the retry schedule without a
     * request, so enabling it resumes them and the delivery window still ends them.
     */
    claim(lease: Date, now: Date, free: (webhook: bigint) => number) {
      const until = lease.toISOString(),
        at = now.toISOString(),
        claimed: ClaimedDelivery[] = [];
      for (const hook of q.get("webhook-targets").all() as (WebhookTarget & {
        enabled: bigint;
      })[]) {
        if (hook.enabled !== 1n) {
          const held = q.get("delivery-due").all(hook.id, at, HELD_BATCH) as {
            id: bigint;
            created_at: string;
          }[];
          for (const row of held) {
            const next = nextAttempt(MAX_RETRY_MS, row.created_at);
            if (next) q.get("delivery-postpone").run(next, "webhook_disabled", at, row.id);
            else q.get("delivery-end").run("failed", "webhook_disabled", at, row.id, null);
          }
          continue;
        }
        const slots = free(hook.id);
        if (slots < 1) continue;
        const rows = q.get("delivery-claim").all(until, hook.id, at, slots) as Omit<
          ClaimedDelivery,
          "target"
        >[];
        for (const row of rows)
          claimed.push({ ...row, target: { id: hook.id, url: hook.url, secret: hook.secret } });
      }
      return claimed;
    },
    /**
     * Record an attempt's outcome if the row still holds this claim. `error` null is delivered.
     * Returns the row's new status, or null when the claim is gone.
     */
    settle(
      delivery: ClaimedDelivery,
      error: string | null,
    ): "delivered" | "queued" | "failed" | null {
      const at = iso(),
        lease = delivery.claimed_until;
      if (error === null)
        return q.get("delivery-end").run("delivered", null, at, delivery.id, lease).changes
          ? "delivered"
          : null;
      const next = nextAttempt(retryDelay(delivery.attempts), delivery.created_at);
      if (next === null)
        return q.get("delivery-end").run("failed", error, at, delivery.id, lease).changes
          ? "failed"
          : null;
      return q.get("delivery-retry").run(next, error, at, delivery.id, lease).changes
        ? "queued"
        : null;
    },
    /** Delete up to `limit` finished deliveries past retention, oldest first. */
    purge(now: Date, limit: number) {
      const before = new Date(now.getTime() - DELIVERY_RETENTION_MS).toISOString();
      return q.get("delivery-purge").all(before, limit);
    },
    onWake(fn: () => void) {
      wake = fn;
    },
    close() {
      wake = () => {};
      q.close();
    },
  };
}
export type WebhookStore = ReturnType<typeof createWebhookStore>;
