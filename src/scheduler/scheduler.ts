// Native sequence scheduler (docs/design/05-sequences.md#scheduler, #template-data;
// 04-sending.md#outbox, #frequency-cap, #unsubscribe); no upstream source. Enrollment SQL is
// owned by src/sequences, send rows and marketing admission by src/messaging, and delivery by
// the outbox: this loop only decides, renders and commits each decision in one short write.
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "@/app";
import type { Clock } from "@/clock";
import type { ConditionEvaluator } from "@/conditions/evaluate";
import { parseDuration } from "@/conditions/duration";
import { writeTransaction } from "@/db/transaction";
import type { EventStore } from "@/events/store";
import { startLoop } from "@/loops/loop";
import type { SafeMessage } from "@/maintenance/log-buffer";
import type { Message } from "@/messaging/email";
import type { Sends } from "@/messaging/sends";
import {
  numberID,
  type Claim,
  type Enrollments,
  type SchedulerContext,
} from "@/sequences/enrollments";
import type { SubscriberStore } from "@/subscribers/store";
import { RenderCapacityError, type TemplateRenderer } from "@/templates/renderer";
import type { TemplateStore } from "@/templates/store";
import { messageLinks } from "@/unsubscribe/message";
import type { MarketingSettings } from "@/unsubscribe/policy";
import type { Tracking } from "@/unsubscribe/tracking";

export const SCHEDULER_INTERVAL_MS = 15_000;
const LEASE_MS = 5 * 60_000;
const BATCH = 100;
/** Marketing steps without `max_late` skip what is more than two days late. */
const MARKETING_MAX_LATE = "P2D";
/** Condition errors retry after the time already spent late, between these bounds. */
const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;
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
  "on_false",
  "cap_policy",
  "max_late",
  "list_id",
] as const satisfies readonly (keyof SchedulerContext)[];

/** A claim with the full context its decision read. */
interface Decision extends Claim {
  step: SchedulerContext;
}

export interface SchedulerSettings {
  /** Default sender (`app.from_email`'s first address). */
  fromEmail: string;
  marketing: MarketingSettings;
}

