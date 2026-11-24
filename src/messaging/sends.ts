// Native send journal. listmonk has no equivalent outbox or send-log API.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { Clock } from "@/clock";
import { must } from "@/invariant";
import { writeTransaction } from "@/db/transaction";
import type { Message, Outcome } from "@/messaging/email";
import { decodePayload, encodePayload } from "@/messaging/payload";
import { inListScopeSQL } from "@/subscribers/condition-sql";
import type { Scope, SubscriberStore } from "@/subscribers/store";
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
  /** From the prepared message; null once the payload is dropped (retention, or anonymization). */
  subject: string | null;
  /** The template's and the sequence's names as the send was queued (B117d, D139); null when it has none. */
  template_name: string | null;
  sequence_name: string | null;
}
/** Why a send has no subject (B127 r1): a skipped send never had a payload, a wiped one has no address. */
export type SubjectMissing = "skipped" | "wiped" | "retention";
/**
 * The cause of a send's missing subject, or null when it has one. A wiped send has an empty address,
 * since the anonymizer clears it with the payload (D135); a skipped one never had a payload; any other
 * one lost its payload to the thirty-day retention (D70) and keeps its address.
 */
export function subjectMissing(row: { subject: string | null; to_email: string; status: string }) {
  if (row.subject !== null) {
    return null;
  }
  if (row.to_email === "") {
    return "wiped" as const;
  }
  return row.status === "skipped" ? ("skipped" as const) : ("retention" as const);
}
/** The sequence and position a step sits at, for a send's label (B127). From the sequences module. */
export interface StepLabel {
  sequence_id: bigint;
  sequence_name: string;
  position: bigint;
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
  claimed_until: string | null;
}
/** A claimed row and its admitted message; null when admission already settled the row. */
export interface Claimed {
  row: Row;
  message: Message | null;
}
// The subject is read from the payload's JSON, one value per row returned, never stored apart. The names
// are columns, written when the send is queued (B117d), so a deleted template or sequence keeps them.
const publicColumns = `id, uuid, source, kind, subscriber_id, to_email, template_id,
  enrollment_id, step_id, list_id, status, skip_reason, smtp_message_id, error,
  attempts, retry_of, next_attempt_at, created_at, sent_at, template_name, sequence_name,
  json_extract(payload, '$.message.subject') AS subject`;
/** More than the steps of a sequence, which a reorder can revisit. */
const ENROLLMENT_SENDS = 200;
export interface EnrollmentSend {
  id: bigint;
  step_id: bigint | null;
  kind: string;
  status: string;
  skip_reason: string | null;
  created_at: string;
  sent_at: string | null;
}
export interface SendFilter {
  page: number;
  perPage: number;
  /**
   * The sends the reader may see: every one when `all`, else those whose subscriber is on one of `ids`
   * (B117d, D139). An external recipient is on no list, so a list-scoped reader never sees it.
   */
  scope: Scope;
  status?: string;
  kind?: string;
  source?: string;
  subscriberId?: bigint;
  listId?: bigint;
}
const jsonBigint = (v: bigint) =>
  v <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(v)
    : (JSON as typeof JSON & { rawJSON(value: string): object }).rawJSON(v.toString());
