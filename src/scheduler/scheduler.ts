// Native sequence scheduler (docs/design/05-sequences.md#scheduler, #template-data;
// 04-sending.md#outbox, #frequency-cap, #unsubscribe); no upstream source. Enrollment SQL is
// owned by src/sequences, send rows and marketing admission by src/messaging, and delivery by
// the outbox: this loop only decides, renders and commits each decision in one short write.
import type { Database } from "bun:sqlite";
import { must } from "@/invariant";
import type { ErrorLogger } from "@/app";
import type { Clock } from "@/clock";
import type { ConditionEvaluator } from "@/conditions/evaluate";
import { parseDuration } from "@/conditions/duration";
import { aggregateOnSource, evaluateStoredOnSource } from "@/conditions/source";
import type { SourceContext, SourceReads } from "@/conditions/source";
import type { ConditionError } from "@/conditions/types";
import { writeTransaction } from "@/db/transaction";
import { AGGREGATE_LIMIT } from "@/events/aggregate";
import type { EventStore } from "@/events/store";
import { createLoop } from "@/loops/loop";
import { sendingHeld } from "@/settings/hold";
import type { SafeMessage } from "@/maintenance/log-buffer";
import type { Message } from "@/messaging/email";
import type { Sends } from "@/messaging/sends";
import type { Claim, Enrollments, SchedulerContext } from "@/sequences/enrollments";
import { renderStep, stepCompileInput, stepDataText, TEST_SUBJECT } from "@/sequences/step-data";
import type { SubscriberStore } from "@/subscribers/store";
import { createMessageBudget, RenderCapacityError } from "@/templates/renderer";
import type { TemplateRenderer } from "@/templates/renderer";
import { plainText } from "@/messaging/plain";
import type { TemplateStore } from "@/templates/store";
import { messageLinks } from "@/unsubscribe/message";
import type { MarketingSettings } from "@/unsubscribe/policy";
import type { Tracking } from "@/unsubscribe/tracking";
import type { SourceProvider } from "@/sources/project";
import { isSubscriberChanged } from "@/sources/recipient-sync";
import type { SendTimeLookup } from "@/sources/send-time";
import { isSourceError } from "@/sources/source";
import type { SourceEvent } from "@/sources/source";
import { isSettingsMismatch } from "@/sources/stream-record";

export const SCHEDULER_INTERVAL_MS = 15_000;
const LEASE_MS = 5 * 60_000;
const BATCH = 100;
/** Marketing steps without `max_late` skip what is more than two days late. */
const MARKETING_MAX_LATE = "P2D";
/** Condition errors retry after the time already spent late, between these bounds. */
const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;
/** D172: transient source failures of one step are retried this long before `source_error`. */
export const SOURCE_RETRY_MS = 72 * 3_600_000;
/**
 * D172: a transient source failure more than this long after the enrollment's previous one starts a
 * fresh 72-hour window: twice the retry backoff cap, so retries within one outage never exceed it.
 */
const SOURCE_OUTAGE_GAP_MS = 2 * BACKOFF_MAX_MS;
/** A deferred step is never due again sooner than this, so a capped row cannot spin. */
const DEFER_MIN_MS = 60_000;
/** Renderer capacity is shared with the HTTP producers; a full renderer retries soon. */
const BUSY_MS = SCHEDULER_INTERVAL_MS;
/** Compiled step templates kept by the scheduler; the least recently used is dropped. */
const COMPILED = 64;
/**
 * The definition a decision was made on. If any of it changed while the decision waited on its
 * condition (an admin edit), the decision is stale: it is discarded and the step re-evaluated.
 */
const DECIDED_ON = [
  "step_status",
  "position",
  "kind",
  "template_id",
  "subject",
  "condition",
  "aggregates",
  "on_false",
  "cap_policy",
  "max_late",
  "list_id",
] as const satisfies ReadonlyArray<keyof SchedulerContext>;

/** A claim with the full context its decision read. */
interface Decision extends Claim {
  step: SchedulerContext;
}