export function startScheduler(options: {
  db: Database;
  clock: Clock;
  logger: ErrorLogger;
  enrollments: Enrollments;
  sends: Sends;
  subscribers: Pick<SubscriberStore, "get">;
  templates: Pick<TemplateStore, "get">;
  events: Pick<EventStore, "get">;
  renderer: TemplateRenderer;
  tracking: Tracking;
  conditions: Pick<ConditionEvaluator, "evaluate">;
  settings: () => SchedulerSettings;
  signal?: AbortSignal;
}) {
  const { db, clock, logger, enrollments, sends } = options;
  const attention = (safe: SafeMessage, message: string, cause?: unknown) => {
    try {
      logger.error(cause === undefined ? new Error(message) : new Error(message, { cause }), safe);
    } catch {
      /* Logging never changes a decision. */
    }
  };
  const compiled = new Map<string, ReturnType<TemplateRenderer["compile"]>>();
  function compile(key: string, input: Parameters<TemplateRenderer["compile"]>[0]) {
    let template = compiled.get(key);
    if (template) compiled.delete(key);
    else template = options.renderer.compile(input);
    compiled.set(key, template);
    if (compiled.size > COMPILED) compiled.delete(compiled.keys().next().value!);
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
      if (!enrollments.owns(claim)) return false;
      const current = enrollments.schedulerContext(claim.id);
      if (!current) return false;
      if (current.sequence_status !== claim.step.sequence_status) {
        if (current.sequence_status === "archived")
          enrollments.endClaimed(claim, "canceled", "sequence_archived", clock.now());
        else enrollments.release(claim, null);
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
  function skipped(claim: Decision, email: string, reason: string) {
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
      enrollments.advance(claim, clock.now());
    });
  }
  const advance = (claim: Decision) => commit(claim, () => enrollments.advance(claim, clock.now()));
  const end = (claim: Decision, status: "canceled" | "exited", reason: string) =>
    commit(claim, () => enrollments.endClaimed(claim, status, reason, clock.now()));
  const retry = (claim: Decision, ms: number) =>
    commit(claim, () => enrollments.release(claim, new Date(clock.now().getTime() + ms)));
  const capped = (claim: Decision, email: string) =>
    claim.step.cap_policy === "skip"
      ? skipped(claim, email, "frequency_cap")
      : commit(claim, (row) => {
          const floor = new Date(clock.now().getTime() + DEFER_MIN_MS);
          enrollments.defer(claim, sends.capFreeAt(row.subscriber_id, floor));
        });

  async function decide(item: { id: bigint; lease: string }) {
    const row = enrollments.schedulerContext(item.id);
    if (!row || row.status !== "active" || row.claimed_until !== item.lease) return;
    const claim: Decision = { id: row.id, lease: item.lease, step: row };
    const now = clock.now();
    // A send already recorded for this step (a crash before the advance, or a step revisited
    // after a reorder) is never written or sent again: only advance.
    if (sends.sequenceSend(row.id, row.step_id)) return advance(claim);
    if (row.sequence_status === "archived") return end(claim, "canceled", "sequence_archived");
    // Paused (or returned to draft) after the claim: release it; it runs when resumed.
    if (row.sequence_status !== "active")
      return commit(claim, () => enrollments.release(claim, null));
    const subscriber = options.subscribers.get(row.subscriber_id);
    if (!subscriber) return end(claim, "canceled", "subscriber_deleted");
    if (subscriber.status === "blocklisted") return end(claim, "canceled", "blocklisted");
    if (row.step_status === "deleted") return advance(claim);
    const maxLate = row.max_late ?? (row.kind === "marketing" ? MARKETING_MAX_LATE : null);
    const late = maxLate === null ? undefined : parseDuration(maxLate);
    if (late !== undefined && now.getTime() > Date.parse(row.due_at) + late)
      return skipped(claim, subscriber.email, "late");
    const marketing = row.kind === "marketing";
    if (marketing) {
      const reason = sends.marketingReason(row.subscriber_id, row.list_id);
      if (reason && reason !== "frequency_cap") return end(claim, "exited", "unsubscribed");
    }

    const trigger = row.trigger_event_id === null ? null : options.events.get(row.trigger_event_id);
    if (row.condition !== null) {
      const result = await options.conditions.evaluate(JSON.parse(row.condition), {
        subscriberId: row.subscriber_id,
        // A manual enrollment (or one whose trigger event expired) counts from its start.
        triggerAt: trigger?.occurred_at ?? row.created_at,
        enrolledAt: row.created_at,
        lastStepAt: row.updated_at > row.created_at ? row.updated_at : null,
        now,
      });
      if (!result.ok) {
        const lateMs = clock.now().getTime() - Date.parse(row.due_at);
        const backoff = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, lateMs));
        attention(
          "Sequence condition failed: retrying later",
          `Sequence condition failed for enrollment ${row.id} at step ${row.step_id} (${result.error.kind}); retrying later`,
        );
        return retry(claim, backoff);
      }
      if (!result.value)
        return row.on_false === "skip" ? advance(claim) : end(claim, "exited", "condition");
    }

    const template = row.template_id === null ? null : options.templates.get(row.template_id);
    if (!template || template.type !== "tx") {
      // Logged once, when recorded: a template deleted during the condition is a stale
      // decision, released and decided again.
      if (skipped(claim, subscriber.email, "template_unavailable"))
        attention(
          "Sequence step has no transactional template: skipped",
          `Sequence step ${row.step_id} has no transactional template; enrollment ${row.id} skipped it`,
        );
      return;
    }
    if (marketing) {
      // Rechecked after the condition, which may have waited on the query runner.
      const reason = sends.marketingReason(row.subscriber_id, row.list_id);
      if (reason === "frequency_cap") return capped(claim, subscriber.email);
      if (reason) return end(claim, "exited", "unsubscribed");
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
    const unsubscribe = links.unsubscribeUrl ?? "";
    const id = (value: bigint) => JSON.stringify(numberID(value));
    const data =
      `{"subscriber":{"id":${id(subscriber.id)},"uuid":${JSON.stringify(subscriber.uuid)},` +
      `"email":${JSON.stringify(subscriber.email)},"name":${JSON.stringify(subscriber.name)},` +
      `"external_id":${JSON.stringify(subscriber.external_id ?? "")},"attribs":${subscriber.attribs}},` +
      `"trigger":${
        trigger
          ? `{"name":${JSON.stringify(trigger.name)},"data":${trigger.data},"occurred_at":${JSON.stringify(trigger.occurred_at)}}`
          : "null"
      },` +
      `"sequence":{"id":${id(row.sequence_id)},"name":${JSON.stringify(row.sequence_name)}},` +
      `"step":{"id":${id(row.step_id)},"uuid":${JSON.stringify(row.step_uuid)},"position":${Number(row.position)},"kind":${JSON.stringify(row.kind)}},` +
      `"unsubscribe_url":${JSON.stringify(unsubscribe)},` +
      `"manage_url":${JSON.stringify(unsubscribe ? `${unsubscribe}?manage=true` : "")}}`;
    const subject = row.subject || template.subject;
    let prepared: ReturnType<Sends["prepareSequence"]>;
    try {
      const rendered = compile(`${template.id}\n${template.updated_at}\n${marketing}\n${subject}`, {
        mode: "html",
        transactional: !marketing,
        body: template.body,
        subject,
      }).renderSync(data, links.tracking);
      if (/[\r\n\0]/.test(rendered.subject)) throw new Error("Invalid subject");
      const message: Message = {
        from: settings.fromEmail,
        to: [subscriber.email],
        subject: rendered.subject,
        contentType: "html",
        body: Buffer.from(rendered.body),
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
      if (error instanceof RenderCapacityError) return retry(claim, BUSY_MS);
      if (skipped(claim, subscriber.email, "render_failed"))
        attention(
          "Sequence step could not be rendered: skipped",
          `Sequence step ${row.step_id} could not be rendered for enrollment ${row.id}; skipped`,
        );
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
        enrollments.endClaimed(claim, "canceled", "blocklisted", clock.now());
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
    if (queued) sends.notify();
  }

  const loop = startLoop<{ id: bigint; lease: string }>({
    db,
    clock,
    logger: { error: () => attention("Sequence scheduler failed", "Sequence scheduler failed") },
    intervalMs: SCHEDULER_INTERVAL_MS,
    leaseMs: LEASE_MS,
    batchSize: BATCH,
    signal: options.signal,
    claim: (now, lease, batch) =>
      enrollments.claimDue(now, lease, batch).map((id) => ({ id, lease: lease.toISOString() })),
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
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  return {
    done: loop.done,
    /** Claim promptly, e.g. after an event or manual enroll created a due enrollment. */
    wake: () => loop.wake(),
    /** Stop claiming; resolves after the current decision commits. */
    stop: () => loop.stop(),
  };
}
export type Scheduler = ReturnType<typeof startScheduler>;
