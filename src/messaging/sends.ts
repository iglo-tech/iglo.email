// Native send journal. listmonk has no equivalent outbox or send-log API.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { writeTransaction } from "@/db/transaction";
import type { Message, Outcome } from "@/messaging/email";
import { decodePayload, encodePayload } from "@/messaging/payload";
import type { SubscriberStore } from "@/subscribers/store";
import { sanitizeEmail } from "@/subscribers/email";
import { simpleLower } from "@/subscribers/unicode-lower";
import { trimSpace } from "@/lists/store";
import { parseAddress } from "@/settings/mail";
import { HttpError } from "@/server/response";
import { createHash } from "node:crypto";
import type { EndedSend } from "@/webhooks/effects";

export type SendSource = "tx" | "sequence";
export type SendKind = "transactional" | "marketing";
export interface PreparedSend {
  source: SendSource;
  kind: SendKind;
  message: Message;
  subscriberId?: bigint | null;
  templateId?: bigint | null;
  enrollmentId?: bigint | null;
  stepId?: bigint | null;
  listId?: bigint | null;
  idempotencyKey?: string | null;
  /** Send UUID chosen by the producer, so rendered unsubscribe and tracking URLs can carry it. */
  uuid?: string;
}
/**
 * Marketing consent and frequency-cap policy (M2.4, src/unsubscribe/policy.ts).
 * The journal applies it at enqueue, outbox admission and manual resend, and counts
 * its own earlier marketing rows for the cap.
 */
export interface MarketingPolicy {
  /** A safe skip reason when the subscriber has no marketing consent for the list, else null. */
  consent(row: { subscriberId: bigint | null; listId: bigint | null }): string | null;
  /** Start of the cap window ending at `now`, or null when the cap is disabled. */
  capStart(now: Date): Date | null;
  /**
   * The subscriber's latest campaign delivery the cap counts (M3.2), or null. An
   * outstanding one (claimed, outcome pending) holds the cap whatever its age.
   */
  lastCampaignDelivery?(subscriberId: bigint): { at: Date; outstanding: boolean } | null;
}
interface PublicRow {
  id: bigint;
  uuid: string;
  source: SendSource;
  kind: SendKind;
  subscriber_id: bigint | null;
  to_email: string;
  template_id: bigint | null;
  enrollment_id: bigint | null;
  step_id: bigint | null;
  list_id: bigint | null;
  status: string;
  skip_reason: string | null;
  smtp_message_id: string;
  error: string | null;
  attempts: bigint;
  retry_of: bigint | null;
  next_attempt_at: string | null;
  created_at: string;
  sent_at: string | null;
}
/** One recipient of a producer request; the journal decides queued or skipped. */
export interface RequestedSend {
  send: PreparedSend;
  /** Captured with the prepared payload; a different current subscriber aborts the request. */
  subscriberUuid: string | null;
}
export interface SendSummary {
  id: number | object;
  uuid: string;
  status: string;
  smtp_message_id: string;
}
interface Row extends PublicRow {
  payload: string | null;
}
/** A claimed row and its admitted message; null when admission already settled the row. */
export interface Claimed {
  row: Row;
  message: Message | null;
}
const publicColumns = `id, uuid, source, kind, subscriber_id, to_email, template_id,
  enrollment_id, step_id, list_id, status, skip_reason, smtp_message_id, error,
  attempts, retry_of, next_attempt_at, created_at, sent_at`;
export interface SendFilter {
  page: number;
  perPage: number;
  status?: string;
  kind?: string;
  source?: string;
  subscriberId?: bigint;
  listId?: bigint;
}
const jsonID = (v: bigint | null) =>
  v === null
    ? null
    : v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : (JSON as typeof JSON & { rawJSON(value: string): object }).rawJSON(v.toString());
function project(row: PublicRow) {
  return {
    id: jsonID(row.id),
    uuid: row.uuid,
    source: row.source,
    kind: row.kind,
    subscriber_id: jsonID(row.subscriber_id),
    to_email: row.to_email,
    template_id: jsonID(row.template_id),
    enrollment_id: jsonID(row.enrollment_id),
    step_id: jsonID(row.step_id),
    list_id: jsonID(row.list_id),
    status: row.status,
    skip_reason: row.skip_reason,
    smtp_message_id: row.smtp_message_id,
    error: row.error,
    attempts: Number(row.attempts),
    retry_of: jsonID(row.retry_of),
    next_attempt_at: row.next_attempt_at,
    created_at: row.created_at,
    sent_at: row.sent_at,
  };
}
/** Current blocklist status of whoever owns this normalized address. */
export function addressBlocklisted(subscribers: SubscriberStore, email: string) {
  return (
    subscribers.byEmail(sanitizeEmail(email) ?? simpleLower(trimSpace(email)))?.status ===
    "blocklisted"
  );
}
/** The send a bounce identifies. */
export type BounceTarget = Pick<
  PublicRow,
  "id" | "uuid" | "source" | "kind" | "subscriber_id" | "list_id" | "to_email"