export interface SchedulerSettings {
  /** Default sender (`app.from_email`'s first address). */
  fromEmail: string;
  marketing: MarketingSettings;
}

/** A source failure as a condition error (D172), or undefined for any other error. */
const sourceError = (error: unknown): ConditionError | undefined =>
  isSourceError(error)
    ? {
        kind: error.kind === "transient" ? "source_transient" : "source_permanent",
        message: error.message,
      }
    : undefined;

/**
 * D172: the start of the enrollment's outage window that a source failure at `now` continues, or
 * null when it starts a fresh one: none is open, or its last failed read is more than
 * `SOURCE_OUTAGE_GAP_MS` earlier.
 */
const openWindow = (row: SchedulerContext, now: number): number | null =>
  row.error_since !== null &&
  row.error_last !== null &&
  now - Date.parse(row.error_last) <= SOURCE_OUTAGE_GAP_MS
    ? Date.parse(row.error_since)
    : null;

/** Create and start, for callers that decide at once. The server calls `createScheduler` (B52). */
export function startScheduler(options: SchedulerOptions) {
  const scheduler = createScheduler(options);
  scheduler.start();
  return scheduler;
}

export interface SchedulerOptions {
  db: Database;
  clock: Clock;
  logger: ErrorLogger;
  enrollments: Enrollments;
  sends: Sends;
  subscribers: Pick<SubscriberStore, "get">;
  templates: Pick<TemplateStore, "get">;
  events: Pick<EventStore, "get" | "aggregate">;
  renderer: TemplateRenderer;
  tracking: Tracking;
  conditions: Pick<ConditionEvaluator, "evaluate">;
  /** The project's source, which external sequences read (D172); none without it. */
  source?: SourceProvider;
  /**
   * D174: a source-linked subscriber's fresh address and name before each step renders, and its
   * leaving when the source no longer has it. None in fixtures without a source.
   */
  sendTime?: SendTimeLookup;
  settings: () => SchedulerSettings;
  signal?: AbortSignal;
}