const jsonID = (v: bigint | null) => (v === null ? null : jsonBigint(v));
function project(row: PublicRow, label?: StepLabel, liveTemplateName?: string) {
  return {
    id: jsonID(row.id),
    uuid: row.uuid,
    source: row.source,
    kind: row.kind,
    subscriber_id: jsonID(row.subscriber_id),
    to_email: row.to_email,
    template_id: jsonID(row.template_id),
    // The name the send was queued with (B117d, D139): a transactional send names what it sent (B127), and a
    // deleted template keeps its name. A send queued before the names were stored shows the live name.
    template_name: row.template_name ?? liveTemplateName ?? null,
    enrollment_id: jsonID(row.enrollment_id),
    step_id: jsonID(row.step_id),
    list_id: jsonID(row.list_id),
    subject: row.subject,
    subject_missing: subjectMissing(row),
    // A sequence send's sequence and the step's position are read now (null for a removed step). The
    // sequence's name is the one the send was queued with, else the live one (B117d, D139).
    sequence_id: label ? jsonID(label.sequence_id) : null,
    sequence_name: row.sequence_name ?? label?.sequence_name ?? null,
    step_position: label ? Number(label.position) : null,
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
const noop = () => {};
const summary = (row: PublicRow): SendSummary => ({
  id: jsonBigint(row.id),
  uuid: row.uuid,
  status: row.status,
  smtp_message_id: row.smtp_message_id,
});
// Idempotency rows store `tx:<sha256(key)>:<fingerprint>:<index>` in the existing
// unique column, so one request with several recipients keeps one key and the
// request fingerprint without a schema change. The raw key is never stored.
const keyPrefix = (key: string) => `tx:${createHash("sha256").update(key).digest("hex")}:`;
export function createSends(options: {
  db: Database;
  clock: Clock;
  subscribers: SubscriberStore;
  rootUrl: () => string;
  marketingPolicy?: MarketingPolicy;
  /** A send became `failed` or `unknown`, inside that write's transaction. */
  ended?: (send: EndedSend) => void;
  /** The sequence and position of each step, read by the sequences module (B127). */
  stepLabels?: (ids: Array<bigint>) => Map<bigint, StepLabel>;
  /** The name of each template, read by the templates module for a send's label (B127). */
  templateNames?: (ids: Array<bigint>) => Map<bigint, string>;
}) {
  const { db, clock, subscribers } = options;
  // Every projection of a send carries its step's label, read in one call per list.
  const labelRows = (rows: Array<PublicRow>): Map<bigint, StepLabel> => {
    const ids = [...new Set(rows.flatMap((row) => (row.step_id === null ? [] : [row.step_id])))];
    return ids.length && options.stepLabels
      ? options.stepLabels(ids)
      : new Map<bigint, StepLabel>();
  };
  // The live template name of each row that stores none (a send queued before B117d, D139): one lookup per page,
  // in the templates module, and none for a row that stores its name.
  const liveTemplateRows = (rows: Array<PublicRow>): Map<bigint, string> => {
    const ids = [
      ...new Set(
        rows.flatMap((row) =>
          row.template_name === null && row.template_id !== null ? [row.template_id] : [],
        ),
      ),
    ];
    return ids.length && options.templateNames
      ? options.templateNames(ids)
      : new Map<bigint, string>();
  };
  const projectAll = (rows: Array<PublicRow>) => {
    const labels = labelRows(rows);
    const templates = liveTemplateRows(rows);
    return rows.map((row) =>
      project(
        row,
        row.step_id === null ? undefined : labels.get(row.step_id),
        row.template_id === null ? undefined : templates.get(row.template_id),
      ),
    );
  };
  const projectOne = (row: PublicRow) => must(projectAll([row])[0] ?? null, "send");
  /**
   * The names a send is queued with (B117d, D139), read by the modules that own the template and the
   * step, inside the queueing transaction. A deleted template or sequence therefore keeps its name.
   */
  type QueueNames = { templates: Map<bigint, string>; steps: Map<bigint, StepLabel> };
  const queueNames = (
    templateIds: Array<bigint | null | undefined>,
    stepIds: Array<bigint | null | undefined>,
  ): QueueNames => {
    const templates = templateIds.filter((id): id is bigint => id !== null && id !== undefined);
    const steps = stepIds.filter((id): id is bigint => id !== null && id !== undefined);
    return {
      templates:
        templates.length && options.templateNames
          ? options.templateNames(templates)
          : new Map<bigint, string>(),
      steps:
        steps.length && options.stepLabels
          ? options.stepLabels(steps)
          : new Map<bigint, StepLabel>(),
    };
  };
  const templateNameOf = (names: QueueNames, id: bigint | null | undefined) =>
    id === null || id === undefined ? null : (names.templates.get(id) ?? null);
  const sequenceNameOf = (names: QueueNames, id: bigint | null | undefined) =>
    id === null || id === undefined ? null : (names.steps.get(id)?.sequence_name ?? null);
  /** Whether a reader of `scope` may read this send: every send for an unrestricted reader (B117d). */
  const covers = (row: { subscriber_id: bigint | null }, scope: Scope) =>
    scope.all ||
    (row.subscriber_id !== null &&
      subscribers.readable([row.subscriber_id], scope).has(row.subscriber_id));
  const ended = (row: Row, status: string, error: string, changes: number) => {
    if (!changes) {
      return;
    }
    // D85: `row` was read at claim time. A send anonymized since then ends silently, like the
    // skipped retry above, so a wiped subscriber's list never reaches a `send.failed` payload.
    const current = db
      .query<{ to_email: string }, [bigint]>("SELECT to_email FROM sends WHERE id = ?")
      .get(row.id);
    if (current?.to_email === "") {
      return;
    }
    options.ended?.({ ...row, status, error });
  };
  let wake = noop;
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
  function withoutBlockedCopies(message: Message) {
    if (!message.headers) {
      return { message, removed: 0 };
    }
    let removed = 0;
    const keep = (value: string) =>
      value
        .split(",")
        .filter((part) => {
          const address = parseAddress(trimSpace(part));
          if (address === undefined || !blocklisted(address)) {
            return true;
          }
          removed++;
          return false;
        })
        .join(",");
    const headers: Record<string, string | Array<string>> = {};
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
      if (row.subscriber_id === null) {
        return "subscriber_unavailable";
      }
      const subscriber = subscribers.get(row.subscriber_id);
      if (!subscriber || subscriber.uuid !== subscriberUuid || subscriber.email !== row.to_email) {
        return "subscriber_unavailable";
      }
      if (subscriber.status === "blocklisted") {
        return "subscriber_blocklisted";
      }
    } else if (row.subscriber_id !== null) {
      return "subscriber_unavailable";
    }
    // Unlinked rows (external mode, unknown-at-enqueue addresses) are rechecked by address.
    if (blocklisted(row.to_email)) {
      return "subscriber_blocklisted";
    }
    if (row.kind === "marketing") {
      return marketing(row.subscriber_id, row.list_id, {
        lineage: row.id,
        pending: false,
      });
    }
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
    if (!row) {
      return null;
    }
    // `AND status='queued'` is the transition's from-state. On one connection nothing can
    // change the row between the SELECT above and this UPDATE (single-threaded, no await), so
    // `changes` is always 1 here and the guard is unreachable without a concurrent writer. It
    // stays as the from-state guard, with no test that pretends to cover it.
    const { changes } = db.run(
      "UPDATE sends SET status='sending', attempts=attempts+1, attempted_at=?, claimed_until=?, next_attempt_at=NULL WHERE id=? AND status='queued'",
      [time.toISOString(), lease.toISOString(), row.id],
    );
    return changes ? get(row.id) : null;
  }
  /**
   * Decode and recheck a claimed row. A row that cannot be sent is settled here; a sendable
   * row records only its dropped copy count. Callers in the claim transaction commit these
   * writes with the claim.
   */
  function admit(row: Row): Message | null {
    let payload: ReturnType<typeof decodePayload>;
    try {
      if (!row.payload) {
        throw new Error();
      }
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
    // The journal text is decoded; the claimed row must not keep a second copy of it while the
    // message is pushed (B28). Nothing after admission reads `row.payload`.
    row.payload = null;
    // A delivered row records only how many copy recipients were dropped.
    const { message, removed } = withoutBlockedCopies(payload.message);
    db.run("UPDATE sends SET skip_reason=? WHERE id=? AND status='sending'", [
      removed ? `copies_blocklisted:${removed}` : null,
      row.id,
    ]);
    return { ...message, messageId: row.smtp_message_id };
  }
  /** Journals one SMTP outcome. Not-started outcomes are mapped to `unsent` by the caller first. */
  function finish(row: Row, outcome: Outcome) {
    const at = now();
    if (outcome.status === "accepted") {
      db.run(
        "UPDATE sends SET status='sent', sent_at=?, error=?, claimed_until=NULL WHERE id=? AND status='sending'",
        [at, outcome.rejected.length ? "partial_acceptance" : null, row.id],
      );
    } else if (outcome.status === "ambiguous") {
      const { changes } = db.run(
        "UPDATE sends SET status='unknown', error='uncertain', claimed_until=NULL WHERE id=? AND status='sending'",
        [row.id],
      );
      ended(row, "unknown", "uncertain", changes);
    } else if (row.kind === "transactional" && outcome.retry === "transient" && row.attempts < 5n) {
      const delay = 1000 * 2 ** (Number(row.attempts) - 1);
      // A row anonymized while sending has no payload to retry (D25, D80): it is skipped.
      const { changes } = db.run(
        "UPDATE sends SET status='queued', error='temporary_rejection', next_attempt_at=?, claimed_until=NULL WHERE id=? AND status='sending' AND payload IS NOT NULL",
        [new Date(clock.now().getTime() + delay).toISOString(), row.id],
      );
      if (!changes) {
        db.run(
          "UPDATE sends SET status='skipped', skip_reason='subscriber_unavailable', error=NULL, claimed_until=NULL, next_attempt_at=NULL WHERE id=? AND status='sending' AND payload IS NULL",
          [row.id],
        );
      }
    } else {
      const error = outcome.retry === "transient" ? "temporary_rejection" : "not_accepted";
      const { changes } = db.run(
        "UPDATE sends SET status='failed', error=?, claimed_until=NULL WHERE id=? AND status='sending'",
        [error, row.id],
      );
      ended(row, "failed", error, changes);
    }
  }
  /**
   * A push that threw before any pool saw the message: it provably never left. Under the restore
   * hold the claim goes back to `queued` without counting the attempt (the loop claims nothing
   * until release); any other throw fails the row. Both name the claim's lease.
   */
  function unsent(row: Row, held: boolean) {
    if (held) {
      db.run(
        "UPDATE sends SET status='queued', attempts=attempts-1, claimed_until=NULL WHERE id=? AND status='sending' AND claimed_until=?",
        [row.id, row.claimed_until],
      );
      return;
    }
    const { changes } = db.run(
      "UPDATE sends SET status='failed', error='push_failed', claimed_until=NULL WHERE id=? AND status='sending' AND claimed_until=?",
      [row.id, row.claimed_until],
    );
    ended(row, "failed", "push_failed", changes);
  }
  /**
   * The one `sending` -> `unknown`/`interrupted` transition. With `expiredBefore`, only rows
   * whose lease ended by then; without, every `sending` row.
   */
  function interrupt(expiredBefore?: string, live: ReadonlyArray<bigint> = []) {
    const interrupted = db
      .query<Row, [string | null, string]>(
        `UPDATE sends SET status='unknown', error='interrupted', claimed_until=NULL, next_attempt_at=NULL
           WHERE status='sending' AND (?1 IS NULL OR claimed_until <= ?1)
             AND id NOT IN (SELECT value FROM json_each(?2)) RETURNING *`,
      )
      .all(expiredBefore ?? null, JSON.stringify(live.map(Number)));
    for (const row of interrupted) {
      ended(row, "unknown", "interrupted", 1);
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
    if (!policy) {
      return "policy_unavailable";
    }
    const reason = policy.consent({ subscriberId, listId });
    if (reason) {
      return reason;
    }
    const start = policy.capStart(clock.now());
    if (start === null || subscriberId === null) {
      return null;
    }
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
    if (hit) {
      return "frequency_cap";
    }
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
    ) {
      throw new Error("Invalid prepared send");
    }
    const subscriber =
      input.subscriberId === null || input.subscriberId === undefined
        ? null
        : subscribers.get(input.subscriberId);
    if (
      input.subscriberId !== null &&
      input.subscriberId !== undefined &&
      (!subscriber || subscriber.email !== input.message.to[0])
    ) {
      throw new Error("Invalid prepared send");
    }
    const payload = encodePayload(input.message, subscriber?.uuid ?? null);
    const uuid = crypto.randomUUID();
    const id = writeTransaction(db, () => {
      const names = queueNames([input.templateId], [input.stepId]);
      const row = db
        .query<{ id: bigint }, Array<SQLQueryBindings>>(
          `INSERT INTO sends(uuid, source, kind, subscriber_id, to_email, template_id, enrollment_id, step_id, list_id, idempotency_key, status, smtp_message_id, payload, created_at, template_name, sequence_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          uuid,
          input.source,
          input.kind,
          input.subscriberId ?? null,
          input.message.to[0] ?? null,
          input.templateId ?? null,
          input.enrollmentId ?? null,
          input.stepId ?? null,
          input.listId ?? null,
          input.idempotencyKey ?? null,
          messageId(uuid),
          payload,
          now(),
          templateNameOf(names, input.templateId),
          sequenceNameOf(names, input.stepId),
        );
      return must(row, "inserted send").id;
    });
    wake();
    return projectOne(must(getPublic(id), "queued send"));
  }
  /** A resend of a send the reader's scope does not cover answers `"forbidden"`, and writes nothing (B117d). */
  function resend(id: bigint, authorize: () => void, scope: Scope) {
    const result = writeTransaction(db, () => {
      authorize();
      const original = get(id);
      if (!original) {
        throw new HttpError(404);
      }
      if (!covers(original, scope)) {
        return "forbidden" as const;
      }
      const child = byChild(id);
      if (child) {
        return projectOne(child);
      }
      if (!["failed", "unknown"].includes(original.status) || !original.payload) {
        throw new HttpError(409);
      }
      let payload: ReturnType<typeof decodePayload>;
      try {
        payload = decodePayload(original.payload);
      } catch {
        throw new HttpError(409);
      }
      if (eligibility(original, payload.subscriberUuid)) {
        throw new HttpError(409);
      }
      const uuid = crypto.randomUUID();
      const inserted = db
        .query<{ id: bigint }, Array<SQLQueryBindings>>(
          `INSERT INTO sends(uuid, source, kind, subscriber_id, to_email, template_id, list_id, status, smtp_message_id, payload, retry_of, created_at, template_name) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?) RETURNING id`,
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
          // The child keeps the name its original was queued with; it is a resend, not a step.
          original.template_name,
        );
      const resent = must(inserted, "resent send");
      return projectOne(must(getPublic(resent.id), "resent send"));
    });
    wake();
    return result;
  }
  function replay(prefix: string, fingerprint: string): Array<PublicRow> | null {
    const rows = db
      .query<PublicRow & { idempotency_key: string }, [string, string]>(
        `SELECT ${publicColumns}, idempotency_key FROM sends WHERE idempotency_key >= ? AND idempotency_key < ?`,
      )
      .all(prefix, `${prefix.slice(0, -1)};`);
    if (!rows.length) {
      return null;
    }
    const indexed = rows.map((row) => {
      const rest = row.idempotency_key.slice(prefix.length);
      const at = rest.lastIndexOf(":");
      return {
        row,
        fingerprint: rest.slice(0, at),
        index: Number(rest.slice(at + 1)),
      };
    });
    if (indexed.some((item) => item.fingerprint !== fingerprint)) {
      throw new HttpError(409, "Idempotency key was already used with a different request.");
    }
    return indexed.sort((a, b) => a.index - b.index).map((item) => item.row);
  }
  /**
   * Journal every recipient of one producer request atomically. Linked identities and
   * blocklist status are rechecked in the write; blocklisted addresses and marketing
   * without an injected policy are skipped and never queued. A repeated idempotency
   * key returns the first rows and inserts nothing.
   */
  function enqueueRequest(input: {
    sends: Array<RequestedSend>;
    idempotency?: { key: string; fingerprint: string } | null;
    authorize?: () => void;
  }): {
    replayed: boolean;
    ids: Array<bigint>;
    sends: Array<SendSummary>;
    queued: Array<bigint>;
  } {
    if (!Array.isArray(input.sends) || !input.sends.length || input.sends.length > 1000) {
      throw new Error("Invalid prepared send");
    }
    const fingerprint = input.idempotency?.fingerprint;
    if (
      input.idempotency &&
      (typeof input.idempotency.key !== "string" ||
        !input.idempotency.key ||
        typeof fingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(fingerprint))
    ) {
      throw new Error("Invalid prepared send");
    }
    const prepared = input.sends.map(({ send, subscriberUuid }) => {
      if (
        !send ||
        !["tx", "sequence"].includes(send.source) ||
        !["transactional", "marketing"].includes(send.kind)
      ) {
        throw new Error("Invalid prepared send");
      }
      if (
        (send.subscriberId === null || send.subscriberId === undefined) !==
        (subscriberUuid === null)
      ) {
        throw new Error("Invalid prepared send");
      }
      if (
        send.uuid !== undefined &&
        (typeof send.uuid !== "string" || !uuidPattern.test(send.uuid))
      ) {
        throw new Error("Invalid prepared send");
      }
      return {
        send,
        subscriberUuid,
        payload: encodePayload(send.message, subscriberUuid),
      };
    });
    const result = writeTransaction(db, () => {
      input.authorize?.();
      const prefix = input.idempotency ? keyPrefix(input.idempotency.key) : null;
      if (prefix) {
        // The key and its fingerprint are validated above, so a fingerprint is always present here.
        if (typeof fingerprint !== "string") {
          throw new Error("sends: idempotent request has no fingerprint");
        }
        const previous = replay(prefix, fingerprint);
        if (previous) {
          return {
            replayed: true,
            ids: previous.map((row) => row.id),
            sends: previous.map(summary),
            queued: [],
          };
        }
      }
      const names = queueNames(
        prepared.map(({ send }) => send.templateId),
        prepared.map(({ send }) => send.stepId),
      );
      const rows: Array<PublicRow> = [];
      const queued: Array<bigint> = [];
      prepared.forEach(({ send, subscriberUuid, payload }, index) => {
        const to = send.message.to[0];
        if (to === undefined) {
          throw new Error("sends: prepared message has no recipient");
        }
        let skip: string | null = null;
        if (send.subscriberId !== null && send.subscriberId !== undefined) {
          const current = subscribers.get(send.subscriberId);
          if (!current || current.uuid !== subscriberUuid || current.email !== to) {
            throw new HttpError(
              409,
              "Subscriber changed. Retry the request.",
              {},
              "subscriber_changed",
            );
          }
          if (current.status === "blocklisted") {
            skip = "subscriber_blocklisted";
          }
        } else if (blocklisted(to)) {
          skip = "subscriber_blocklisted";
        }
        if (!skip && send.kind === "marketing") {
          skip = marketing(send.subscriberId ?? null, send.listId ?? null, {
            lineage: null,
            pending: true,
          });
        }
        const uuid = send.uuid ?? crypto.randomUUID();
        const inserted = db
          .query<{ id: bigint }, Array<SQLQueryBindings>>(
            `INSERT INTO sends(uuid, source, kind, subscriber_id, to_email, template_id, enrollment_id, step_id, list_id, idempotency_key, status, skip_reason, smtp_message_id, payload, created_at, template_name, sequence_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
            templateNameOf(names, send.templateId),
            sequenceNameOf(names, send.stepId),
          );
        const row = must(inserted, "queued send");
        if (!skip) {
          queued.push(row.id);
        }
        rows.push(must(getPublic(row.id), "queued send"));
      });
      return {
        replayed: false,
        ids: rows.map((row) => row.id),
        sends: rows.map(summary),
        queued,
      };
    });
    if (result.queued.length) {
      wake();
    }
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
  }): { ids: Array<bigint>; sends: Array<SendSummary> } | null {
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
    const journal = latest ? Date.parse(latest) : Number.NaN;
    const campaign = policy?.lastCampaignDelivery?.(subscriberId)?.at.getTime() ?? Number.NaN;
    const last = Number.isFinite(campaign)
      ? Number.isFinite(journal)
        ? Math.max(journal, campaign)
        : campaign
      : journal;
    if (!policy || !Number.isFinite(last)) {
      return floor;
    }
    // capStart is monotonic in its argument: find the first instant whose window starts at or
    // after the last counted send. A window is at most about 10,000 years plus a few days.
    const admits = (t: number) => {
      const start = policy.capStart(new Date(t));
      return start === null || start.getTime() >= last;
    };
    let low = Math.max(floor.getTime(), last);
    if (admits(low)) {
      return new Date(low);
    }
    let high = low + 86_400_000;
    while (!admits(high)) {
      if (high - low > 4e14) {
        return new Date(high);
      }
      high = low + (high - low) * 2;
    }
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (admits(mid)) {
        high = mid;
      } else {
        low = mid;
      }
    }
    return new Date(high);
  }
  /** Validated payload of a sequence send, encoded before its write transaction. */
  type PreparedSequenceSend = {
    send: PreparedSend;
    subscriberUuid: string;
    payload: string;
  };
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
    if (!db.inTransaction) {
      throw new Error("Sequence sends are written in the caller's transaction");
    }
    const row =
      "prepared" in input
        ? {
            uuid: input.prepared.send.uuid ?? crypto.randomUUID(),
            kind: input.prepared.send.kind,
            subscriberId: input.prepared.send.subscriberId ?? null,
            to: input.prepared.send.message.to[0] ?? null,
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
    if (row.enrollmentId === null || row.stepId === null) {
      throw new Error("Invalid prepared send");
    }
    const names = queueNames([row.templateId], [row.stepId]);
    const inserted = db
      .query<{ id: bigint }, Array<SQLQueryBindings>>(
        `INSERT INTO sends(uuid, source, kind, subscriber_id, to_email, template_id, enrollment_id, step_id, list_id, status, skip_reason, smtp_message_id, payload, created_at, template_name, sequence_name) VALUES (?, 'sequence', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
        templateNameOf(names, row.templateId),
        sequenceNameOf(names, row.stepId),
      );
    return must(inserted, "sequence send").id;
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
        send.subscriberId === null ||
        send.subscriberId === undefined ||
        send.enrollmentId === null ||
        send.enrollmentId === undefined ||
        send.stepId === null ||
        send.stepId === undefined ||
        (send.uuid !== undefined && !uuidPattern.test(send.uuid))
      ) {
        throw new Error("Invalid prepared send");
      }
      return {
        send,
        subscriberUuid,
        payload: encodePayload(send.message, subscriberUuid),
      };
    },
    /**
     * Admission of a prepared sequence send inside the caller's write transaction, as
     * enqueueRequest checks a linked recipient: the same current subscriber and address,
     * not blocklisted, then marketing consent and the cap. A reason, or null to queue it.
     */
    sequenceAdmission(prepared: PreparedSequenceSend): string | null {
      const { send, subscriberUuid } = prepared;
      // A sequence send names its subscriber; without one, the subscriber is unavailable, as a missing row is.
      const subscriberId = send.subscriberId ?? null;
      const current = subscriberId === null ? null : subscribers.get(subscriberId);
      if (
        subscriberId === null ||
        !current ||
        current.uuid !== subscriberUuid ||
        current.email !== send.message.to[0]
      ) {
        return "subscriber_unavailable";
      }
      if (current.status === "blocklisted" || blocklisted(current.email)) {
        return "subscriber_blocklisted";
      }
      if (send.kind === "marketing") {
        return marketing(subscriberId, send.listId ?? null, {
          lineage: null,
          pending: true,
        });
      }
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
    claimQueued(ids: Array<bigint>, time: Date, lease: Date): Array<Claimed> {
      return writeTransaction(db, () => {
        const claimed: Array<Claimed> = [];
        for (const id of ids) {
          const changed = db.run(
            "UPDATE sends SET status='sending', attempts=attempts+1, attempted_at=?3, claimed_until=?1, next_attempt_at=NULL WHERE id=?2 AND status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?3)",
            [lease.toISOString(), id, time.toISOString()],
          );
          if (!changed.changes) {
            continue;
          }
          const row = must(get(id), "claimed send");
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
     * Whether the prepared HTML or plain body of a send contains `text`, or, once retention
     * has dropped the body, its kept link paths do. Tracked-link redirects use it so only
     * links rendered into that message can redirect.
     */
    bodyIncludes(id: bigint, text: string): boolean {
      const row = db
        .query<{ body: string | null; alt: string | null; links: string | null }, [bigint]>(
          "SELECT json_extract(payload, '$.message.body') AS body, json_extract(payload, '$.message.altBody') AS alt, tracked_links AS links FROM sends WHERE id = ?",
        )
        .get(id);
      if (!row) {
        return false;
      }
      if (row.links?.includes(text)) {
        return true;
      }
      return [row.body, row.alt].some(
        (value) => typeof value === "string" && Buffer.from(value, "base64").includes(text),
      );
    },
    /** What an enrollment's timeline shows of its sends: no address, oldest first. */
    enrollmentSends(enrollmentId: bigint) {
      return db
        .query<EnrollmentSend, [bigint, number]>(
          "SELECT id, step_id, kind, status, skip_reason, created_at, sent_at FROM sends WHERE enrollment_id = ? ORDER BY id LIMIT ?",
        )
        .all(enrollmentId, ENROLLMENT_SENDS);
    },
    /** The send with this ID, `"forbidden"` when it exists and `scope` does not cover it, or null (B117d). */
    get(id: bigint, scope: Scope) {
      const row = getPublic(id);
      if (!row) {
        return null;
      }
      return covers(row, scope) ? projectOne(row) : ("forbidden" as const);
    },
    list(filter: SendFilter) {
      const clauses: Array<string> = [],
        values: Array<string | bigint | number> = [];
      for (const [key, value] of [
        ["status", filter.status],
        ["kind", filter.kind],
        ["source", filter.source],
        ["subscriber_id", filter.subscriberId],
        ["list_id", filter.listId],
      ] as const) {
        if (value !== undefined) {
          clauses.push(`${key} = ?`);
          values.push(value);
        }
      }
      if (!filter.scope.all) {
        // A list-scoped reader sees the sends to subscribers with a membership on one of its lists, the
        // rule a subscriber read applies (B117d, D139). An external recipient has none, so it is left out.
        // The membership SQL belongs to the subscribers module.
        const scoped = inListScopeSQL("subscriber_id", filter.scope);
        clauses.push(scoped.sql);
        values.push(...scoped.args);
      }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const total = must(
        db
          .query<{ total: bigint }, Array<SQLQueryBindings>>(
            `SELECT count(*) AS total FROM sends${where}`,
          )
          .get(...values),
        "send count",
      ).total;
      const rows = db
        .query<PublicRow, Array<SQLQueryBindings>>(
          `SELECT ${publicColumns} FROM sends${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
        )
        .all(...values, filter.perPage, (filter.page - 1) * filter.perPage);
      return {
        results: projectAll(rows),
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
    /** Startup: every row still `sending` was cut off by a restart. */
    recover() {
      writeTransaction(db, interrupt);
    },
    /**
     * Each outbox pass (D80), inside the caller's write transaction: a `sending` row whose lease
     * has expired is `unknown`/`interrupted`, exactly as `recover` settles it. Never re-queued.
     * `live` are rows whose push is still in flight in this process: a clock jump over their
     * lease must not settle them, their own outcome will.
     */
    expireLeases(time: Date, live: ReadonlyArray<bigint> = []) {
      interrupt(time.toISOString(), live);
    },
    /** Claim the lowest due row inside the caller's write transaction. */
    claim(time: Date, lease: Date): Array<Row> {
      const row = claimOne(time, lease);
      return row ? [row] : [];
    },
    /**
     * Claim up to `limit` due rows in id order and admit each, inside the caller's write
     * transaction, so the claims and every admission outcome commit together before SMTP.
     * Each row is admitted right after its claim, so a later row in the batch sees an
     * earlier one as `sending` for the marketing cap, as it would one batch later.
     */
    claimBatch(time: Date, lease: Date, limit: number): Array<Claimed> {
      const claimed: Array<Claimed> = [];
      for (let i = 0; i < limit; i++) {
        const row = claimOne(time, lease);
        if (!row) {
          break;
        }
        claimed.push({ row, message: admit(row) });
      }
      return claimed;
    },
    admit,
    finish,
    /** Journal several SMTP outcomes in one commit. */
    finishAll(
      results: Array<{ row: Row; outcome: Outcome } | { row: Row; unsent: "held" | "failed" }>,
    ) {
      if (!results.length) {
        return;
      }
      writeTransaction(db, () => {
        for (const result of results) {
          if ("unsent" in result) {
            unsent(result.row, result.unsent === "held");
          } else {
            finish(result.row, result.outcome);
          }
        }
      });
    },
    onWake(fn: () => void) {
      wake = fn;
    },
    close() {
      wake = noop;
    },
  };
}
export type Sends = ReturnType<typeof createSends>;
