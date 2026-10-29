// Native send journal. listmonk has no equivalent outbox or send-log API.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { writeTransaction } from "@/db/transaction";
import type { Message, Outcome } from "@/messaging/email";
import { decodePayload, encodePayload } from "@/messaging/payload";
import type { SubscriberStore } from "@/subscribers/store";
import { HttpError } from "@/server/response";

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
}
interface Row {
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
  payload: string | null;
}
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
function project(row: Row) {
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
export function createSends(options: {
  db: Database;
  clock: Clock;
  subscribers: SubscriberStore;
  rootUrl: () => string;
  marketingPolicy?: (row: { subscriberId: bigint | null; listId: bigint | null }) => boolean;
}) {
  const { db, clock, subscribers } = options;
  let wake = () => {};
  const get = (id: bigint) => db.query<Row, [bigint]>("SELECT * FROM sends WHERE id = ?").get(id);
  const byChild = (id: bigint) =>
    db.query<Row, [bigint]>("SELECT * FROM sends WHERE retry_of = ?").get(id);
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
  function eligibility(row: Row, subscriberUuid: string | null): string | null {
    if (subscriberUuid !== null) {
      if (row.subscriber_id === null) return "subscriber_unavailable";
      const subscriber = subscribers.get(row.subscriber_id);
      if (!subscriber || subscriber.uuid !== subscriberUuid || subscriber.email !== row.to_email)
        return "subscriber_unavailable";
      if (subscriber.status === "blocklisted") return "subscriber_blocklisted";
    } else if (row.subscriber_id !== null) return "subscriber_unavailable";
    if (
      row.kind === "marketing" &&
      (!options.marketingPolicy ||
        !options.marketingPolicy({ subscriberId: row.subscriber_id, listId: row.list_id }))
    )
      return "policy_unavailable";
    return null;
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
    return project(get(id)!);
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
      return project(get(inserted!.id)!);
    });
    wake();
    return result;
  }
  return {
    enqueue,
    resend,
    get(id: bigint) {
      const row = get(id);
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
        .query<Row, any[]>(`SELECT * FROM sends${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
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
      writeTransaction(db, () =>
        db.run(
          "UPDATE sends SET status='unknown', error='interrupted', claimed_until=NULL, next_attempt_at=NULL WHERE status='sending'",
        ),
      );
    },
    claim(time: Date, lease: Date): Row[] {
      const row = db
        .query<Row, [string]>(
          "SELECT * FROM sends WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT 1",
        )
        .get(time.toISOString());
      if (!row) return [];
      db.run(
        "UPDATE sends SET status='sending', attempts=attempts+1, claimed_until=?, next_attempt_at=NULL WHERE id=?",
        [lease.toISOString(), row.id],
      );
      return [get(row.id)!];
    },
    admit(row: Row): Message | null {
      let payload: ReturnType<typeof decodePayload>;
      try {
        if (!row.payload) throw new Error();
        payload = decodePayload(row.payload);
      } catch {
        db.run(
          "UPDATE sends SET status='failed', error='payload_unavailable', claimed_until=NULL WHERE id=? AND status='sending'",
          [row.id],
        );
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
      return { ...payload.message, messageId: row.smtp_message_id };
    },
    finish(row: Row, outcome: Outcome) {
      const at = now();
      if (outcome.status === "accepted")
        db.run(
          "UPDATE sends SET status='sent', sent_at=?, error=?, claimed_until=NULL WHERE id=? AND status='sending'",
          [at, outcome.rejected.length ? "partial_acceptance" : null, row.id],
        );
      else if (outcome.status === "ambiguous")
        db.run(
          "UPDATE sends SET status='unknown', error='uncertain', claimed_until=NULL WHERE id=? AND status='sending'",
          [row.id],
        );
      else if (row.kind === "transactional" && outcome.retry === "transient" && row.attempts < 5n) {
        const delay = 1000 * 2 ** (Number(row.attempts) - 1);
        db.run(
          "UPDATE sends SET status='queued', error='temporary_rejection', next_attempt_at=?, claimed_until=NULL WHERE id=? AND status='sending'",
          [new Date(clock.now().getTime() + delay).toISOString(), row.id],
        );
      } else
        db.run(
          "UPDATE sends SET status='failed', error=?, claimed_until=NULL WHERE id=? AND status='sending'",
          [outcome.retry === "transient" ? "temporary_rejection" : "not_accepted", row.id],
        );
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