/** Creates the scheduler without claiming; the server starts it after the bind (B52). */
export function createScheduler(options: SchedulerOptions) {
  const { db, clock, logger, enrollments, sends } = options;
  const attention = (safe: SafeMessage, message: string, cause?: unknown) => {
    try {
      logger.attention(message, safe);
      // The exception behind a failed decision is an unexpected error: its stack keeps its own line.
      if (cause !== undefined) {
        logger.error(cause);
      }
    } catch {
      /* Logging never changes a decision. */
    }
  };
  const compiled = new Map<string, ReturnType<TemplateRenderer["compile"]>>();
  function compile(key: string, input: Parameters<TemplateRenderer["compile"]>[0]) {
    let template = compiled.get(key);
    if (template) {
      compiled.delete(key);
    } else {
      template = options.renderer.compile(input);
    }
    compiled.set(key, template);
    if (compiled.size > COMPILED) {
      compiled.delete(must(compiled.keys().next().value, "oldest compiled template"));
    }
    return template;
  }

  /**
   * One decision and its writes, in one transaction, only while the claim holds and the
   * sequence and step are still what the decision read. The current definition is re-read here:
   * a pause releases the claim, an archive ends the enrollment, and any other change to the
   * step releases it to be decided again. A stale decision never writes or sends.
   */
  function commit(claim: Decision, write: (current: SchedulerContext) => void): boolean {
    return writeTransaction(db, () => {
      if (!enrollments.owns(claim)) {
        return false;
      }
      const current = enrollments.schedulerContext(claim.id);
      if (!current) {
        return false;
      }
      if (current.sequence_status !== claim.step.sequence_status) {
        if (current.sequence_status === "archived") {
          enrollments.endClaimed(claim, "exited", "sequence_archived", clock.now());
        } else {
          enrollments.release(claim, null);
        }
        return false;
      }
      if (DECIDED_ON.some((field) => current[field] !== claim.step[field])) {
        enrollments.release(claim, null);
        return false;
      }
      write(current);
      return true;
    });
  }
  function skipped(claim: Decision, email: string, reason: string, keepErrorSince = false) {
    return commit(claim, (row) => {
      sends.recordSequence({
        skip: reason,
        kind: row.kind,
        subscriberId: row.subscriber_id,
        toEmail: email,
        // The current reference: a template deleted meanwhile is null, never a dangling ID.
        templateId: row.template_id,
        enrollmentId: row.id,
        stepId: row.step_id,
        listId: row.kind === "marketing" ? row.list_id : null,
      });
      enrollments.advance(claim, clock.now(), keepErrorSince);
    });
  }
  const advance = (claim: Decision) => commit(claim, () => enrollments.advance(claim, clock.now()));
  // A condition exit keeps the condition's text, so the enrollment names what ended it (B127 r2).
  const end = (
    claim: Decision,
    status: "canceled" | "exited",
    reason: string,
    condition: string | null = null,
  ) => commit(claim, () => enrollments.endClaimed(claim, status, reason, clock.now(), condition));
  const retry = (claim: Decision, ms: number) =>
    commit(claim, () => enrollments.release(claim, new Date(clock.now().getTime() + ms)));
  const capped = (claim: Decision, email: string) =>
    claim.step.cap_policy === "skip"
      ? skipped(claim, email, "frequency_cap")
      : commit(claim, (row) => {
          const floor = new Date(clock.now().getTime() + DEFER_MIN_MS);
          enrollments.defer(claim, sends.capFreeAt(row.subscriber_id, floor));
        });

  /** Condition and aggregate failures wait the time already spent late, within these bounds. */
  const lateBackoff = (row: SchedulerContext) =>
    Math.min(
      BACKOFF_MAX_MS,
      Math.max(BACKOFF_MIN_MS, clock.now().getTime() - Date.parse(row.due_at)),
    );

  /**
   * D172: a source failure of an external step. A transient one is retried with the condition
   * backoff until its outage window reaches 72 hours; then, and at once for a permanent one, the
   * enrollment ends `source_error`. Nothing is sent past an unread condition. The window is one
   * continuous outage as this enrollment's reads see it: it starts at a failure with no window
   * open or more than `SOURCE_OUTAGE_GAP_MS` after the previous failed read (`error_last`), so an
   * old outage left open by a late skip never shortens a later one. A retry writes no attention
   * line (the outage itself is the source's to report); only the ending does, once per enrollment.
   */
  function sourceFailed(claim: Decision, row: SchedulerContext, error: ConditionError) {
    const now = clock.now().getTime();
    const since = openWindow(row, now) ?? now;
    if (error.kind === "source_transient" && now - since < SOURCE_RETRY_MS) {
      return commit(claim, () =>
        enrollments.releaseSourceRetry(
          claim,
          new Date(now + lateBackoff(row)),
          new Date(since),
          clock.now(),
        ),
      );
    }
    if (end(claim, "exited", "source_error")) {
      attention(
        "Sequence enrollment ended: the source could not be read",
        `Sequence enrollment ${row.id} ended with source_error at step ${row.step_id}: ${error.message}`,
      );
    }
    return undefined;
  }

  /**
   * D172: whether the source can still be read for an external enrollment past its 72-hour window
   * whose step is late: one read of its trigger record. `read` says whether the source answered; it
   * is false for an enrollment with no trigger record to read (a manual one), which keeps being
   * skipped `late` until a step that is not late reads the source.
   */
  async function probeSource(
    row: SchedulerContext,
  ): Promise<{ read: boolean } | { error: ConditionError }> {
    const source = options.source?.();
    if (!source) {
      return {
        error: { kind: "source_permanent", message: "The project has no source configured" },
      };
    }
    if (row.trigger_external_id === null) {
      return { read: false };
    }
    try {
      await source.record(
        row.trigger_external_id,
        options.signal ? { signal: options.signal } : {},
      );
      return { read: true };
    } catch (error) {
      const failure = sourceError(error);
      if (!failure) {
        throw error;
      }
      return { error: failure };
    }
  }

  /**
   * D174 (15-external-sources section 7): the subscriber with the source's current address and
   * name, read before the step renders and its consent is checked again, or null when the decision
   * ended here. The reads run with no transaction open; a change is written through the record
   * handler's conflict path in its own short transaction. A user the recipients view no longer has
   * is leaving: its enrollments (this one too) end and the subscriber is removed. A transient
   * failure, or a view the settings name wrongly, waits like any source read of the step (D172);
   * an address the source cannot give (none, two users holding it, a blocked domain) ends the
   * enrollment `source_error`. A marketing step to a user whose view row has the opt-out field set
   * exits `unsubscribed`. Nothing is sent on any of these paths.
   */
  async function refreshed(
    claim: Decision,
    row: SchedulerContext,
    subscriberId: bigint,
    externalId: string,
  ) {
    const lookup = must(options.sendTime, "send-time lookup");
    let optedOut: boolean;
    try {
      const planned = await lookup.read(subscriberId, externalId, options.signal);
      if (planned && !planned.unchanged && lookup.apply(planned).kind === "left") {
        return null;
      }
      optedOut = planned?.plan.kind === "present" && planned.plan.recipient.optOut;
    } catch (error) {
      if (isSubscriberChanged(error)) {
        // Another write moved the user or the address meanwhile: decide again with fresh reads.
        commit(claim, () => enrollments.release(claim, null));
        return null;
      }
      const failure = sourceError(error);
      if (!failure) {
        throw error;
      }
      sourceFailed(
        claim,
        row,
        isSettingsMismatch(error)
          ? { kind: "source_transient", message: failure.message }
          : failure,
      );
      return null;
    }
    const current = options.subscribers.get(subscriberId);
    if (!current) {
      end(claim, "canceled", "subscriber_deleted");
      return null;
    }
    if (current.status === "blocklisted") {
      end(claim, "exited", "blocklisted");
      return null;
    }
    if (optedOut && row.kind === "marketing") {
      // The view's opt-out field is set: the user declined marketing. The step's consent exit,
      // as `marketingReason` gives it, with no membership change; a transactional step still sends.
      end(claim, "exited", "unsubscribed");
      return null;
    }
    return current;
  }

  async function decide(item: { id: bigint; lease: string }) {
    const row = enrollments.schedulerContext(item.id);
    if (!row || row.status !== "active" || row.claimed_until !== item.lease) {
      return;
    }
    const claim: Decision = { id: row.id, lease: item.lease, step: row };
    const now = clock.now();
    // A send already recorded for this step (a crash before the advance, or a step revisited
    // after a reorder) is never written or sent again: only advance.
    if (sends.sequenceSend(row.id, row.step_id)) {
      return advance(claim);
    }
    if (row.sequence_status === "archived") {
      return end(claim, "exited", "sequence_archived");
    }
    // Paused (or returned to draft) after the claim: release it; it runs when resumed.
    if (row.sequence_status !== "active") {
      return commit(claim, () => enrollments.release(claim, null));
    }
    let subscriber = options.subscribers.get(row.subscriber_id);
    if (!subscriber) {
      return end(claim, "canceled", "subscriber_deleted");
    }
    if (subscriber.status === "blocklisted") {
      return end(claim, "exited", "blocklisted");
    }
    if (row.step_status === "deleted") {
      return advance(claim);
    }
    const maxLate = row.max_late ?? (row.kind === "marketing" ? MARKETING_MAX_LATE : null);
    const late = maxLate === null ? undefined : parseDuration(maxLate);
    if (late !== undefined && now.getTime() > Date.parse(row.due_at) + late) {
      // D172: the 72-hour source window is the enrollment's, not the step's. A late step keeps
      // `error_since` and `error_last`; once the window of a continuing outage has passed, a source
      // that still cannot be read ends the enrollment `source_error` rather than skipping step after
      // step. A probe that reads the source ends the outage: the skip then clears both.
      let read = false;
      const since = row.source === "external" ? openWindow(row, now.getTime()) : null;
      if (since !== null && now.getTime() - since >= SOURCE_RETRY_MS) {
        const probe = await probeSource(row);
        if ("error" in probe) {
          return sourceFailed(claim, row, probe.error);
        }
        read = probe.read;
      }
      return skipped(claim, subscriber.email, "late", !read);
    }
    const marketing = row.kind === "marketing";
    if (marketing) {
      const reason = sends.marketingReason(row.subscriber_id, row.list_id);
      if (reason && reason !== "frequency_cap") {
        return end(claim, "exited", "unsubscribed");
      }
    }

    const external = row.source === "external";
    const trigger = row.trigger_event_id === null ? null : options.events.get(row.trigger_event_id);
    const context = {
      subscriberId: row.subscriber_id,
      // A manual enrollment (or one whose trigger event expired) counts from its start. An external
      // enrollment counts from its trigger record's `occurredAt`, kept locally (D172).
      triggerAt: (external ? row.trigger_occurred_at : trigger?.occurred_at) ?? row.created_at,
      enrolledAt: row.created_at,
      lastStepAt: row.updated_at > row.created_at ? row.updated_at : null,
      now,
    };
    // D172: an external sequence reads its source. Without one configured, every read is refused.
    let reads: SourceReads | undefined;
    if (external) {
      const source = options.source?.();
      if (!source) {
        return sourceFailed(claim, row, {
          kind: "source_permanent",
          message: "The project has no source configured",
        });
      }
      reads = {
        source,
        local: options.conditions,
        ...(options.signal ? { signal: options.signal } : {}),
      };
    }
    const sourceContext: SourceContext = {
      ...context,
      subscriberId: row.subscriber_id,
      externalId: subscriber.external_id,
    };
    if (row.condition !== null) {
      const result = reads
        ? await evaluateStoredOnSource(JSON.parse(row.condition), sourceContext, reads)
        : await options.conditions.evaluate(JSON.parse(row.condition), context);
      if (!result.ok && reads && result.error.kind.startsWith("source_")) {
        return sourceFailed(claim, row, result.error);
      }
      if (!result.ok) {
        attention(
          "Sequence condition failed: retrying later",
          `Sequence condition failed for enrollment ${row.id} at step ${row.step_id} (${result.error.kind}); retrying later`,
        );
        return retry(claim, lateBackoff(row));
      }
      if (!result.value) {
        return row.on_false === "skip"
          ? advance(claim)
          : end(claim, "exited", "condition", row.condition);
      }
    }

    const template = row.template_id === null ? null : options.templates.get(row.template_id);
    if (!template || template.type !== "tx") {
      // Logged once, when recorded: a template deleted during the condition is a stale
      // decision, released and decided again.
      if (skipped(claim, subscriber.email, "template_unavailable")) {
        attention(
          "Sequence step has no transactional template: skipped",
          `Sequence step ${row.step_id} has no transactional template; enrollment ${row.id} skipped it`,
        );
      }
      return;
    }
    // D174: a source-linked subscriber's address and name are read fresh before the consent
    // recheck and the render, so both see what the source has now.
    if (options.sendTime?.configured() && subscriber.external_id !== null) {
      const current = await refreshed(claim, row, subscriber.id, subscriber.external_id);
      if (!current) {
        return;
      }
      subscriber = current;
    }
    if (marketing) {
      // Rechecked after the condition, which may have waited on the query runner.
      const reason = sends.marketingReason(row.subscriber_id, row.list_id);
      if (reason === "frequency_cap") {
        return capped(claim, subscriber.email);
      }
      if (reason) {
        return end(claim, "exited", "unsubscribed");
      }
    }

    // An external step's trigger data is the source record, read when the step renders. A record the
    // source no longer has ends the enrollment (`trigger_missing`); the subscriber stays (D172).
    let record: SourceEvent | null = null;
    if (reads && row.trigger_external_id !== null) {
      try {
        record = await reads.source.record(
          row.trigger_external_id,
          reads.signal ? { signal: reads.signal } : {},
        );
      } catch (error) {
        const failure = sourceError(error);
        if (!failure) {
          throw error;
        }
        return sourceFailed(claim, row, failure);
      }
      if (!record) {
        return end(claim, "exited", "trigger_missing");
      }
    }

    // Aggregates are read once the condition and the cap admit the step, before rendering (D100).
    // A failure waits like a condition error and never sends. An aggregate that cannot be computed
    // within its bounds (over AGGREGATE_LIMIT events, or a sum outside the exact integer range) is
    // not a failure to retry: the step is skipped, with no total and no retry loop.
    let aggregates: Record<string, number> = {};
    if (row.aggregates !== null) {
      const result = reads
        ? await aggregateOnSource(JSON.parse(row.aggregates), sourceContext, reads)
        : options.events.aggregate(JSON.parse(row.aggregates), context);
      if (!result.ok && "error" in result && reads && result.error.kind.startsWith("source_")) {
        return sourceFailed(claim, row, result.error);
      }
      if (!result.ok && "limit" in result) {
        if (skipped(claim, subscriber.email, "aggregate_limit")) {
          attention(
            "Sequence step has an aggregate past its limit: skipped",
            `Sequence step ${row.step_id} has an aggregate that is over ${AGGREGATE_LIMIT} events or outside the exact integer range for enrollment ${row.id}; skipped`,
          );
        }
        return;
      }
      if (!result.ok) {
        attention(
          "Sequence aggregates failed: retrying later",
          `Sequence aggregates failed for enrollment ${row.id} at step ${row.step_id} (${result.error.kind}); retrying later`,
        );
        return retry(claim, lateBackoff(row));
      }
      aggregates = result.values;
    }

    // Render with the send UUID fixed first, so its unsubscribe and tracking URLs carry it.
    const settings = options.settings();
    const uuid = crypto.randomUUID();
    const links = messageLinks(
      settings.marketing,
      options.tracking,
    )({
      uuid,
      kind: row.kind,
      subscriberUuid: subscriber.uuid,
    });
    // D126 (r2): unsubscribe_url is marketing mail's; a transactional step carries only manage_url.
    const unsubscribe = row.kind === "marketing" ? (links.unsubscribeUrl ?? "") : "";
    const manage = links.unsubscribeUrl ? `${links.unsubscribeUrl}?manage=true` : "";
    const data = stepDataText({
      subscriber: {
        id: subscriber.id,
        uuid: subscriber.uuid,
        email: subscriber.email,
        name: subscriber.name,
        external_id: subscriber.external_id ?? "",
        attribs: subscriber.attribs,
      },
      trigger: record
        ? {
            name: record.name,
            data: JSON.stringify(record.data),
            occurred_at: record.occurredAt.toISOString(),
          }
        : trigger && !external
          ? { name: trigger.name, data: trigger.data, occurred_at: trigger.occurred_at }
          : null,
      sequence: { id: row.sequence_id, name: row.sequence_name },
      step: {
        id: row.step_id,
        uuid: row.step_uuid,
        position: Number(row.position),
        kind: row.kind,
      },
      aggregates,
      unsubscribe_url: unsubscribe,
      manage_url: manage,
      brand: settings.marketing.brand,
    });
    const subject = row.subject || template.subject;
    let prepared: ReturnType<Sends["prepareSequence"]>;
    try {
      // One budget for the message's render and its generated text part (D118).
      const budget = createMessageBudget();
      const rendered = renderStep(
        compile(
          `${template.id}\n${template.updated_at}\n${marketing}\n${subject}`,
          stepCompileInput(template.body, subject, marketing),
        ),
        data,
        links.tracking,
        budget,
      );
      // The generated text part of an HTML step (B120, D118); none when it has no text.
      const text = await plainText(rendered.body, budget);
      const message: Message = {
        from: settings.fromEmail,
        to: [subscriber.email],
        subject: row.test ? `${TEST_SUBJECT}${rendered.subject}` : rendered.subject,
        contentType: "html",
        body: Buffer.from(rendered.body),
        ...(text ? { altBody: Buffer.from(text) } : {}),
        headers: { ...links.headers },
        attachments: [],
      };
      prepared = sends.prepareSequence(
        {
          uuid,
          source: "sequence",
          kind: row.kind,
          message,
          subscriberId: row.subscriber_id,
          templateId: template.id,
          enrollmentId: row.id,
          stepId: row.step_id,
          listId: marketing ? row.list_id : null,
        },
        subscriber.uuid,
      );
    } catch (error) {
      if (error instanceof RenderCapacityError) {
        return retry(claim, BUSY_MS);
      }
      if (skipped(claim, subscriber.email, "render_failed")) {
        attention(
          "Sequence step could not be rendered: skipped",
          `Sequence step ${row.step_id} could not be rendered for enrollment ${row.id}; skipped`,
        );
      }
      return;
    }

    let queued = false;
    commit(claim, () => {
      if (sends.sequenceSend(row.id, row.step_id)) {
        enrollments.advance(claim, clock.now());
        return;
      }
      const reason = sends.sequenceAdmission(prepared);
      if (reason === "subscriber_unavailable") {
        // The address or identity changed while rendering: render again on the next pass.
        enrollments.release(claim, null);
      } else if (reason === "subscriber_blocklisted") {
        enrollments.endClaimed(claim, "exited", "blocklisted", clock.now());
      } else if (reason === "frequency_cap") {
        if (row.cap_policy === "skip") {
          sends.recordSequence({
            skip: reason,
            kind: row.kind,
            subscriberId: row.subscriber_id,
            toEmail: subscriber.email,
            templateId: template.id,
            enrollmentId: row.id,
            stepId: row.step_id,
            listId: row.list_id,
          });
          enrollments.advance(claim, clock.now());
        } else {
          const floor = new Date(clock.now().getTime() + DEFER_MIN_MS);
          enrollments.defer(claim, sends.capFreeAt(row.subscriber_id, floor));
        }
      } else if (reason) {
        enrollments.endClaimed(claim, "exited", "unsubscribed", clock.now());
      } else {
        sends.recordSequence({ prepared });
        enrollments.advance(claim, clock.now());
        queued = true;
      }
    });
    if (queued) {
      sends.notify();
    }
  }

  const loop = createLoop<{ id: bigint; lease: string }>({
    db,
    clock,
    logger: { error: () => attention("Sequence scheduler failed", "Sequence scheduler failed") },
    intervalMs: SCHEDULER_INTERVAL_MS,
    leaseMs: LEASE_MS,
    batchSize: BATCH,
    signal: options.signal,
    claim: (now, lease, batch) =>
      sendingHeld(db)
        ? []
        : enrollments.claimDue(now, lease, batch).map((id) => ({ id, lease: lease.toISOString() })),
    async process(item) {
      try {
        await decide(item);
      } catch (error) {
        // One failed decision never stops the scheduler: log it and release the claim for a
        // later retry. A broken database still surfaces through the next claim.
        attention(
          "Sequence decision failed: retrying later",
          `Sequence decision failed for enrollment ${item.id}; retrying later`,
          error,
        );
        try {
          writeTransaction(db, () =>
            enrollments.release(item, new Date(clock.now().getTime() + BACKOFF_MIN_MS)),
          );
        } catch {
          /* The lease expires instead. */
        }
      }
      // Most decisions are synchronous: yield to I/O between them so a large due batch does
      // not starve outbox delivery and HTTP on the same thread. This waits for no time.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    },
  });
  return {
    done: loop.done,
    /** Claim promptly, e.g. after an event or manual enroll created a due enrollment. */
    wake: () => loop.wake(),
    start: () => loop.start(),
    /** Stop claiming; resolves after the current decision commits. */
    stop: () => loop.stop(),
  };
}
export type Scheduler = ReturnType<typeof startScheduler>;