>;
export function createSends(options: {
  db: Database;
  clock: Clock;
  subscribers: SubscriberStore;
  rootUrl: () => string;
  marketingPolicy?: MarketingPolicy;
  /** A send became `failed` or `unknown`, inside that write's transaction. */
  ended?: (send: EndedSend) => void;
}) {
  const { db, clock, subscribers } = options;
  const ended = (row: Row, status: string, error: string, changes: number) => {
    if (changes) options.ended?.({ ...row, status, error });
  };
  let wake = () => {};
  const get = (id: bigint) => db.query<Row, [bigint]>("SELECT * FROM sends WHERE id = ?").get(id);
  const getPublic = (id: bigint) =>
    db.query<PublicRow, [bigint]>(`SELECT ${publicColumns} FROM sends WHERE id = ?`).get(id);
  const byChild = (id: bigint) =>
    db.query<PublicRow, [bigint]>(`SELECT ${publicColumns} FROM sends WHERE retry_of = ?`).get(id);
  const now = () => clock.now().toISOString();
  const messageId = (uuid: string) => {
    let host = "localhost";
    try {
      host = new URL(options.rootUrl()).hostname || host;
    } catch {
      /* fallback */
    }
    return `<${uuid}@${host}>`;
  };
  const blocklisted = (email: string) => addressBlocklisted(subscribers, email);
  /**
   * Drop blocklisted Cc/Bcc mailboxes. The emailer derives extra envelope recipients
   * from these headers by splitting on commas, so filtering the same parts here covers
   * every effective recipient. Unparseable parts are kept for the emailer to reject.
   */
  function withoutBlockedCopies(message: Message): { message: Message; removed: number } {
    if (!message.headers) return { message, removed: 0 };
    let removed = 0;
    const keep = (value: string) =>
      value
        .split(",")
        .filter((part) => {
          const address = parseAddress(trimSpace(part));
          if (address === undefined || !blocklisted(address)) return true;
          removed++;
          return false;
        })
        .join(",");
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(message.headers)) {
      const lower = name.toLowerCase();
      headers[name] =
        lower !== "cc" && lower !== "bcc"
          ? value
          : Array.isArray(value)
            ? value.map(keep)
            : keep(value);
    }
    return removed ? { message: { ...message, headers }, removed } : { message, removed };
  }
  function eligibility(row: Row, subscriberUuid: string | null): string | null {
    if (subscriberUuid !== null) {
      if (row.subscriber_id === null) return "subscriber_unavailable";
      const subscriber = subscribers.get(row.subscriber_id);
      if (!subscriber || subscriber.uuid !== subscriberUuid || subscriber.email !== row.to_email)
        return "subscriber_unavailable";
      if (subscriber.status === "blocklisted") return "subscriber_blocklisted";
    } else if (row.subscriber_id !== null) return "subscriber_unavailable";
    // Unlinked rows (external mode, unknown-at-enqueue addresses) are rechecked by address.
    if (blocklisted(row.to_email)) return "subscriber_blocklisted";
    if (row.kind === "marketing")
      return marketing(row.subscriber_id, row.list_id, { lineage: row.id, pending: false });
    return null;
  }
  function claimOne(time: Date, lease: Date): Row | null {
    const row = db
      .query<Row, [string]>(
        // The lowest queued id that is new or due for retry. Each half reads idx_sends_due
        // (status, next_attempt_at, id), so new rows are not sorted per claim.
        `SELECT * FROM sends WHERE id = (SELECT min(id) FROM (
           SELECT min(id) AS id FROM sends WHERE status='queued' AND next_attempt_at IS NULL
           UNION ALL
           SELECT min(id) FROM sends WHERE status='queued' AND next_attempt_at <= ?))`,
      )
      .get(time.toISOString());
    if (!row) return null;
    db.run(
      "UPDATE sends SET status='sending', attempts=attempts+1, attempted_at=?, claimed_until=?, next_attempt_at=NULL WHERE id=?",
      [time.toISOString(), lease.toISOString(), row.id],
    );
    return get(row.id)!;
  }
  /**
   * Decode and recheck a claimed row. A row that cannot be sent is settled here; a sendable
   * row records only its dropped copy count. Callers in the claim transaction commit these
   * writes with the claim.
   */
  function admit(row: Row): Message | null {
    let payload: ReturnType<typeof decodePayload>;
    try {
      if (!row.payload) throw new Error();
      payload = decodePayload(row.payload);
    } catch {
      const { changes } = db.run(
        "UPDATE sends SET status='failed', error='payload_unavailable', claimed_until=NULL WHERE id=? AND status='sending'",
        [row.id],
      );
      ended(row, "failed", "payload_unavailable", changes);
      return null;
    }
    const reason = eligibility(row, payload.subscriberUuid);
    if (reason) {
      db.run(
        "UPDATE sends SET status='skipped', skip_reason=?, claimed_until=NULL WHERE id=? AND status='sending'",
        [reason, row.id],
      );
      return null;
    }
    // A delivered row records only how many copy recipients were dropped.
    const { message, removed } = withoutBlockedCopies(payload.message);
    db.run("UPDATE sends SET skip_reason=? WHERE id=? AND status='sending'", [
      removed ? `copies_blocklisted:${removed}` : null,
      row.id,
    ]);
    return { ...message, messageId: row.smtp_message_id };
  }
  function finish(row: Row, outcome: Outcome) {
    const at = now();
    if (outcome.status === "accepted")
      db.run(
        "UPDATE sends SET status='sent', sent_at=?, error=?, claimed_until=NULL WHERE id=? AND status='sending'",
        [at, outcome.rejected.length ? "partial_acceptance" : null, row.id],
      );
    else if (outcome.status === "ambiguous") {
      const { changes } = db.run(
        "UPDATE sends SET status='unknown', error='uncertain', claimed_until=NULL WHERE id=? AND status='sending'",
        [row.id],
      );
      ended(row, "unknown", "uncertain", changes);
    } else if (row.kind === "transactional" && outcome.retry === "transient" && row.attempts < 5n) {
      const delay = 1000 * 2 ** (Number(row.attempts) - 1);
      db.run(
        "UPDATE sends SET status='queued', error='temporary_rejection', next_attempt_at=?, claimed_until=NULL WHERE id=? AND status='sending'",
        [new Date(clock.now().getTime() + delay).toISOString(), row.id],
      );
    } else {
      const error = outcome.retry === "transient" ? "temporary_rejection" : "not_accepted";
      const { changes } = db.run(
        "UPDATE sends SET status='failed', error=?, claimed_until=NULL WHERE id=? AND status='sending'",
        [error, row.id],
      );
      ended(row, "failed", error, changes);
    }
  }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  /**
   * Marketing admission: consent, then the frequency cap over this journal's earlier
   * marketing rows to the subscriber. Callers hold the write transaction (or, in the
   * outbox, the single synchronous connection), so concurrent requests cannot both pass.
   * `lineage` excludes a row and its retry_of ancestors (one intended message).
   * `pending` also counts queued rows, which reserve the cap at enqueue; at dispatch
   * only rows already sending or sent count, so two queued rows cannot skip each other.
   * An `unknown` row counts from its latest attempt (`attempted_at`, committed with the
   * claim before SMTP), so a delayed send recovered after a crash still uses the cap.
   * Campaign deliveries count too, from the policy (M3.2); an outstanding campaign claim
   * counts at any age, as a `sending` row does.
   */
  function marketing(
    subscriberId: bigint | null,
    listId: bigint | null,
    scope: { lineage: bigint | null; pending: boolean },
  ): string | null {
    const policy = options.marketingPolicy;
    if (!policy) return "policy_unavailable";
    const reason = policy.consent({ subscriberId, listId });
    if (reason) return reason;
    const start = policy.capStart(clock.now());
    if (start === null || subscriberId === null) return null;
    const hit = db
      .query<{ id: bigint }, [bigint, bigint, string, number]>(
        `WITH RECURSIVE chain(id, parent) AS (
           SELECT id, retry_of FROM sends WHERE id = ?1
           UNION ALL SELECT s.id, s.retry_of FROM sends s JOIN chain c ON s.id = c.parent
         )
         -- One branch per status, so each seeks idx_sends_cap instead of scanning the history.
         SELECT id FROM sends WHERE subscriber_id = ?2 AND kind = 'marketing' AND status = 'sending'
           AND id NOT IN (SELECT id FROM chain)
         UNION ALL
         SELECT id FROM sends WHERE ?4 AND subscriber_id = ?2 AND kind = 'marketing' AND status = 'queued'
           AND id NOT IN (SELECT id FROM chain)
         UNION ALL
         SELECT id FROM sends WHERE subscriber_id = ?2 AND kind = 'marketing' AND status IN ('sent', 'unknown')
           AND coalesce(sent_at, attempted_at, created_at) > ?3 AND id NOT IN (SELECT id FROM chain)
         LIMIT 1`,
      )
      .get(scope.lineage ?? 0n, subscriberId, start.toISOString(), scope.pending ? 1 : 0);
    if (hit) return "frequency_cap";
    const campaign = policy.lastCampaignDelivery?.(subscriberId);
    return campaign && (campaign.outstanding || campaign.at.getTime() > start.getTime())
      ? "frequency_cap"
      : null;
  }
  function enqueue(input: PreparedSend) {
    if (
      !input ||
      !["tx", "sequence"].includes(input.source) ||
      !["transactional", "marketing"].includes(input.kind)
    )
      throw new Error("Invalid prepared send");
    const subscriber = input.subscriberId == null ? null : subscribers.get(input.subscriberId);
    if (input.subscriberId != null && (!subscriber || subscriber.email !== input.message.to[0]))
      throw new Error("Invalid prepared send");
    const payload = encodePayload(input.message, subscriber?.uuid ?? null);
    const uuid = crypto.randomUUID();
    const id = writeTransaction(db, () => {
      const row = db
        .query<{ id: bigint }, any[]>(
          `INSERT INTO sends(uuid, source, kind, subscriber_id, to_email, template_id, enrollment_id, step_id, list_id, idempotency_key, status, smtp_message_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?) RETURNING id`,
        )
        .get(
          uuid,
          input.source,
          input.kind,
          input.subscriberId ?? null,
          input.message.to[0]!,
          input.templateId ?? null,
          input.enrollmentId ?? null,
          input.stepId ?? null,
          input.listId ?? null,
          input.idempotencyKey ?? null,
          messageId(uuid),
          payload,
          now(),
        );
      return row!.id;
    });
    wake();
    return project(getPublic(id)!);
  }
  function resend(id: bigint, authorize: () => void) {
    const result = writeTransaction(db, () => {
      authorize();
      const original = get(id);
      if (!original) throw new HttpError(404);
      const child = byChild(id);
      if (child) return project(child);
      if (!["failed", "unknown"].includes(original.status) || !original.payload)
        throw new HttpError(409);
      let payload: ReturnType<typeof decodePayload>;
      try {
        payload = decodePayload(original.payload);
      } catch {
        throw new HttpError(409);
      }
      if (eligibility(original, payload.subscriberUuid)) throw new HttpError(409);
      const uuid = crypto.randomUUID();
      const inserted = db
        .query<{ id: bigint }, any[]>(
          `INSERT INTO sends(uuid, source, kind, subscriber_id, to_email, template_id, list_id, status, smtp_message_id, payload, retry_of, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          uuid,
          original.source,
          original.kind,
          original.subscriber_id,
          original.to_email,
          original.template_id,
          original.list_id,
          messageId(uuid),
          original.payload,
          original.id,
          now(),
        );
      return project(getPublic(inserted!.id)!);
    });
    wake();
    return result;
  }
  const summary = (row: PublicRow): SendSummary => ({
    id: jsonID(row.id)!,
    uuid: row.uuid,
    status: row.status,
    smtp_message_id: row.smtp_message_id,
  });
  // Idempotency rows store `tx:<sha256(key)>:<fingerprint>:<index>` in the existing
  // unique column, so one request with several recipients keeps one key and the
  // request fingerprint without a schema change. The raw key is never stored.
  const keyPrefix = (key: string) => `tx:${createHash("sha256").update(key).digest("hex")}:`;
  function replay(prefix: string, fingerprint: string): PublicRow[] | null {
    const rows = db
      .query<PublicRow & { idempotency_key: string }, [string, string]>(
        `SELECT ${publicColumns}, idempotency_key FROM sends WHERE idempotency_key >= ? AND idempotency_key < ?`,
      )
      .all(prefix, `${prefix.slice(0, -1)};`);
    if (!rows.length) return null;
    const indexed = rows.map((row) => {
      const rest = row.idempotency_key.slice(prefix.length);
      const at = rest.lastIndexOf(":");
      return { row, fingerprint: rest.slice(0, at), index: Number(rest.slice(at + 1)) };
    });
    if (indexed.some((item) => item.fingerprint !== fingerprint))
      throw new HttpError(409, "Idempotency key was already used with a different request.");
    return indexed.sort((a, b) => a.index - b.index).map((item) => item.row);
  }
  /**
   * Journal every recipient of one producer request atomically. Linked identities and
   * blocklist status are rechecked in the write; blocklisted addresses and marketing
   * without an injected policy are skipped and never queued. A repeated idempotency
   * key returns the first rows and inserts nothing.
   */
  function enqueueRequest(input: {
    sends: RequestedSend[];
    idempotency?: { key: string; fingerprint: string } | null;
    authorize?: () => void;
  }): { replayed: boolean; ids: bigint[]; sends: SendSummary[]; queued: bigint[] } {
    if (!Array.isArray(input.sends) || !input.sends.length || input.sends.length > 1000)
      throw new Error("Invalid prepared send");
    const fingerprint = input.idempotency?.fingerprint;
    if (
      input.idempotency &&
      (typeof input.idempotency.key !== "string" ||
        !input.idempotency.key ||
        typeof fingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(fingerprint))
    )
      throw new Error("Invalid prepared send");
    const prepared = input.sends.map(({ send, subscriberUuid }) => {
      if (
        !send ||
        !["tx", "sequence"].includes(send.source) ||
        !["transactional", "marketing"].includes(send.kind)
      )
        throw new Error("Invalid prepared send");
      if ((send.subscriberId == null) !== (subscriberUuid === null))
        throw new Error("Invalid prepared send");
      if (
        send.uuid !== undefined &&
        (typeof send.uuid !== "string" || !uuidPattern.test(send.uuid))
      )
        throw new Error("Invalid prepared send");
      return { send, subscriberUuid, payload: encodePayload(send.message, subscriberUuid) };
    });
    const result = writeTransaction(db, () => {
      input.authorize?.();
      const prefix = input.idempotency ? keyPrefix(input.idempotency.key) : null;
      if (prefix) {
        const previous = replay(prefix, fingerprint!);
        if (previous)
          return {
            replayed: true,
            ids: previous.map((row) => row.id),
            sends: previous.map(summary),
            queued: [],
          };
      }
      const rows: PublicRow[] = [];
      const queued: bigint[] = [];
      prepared.forEach(({ send, subscriberUuid, payload }, index) => {
        const to = send.message.to[0]!;
        let skip: string | null = null;
        if (send.subscriberId != null) {
          const current = subscribers.get(send.subscriberId);
          if (!current || current.uuid !== subscriberUuid || current.email !== to)
            throw new HttpError(409, "Subscriber changed. Retry the request.");
          if (current.status === "blocklisted") skip = "subscriber_blocklisted";
        } else if (blocklisted(to)) skip = "subscriber_blocklisted";
        if (!skip && send.kind === "marketing")
          skip = marketing(send.subscriberId ?? null, send.listId ?? null, {
            lineage: null,
            pending: true,
          });
        const uuid = send.uuid ?? crypto.randomUUID();
        const row = db
          .query<{ id: bigint }, any[]>(
            `INSERT INTO sends(uuid, source, kind, subscriber_id, to_email, template_id, enrollment_id, step_id, list_id, idempotency_key, status, skip_reason, smtp_message_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          )
          .get(
            uuid,
            send.source,
            send.kind,
            send.subscriberId ?? null,
            to,
            send.templateId ?? null,
            send.enrollmentId ?? null,
            send.stepId ?? null,
            send.listId ?? null,
            prefix ? `${prefix}${fingerprint}:${index}` : null,
            skip ? "skipped" : "queued",
            skip,
            messageId(uuid),
            skip ? null : payload,
            now(),
          )!;
        if (!skip) queued.push(row.id);
        rows.push(getPublic(row.id)!);
      });
      return { replayed: false, ids: rows.map((row) => row.id), sends: rows.map(summary), queued };
    });
    if (result.queued.length) wake();
    return result;
  }
  /**
   * Return an existing idempotent request's rows, or null when the key is unused.
   * Lets a producer replay before consulting mutable templates or subscribers;
   * enqueueRequest repeats the lookup atomically for concurrent first requests.
   */
  function replayRequest(input: {
    idempotency: { key: string; fingerprint: string };
    authorize?: () => void;
  }): { ids: bigint[]; sends: SendSummary[] } | null {
    return writeTransaction(db, () => {
      input.authorize?.();
      const previous = replay(keyPrefix(input.idempotency.key), input.idempotency.fingerprint);
      return previous ? { ids: previous.map((row) => row.id), sends: previous.map(summary) } : null;
    });
  }
  /**
   * Earliest instant at which the frequency cap admits another marketing send to the
   * subscriber, from the latest row the cap counts (a queued or sending row counts from its
   * creation or attempt, so the answer is a lower bound until it is sent). At least `floor`.
   */
  function capFreeAt(subscriberId: bigint, floor: Date): Date {
    const policy = options.marketingPolicy;
    const latest = db
      .query<{ at: string | null }, [bigint]>(
        // The latest time per status is the end of its idx_sends_cap range.
        `SELECT max(at) AS at FROM (
           SELECT (SELECT max(coalesce(sent_at, attempted_at, created_at)) FROM sends
             WHERE subscriber_id = ?1 AND kind = 'marketing' AND status = 'queued') AS at
           UNION ALL SELECT (SELECT max(coalesce(sent_at, attempted_at, created_at)) FROM sends
             WHERE subscriber_id = ?1 AND kind = 'marketing' AND status = 'sending')
           UNION ALL SELECT (SELECT max(coalesce(sent_at, attempted_at, created_at)) FROM sends
             WHERE subscriber_id = ?1 AND kind = 'marketing' AND status = 'sent')
           UNION ALL SELECT (SELECT max(coalesce(sent_at, attempted_at, created_at)) FROM sends
             WHERE subscriber_id = ?1 AND kind = 'marketing' AND status = 'unknown'))`,
      )
      .get(subscriberId)?.at;
    const journal = latest ? Date.parse(latest) : NaN;
    const campaign = policy?.lastCampaignDelivery?.(subscriberId)?.at.getTime() ?? NaN;
    const last = Number.isFinite(campaign)
      ? Number.isFinite(journal)
        ? Math.max(journal, campaign)
        : campaign
      : journal;
    if (!policy || !Number.isFinite(last)) return floor;
    // capStart is monotonic in its argument: find the first instant whose window starts at or
    // after the last counted send. A window is at most about 10,000 years plus a few days.
    const admits = (t: number) => {
      const start = policy.capStart(new Date(t));
      return start === null || start.getTime() >= last;
    };
    let low = Math.max(floor.getTime(), last);
    if (admits(low)) return new Date(low);
    let high = low + 86_400_000;
    while (!admits(high)) {
      if (high - low > 4e14) return new Date(high);
      high = low + (high - low) * 2;
    }
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (admits(mid)) high = mid;
      else low = mid;
    }
    return new Date(high);
  }
  /** Validated payload of a sequence send, encoded before its write transaction. */
  type PreparedSequenceSend = { send: PreparedSend; subscriberUuid: string; payload: string };
  /**
   * Insert a sequence step's send, keyed by the unique `(enrollment_id, step_id)`: a queued
   * prepared message, or a skipped record with a safe reason and no payload. The caller
   * holds the write transaction (with the enrollment's advance) and has checked
   * `sequenceAdmission` for a queued send. Call `notify` after the commit.
   */
  function recordSequence(
    input:
      | { prepared: PreparedSequenceSend }
      | {
          skip: string;
          kind: SendKind;
          subscriberId: bigint;
          toEmail: string;
          templateId: bigint | null;
          enrollmentId: bigint;
          stepId: bigint;
          listId: bigint | null;
        },
  ): bigint {
    if (!db.inTransaction)
      throw new Error("Sequence sends are written in the caller's transaction");
    const row =
      "prepared" in input
        ? {
            uuid: input.prepared.send.uuid ?? crypto.randomUUID(),
            kind: input.prepared.send.kind,
            subscriberId: input.prepared.send.subscriberId ?? null,
            to: input.prepared.send.message.to[0]!,
            templateId: input.prepared.send.templateId ?? null,
            enrollmentId: input.prepared.send.enrollmentId ?? null,
            stepId: input.prepared.send.stepId ?? null,
            listId: input.prepared.send.listId ?? null,
            status: "queued",
            skip: null,
            payload: input.prepared.payload,
          }
        : {
            uuid: crypto.randomUUID(),
            kind: input.kind,
            subscriberId: input.subscriberId,
            to: input.toEmail,
            templateId: input.templateId,
            enrollmentId: input.enrollmentId,
            stepId: input.stepId,
            listId: input.listId,
            status: "skipped",
            skip: input.skip,
            payload: null,
          };
    if (row.enrollmentId === null || row.stepId === null) throw new Error("Invalid prepared send");
    return db
      .query<{ id: bigint }, any[]>(
        `INSERT INTO sends(uuid, source, kind, subscriber_id, to_email, template_id, enrollment_id, step_id, list_id, status, skip_reason, smtp_message_id, payload, created_at) VALUES (?, 'sequence', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        row.uuid,
        row.kind,
        row.subscriberId,
        row.to,
        row.templateId,
        row.enrollmentId,
        row.stepId,
        row.listId,
        row.status,
        row.skip,
        messageId(row.uuid),
        row.payload,
        now(),
      )!.id;
  }
  return {
    enqueue,
    enqueueRequest,
    replayRequest,
    /** The send recorded for a sequence step of an enrollment, if any. */
    sequenceSend(enrollmentId: bigint, stepId: bigint) {
      return db
        .query<{ id: bigint; status: string }, [bigint, bigint]>(
          "SELECT id, status FROM sends WHERE enrollment_id = ? AND step_id = ?",
        )
        .get(enrollmentId, stepId);
    },
    /**
     * Marketing consent and frequency cap for a new marketing send, the same admission as
     * enqueue (queued rows reserve the cap): a consent skip reason, `frequency_cap`, or null.
     */
    marketingReason(subscriberId: bigint, listId: bigint | null): string | null {
      return marketing(subscriberId, listId, { lineage: null, pending: true });
    },
    capFreeAt,
    /**
     * Validate and encode a sequence send before its write transaction; throws for a
     * message the journal cannot store.
     */
    prepareSequence(send: PreparedSend, subscriberUuid: string): PreparedSequenceSend {
      if (
        send.source !== "sequence" ||
        !["transactional", "marketing"].includes(send.kind) ||
        send.subscriberId == null ||
        send.enrollmentId == null ||
        send.stepId == null ||
        (send.uuid !== undefined && !uuidPattern.test(send.uuid))
      )
        throw new Error("Invalid prepared send");
      return { send, subscriberUuid, payload: encodePayload(send.message, subscriberUuid) };
    },
    /**
     * Admission of a prepared sequence send inside the caller's write transaction, as
     * enqueueRequest checks a linked recipient: the same current subscriber and address,
     * not blocklisted, then marketing consent and the cap. A reason, or null to queue it.
     */
    sequenceAdmission(prepared: PreparedSequenceSend): string | null {
      const { send, subscriberUuid } = prepared;
      const current = subscribers.get(send.subscriberId!);
      if (!current || current.uuid !== subscriberUuid || current.email !== send.message.to[0])
        return "subscriber_unavailable";
      if (current.status === "blocklisted" || blocklisted(current.email))
        return "subscriber_blocklisted";
      if (send.kind === "marketing")
        return marketing(send.subscriberId!, send.listId ?? null, { lineage: null, pending: true });
      return null;
    },
    recordSequence,
    /** Wake the outbox after a committed sequence send. */
    notify() {
      wake();
    },
    summary(id: bigint) {
      const row = getPublic(id);
      return row ? summary(row) : null;
    },
    /**
     * Claim specific queued rows for an awaited producer dispatch and admit them, all in one
     * commit before any SMTP call. Rows already claimed by the loop are left to it.
     */
    claimQueued(ids: bigint[], time: Date, lease: Date): Claimed[] {
      return writeTransaction(db, () => {
        const claimed: Claimed[] = [];
        for (const id of ids) {
          const changed = db.run(
            "UPDATE sends SET status='sending', attempts=attempts+1, attempted_at=?3, claimed_until=?1, next_attempt_at=NULL WHERE id=?2 AND status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?3)",
            [lease.toISOString(), id, time.toISOString()],
          );
          if (!changed.changes) continue;
          const row = get(id)!;
          claimed.push({ row, message: admit(row) });
        }
        return claimed;
      });
    },
    resend,
    /** Public identity of a send for the unsubscribe and tracking pages. */
    byUuid(uuid: string) {
      return db
        .query<
          Pick<PublicRow, "id" | "uuid" | "kind" | "subscriber_id" | "list_id" | "status">,
          [string]
        >("SELECT id, uuid, kind, subscriber_id, list_id, status FROM sends WHERE uuid = ?")
        .get(uuid);
    },
    /** What a bounce of this send links to. `to_email` is empty once anonymized. */
    bounceTarget(uuid: string): BounceTarget | null {
      return db
        .query<BounceTarget, [string]>(
          "SELECT id, uuid, source, kind, subscriber_id, list_id, to_email FROM sends WHERE uuid = ?",
        )
        .get(uuid);
    },
    /**
     * Whether the prepared HTML or plain body of a send contains `text`. Tracked-link
     * redirects use it so only links rendered into that message can redirect.
     */
    bodyIncludes(id: bigint, text: string): boolean {
      const row = db
        .query<{ body: string | null; alt: string | null }, [bigint]>(
          "SELECT json_extract(payload, '$.message.body') AS body, json_extract(payload, '$.message.altBody') AS alt FROM sends WHERE id = ? AND json_valid(payload)",
        )
        .get(id);
      if (!row) return false;
      return [row.body, row.alt].some(
        (value) => typeof value === "string" && Buffer.from(value, "base64").includes(text),
      );
    },
    get(id: bigint) {
      const row = getPublic(id);
      return row ? project(row) : null;
    },
    list(filter: SendFilter) {
      const clauses: string[] = [],
        values: (string | bigint | number)[] = [];
      for (const [key, value] of [
        ["status", filter.status],
        ["kind", filter.kind],
        ["source", filter.source],
        ["subscriber_id", filter.subscriberId],
        ["list_id", filter.listId],
      ] as const)
        if (value !== undefined) {
          clauses.push(`${key} = ?`);
          values.push(value);
        }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const total = db
        .query<{ total: bigint }, any[]>(`SELECT count(*) AS total FROM sends${where}`)
        .get(...values)!.total;
      const rows = db
        .query<PublicRow, any[]>(
          `SELECT ${publicColumns} FROM sends${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
        )
        .all(...values, filter.perPage, (filter.page - 1) * filter.perPage);
      return {
        results: rows.map(project),
        total: jsonID(total),
        page: filter.page,
        per_page: filter.perPage,
      };
    },
    nextDue() {
      return (
        db
          .query<{ due: string | null }, []>(
            "SELECT min(next_attempt_at) AS due FROM sends WHERE status='queued' AND next_attempt_at IS NOT NULL",
          )
          .get()?.due ?? null
      );
    },
    recover() {
      writeTransaction(db, () => {
        const interrupted = db
          .query<Row, []>(
            "UPDATE sends SET status='unknown', error='interrupted', claimed_until=NULL, next_attempt_at=NULL WHERE status='sending' RETURNING *",
          )
          .all();
        for (const row of interrupted) ended(row, "unknown", "interrupted", 1);
      });
    },
    /** Claim the lowest due row inside the caller's write transaction. */
    claim(time: Date, lease: Date): Row[] {
      const row = claimOne(time, lease);
      return row ? [row] : [];
    },
    /**
     * Claim up to `limit` due rows in id order and admit each, inside the caller's write
     * transaction, so the claims and every admission outcome commit together before SMTP.
     * Each row is admitted right after its claim, so a later row in the batch sees an
     * earlier one as `sending` for the marketing cap, as it would one batch later.
     */
    claimBatch(time: Date, lease: Date, limit: number): Claimed[] {
      const claimed: Claimed[] = [];
      for (let i = 0; i < limit; i++) {
        const row = claimOne(time, lease);
        if (!row) break;
        claimed.push({ row, message: admit(row) });
      }
      return claimed;
    },
    admit,
    finish,
    /** Journal several SMTP outcomes in one commit. */
    finishAll(results: { row: Row; outcome: Outcome }[]) {
      if (!results.length) return;
      writeTransaction(db, () => {
        for (const { row, outcome } of results) finish(row, outcome);
      });
    },
    onWake(fn: () => void) {
      wake = fn;
    },
    close() {
      wake = () => {};
    },
  };
}
export type Sends = ReturnType<typeof createSends>;
