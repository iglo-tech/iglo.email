// Native sequences and enrollments API (docs/design/05-sequences.md, 07-api-and-ui.md);
// no upstream endpoint. Reads need `sequences:get`, and what an enrollment shows of its subscriber
// also needs that subscriber's own read rule; writes need `sequences:manage` and are revalidated
// and validated inside their write transaction, so a permission or definition change cannot
// interleave with them.
import { refuseWhileHeld } from "@/settings/hold";
import { writeTransaction } from "@/db/transaction";
import { parseJson, readBounded } from "@/events/input";
import type { Aggregate } from "@/events/aggregate";
import type { EventStore } from "@/events/store";
import { newMessageId } from "@/messaging/email";
import type { Message } from "@/messaging/email";
import type { createEmailer } from "@/messaging/email";
import type { Sends } from "@/messaging/sends";
import type { TestSends } from "@/messaging/test-sends";
import type { Roles } from "@/roles/roles";
import {
  createMessageBudget,
  RenderCapacityError,
  TemplateSourceError,
} from "@/templates/renderer";
import type { MessageBudget, TemplateRenderer } from "@/templates/renderer";
import { plainText } from "@/messaging/plain";
import type { TemplateStore } from "@/templates/store";
import { parseSampleValue, SampleError } from "@/templates/sample";
import type { Sample } from "@/templates/sample";
import { messageLinks } from "@/unsubscribe/message";
import type { MarketingSettings } from "@/unsubscribe/policy";
import type { Tracking } from "@/unsubscribe/tracking";
import { sanitizeEmail, allowedDomain } from "@/subscribers/email";
import { renderStep, stepCompileInput, stepDataText, TEST_SUBJECT } from "@/sequences/step-data";
import { FieldError, StepRefusal, stepPreview } from "@/sequences/step-preview";
import {
  idValue,
  DefinitionError,
  definitionInput,
  limits,
  sequenceStatuses,
} from "@/sequences/input";
import type { SequenceStatus } from "@/sequences/input";
import { project } from "@/sequences/enrollments";
import type {
  EnrollmentFilter,
  EnrollmentRow,
  Enrollments,
  TriggerEvent,
} from "@/sequences/enrollments";
import { validate } from "@/conditions/validate";
import { compile } from "@/conditions/compile";
import { SequenceConflict } from "@/sequences/store";
import type { SequenceStore } from "@/sequences/store";
import { timeline } from "@/sequences/timeline";
import type { RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { getID, hasID } from "@/server/validation";
import { readableSubscribers } from "@/subscribers/routes";
import type { SubscriberStore } from "@/subscribers/store";
import type { Authentication } from "@/users/auth";

const GET = "sequences:get";
const MANAGE = "sequences:manage";
/** Small bodies: status changes and manual enrolls. */
const SMALL_BODY_BYTES = 4 * 1024;
const enrollmentStatuses = new Set(["active", "completed", "exited", "canceled"]);
const MAX_EXIT_REASON = 256;
/** Enrollments rescheduled per write transaction, so the write lock is held briefly. */
export const RESCHEDULE_BATCH = 500;
/** Request bodies of live condition validation; a save allows more, this is per keystroke. */
const VALIDATE_BODY_BYTES = 64 * 1024;
/** A preview or test body: IDs and a sample, whose data is bounded at 256 KiB (template data). */
const PREVIEW_BODY_BYTES = 512 * 1024;
/** Addresses one test send mails, and test sends in flight, as campaign tests bound theirs. */
const MAX_TEST_EMAILS = 5;
const MAX_TEST_SENDS = 4;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** A step or template ID as the API numbers it: a number, or a raw JSON integer beyond 2^53. */
const idOf = (value: number | object): bigint =>
  BigInt(typeof value === "number" ? value : (value as { rawJSON: string }).rawJSON);

export function registerSequenceRoutes(
  router: Router,
  deps: {
    sequences: SequenceStore;
    enrollments: Enrollments;
    subscribers: Pick<SubscriberStore, "get" | "readable" | "byEmail">;
    events: Pick<EventStore, "get" | "latest" | "aggregate">;
    sends: Pick<Sends, "marketingReason" | "enrollmentSends">;
    templates: Pick<TemplateStore, "get">;
    renderer: TemplateRenderer;
    emailer: Pick<ReturnType<typeof createEmailer>, "push">;
    /** Each test message's Message-ID, so a notice of it is named in the log (B108). */
    testSends: TestSends;
    tracking: Tracking;
    /** Settings a preview or test send reads: the default sender, marketing links, domain rules. */
    settings: () => {
      fromEmail: string;
      marketing: MarketingSettings;
      domainAllowlist: string[];
      domainBlocklist: string[];
    };
    roles: Roles;
    auth: Authentication;
  },
) {
  const { sequences, enrollments, subscribers, events, sends, templates, roles, auth, testSends } =
    deps;
  const invalid = (c: RequestContext, field: string, detail?: string) =>
    new HttpError(
      400,
      c.app.i18n.Ts(
        "globals.messages.invalidFields",
        "name",
        detail ? `${field} (${detail})` : field,
      ),
    );
  const body = async (c: RequestContext, limit: number) => {
    const value = parseJson(c.request, await readBounded(c.request, limit));
    if (!isObject(value)) throw invalid(c, "body");
    return value;
  };
  const identity = (c: RequestContext) => {
    if (!c.identity) throw new Error("Identity required");
    return c.identity;
  };
  /** Validate a definition and write it, both inside one write transaction. */
  const save = (
    c: RequestContext,
    value: unknown,
    write: (input: ReturnType<typeof definitionInput>) => unknown,
  ) =>
    writeTransaction(c.app.db, () => {
      auth.revalidate(c, MANAGE);
      const i = identity(c);
      try {
        const input = definitionInput(value, {
          canUseSql: roles.can(i.role, "subscribers:sql_query"),
          templateType: sequences.templateType,
          listUsable: (id) =>
            sequences.listExists(id) &&
            (roles.canList(i.role, i.user.list_role_id, "list:get", [id]) ||
              roles.canList(i.role, i.user.list_role_id, "list:manage", [id])),
        });
        return write(input);
      } catch (error) {
        if (error instanceof DefinitionError || error instanceof SequenceConflict)
          throw invalid(c, error.field, error.detail);
        throw error;
      }
    });
  const params = (c: RequestContext) => {
    const search = c.url.searchParams;
    const one = (key: string) => {
      const values = search.getAll(key);
      if (values.length > 1) throw invalid(c, key);
      return values[0];
    };
    const positive = (key: string, max: bigint) => {
      const raw = one(key);
      if (raw === undefined) return undefined;
      if (!/^[1-9]\d{0,18}$/.test(raw) || BigInt(raw) > max) throw invalid(c, key);
      return BigInt(raw);
    };
    return { one, positive };
  };
  const paging = (c: RequestContext) => {
    const { positive } = params(c);
    return {
      page: Number(positive("page", 1_000_000n) ?? 1n),
      perPage: Number(positive("per_page", 100n) ?? 20n),
    };
  };
  const maxID = 9223372036854775807n;
  /** Enrollments name their subscriber by ID; anything of the person follows the owner's rule. */
  const readable = (c: RequestContext, rows: EnrollmentRow[]) =>
    readableSubscribers(roles, subscribers, identity(c), [
      ...new Set(rows.map((row) => row.subscriber_id)),
    ]);
  const addressed = (row: EnrollmentRow, addresses: Map<bigint, string>) => {
    const email = addresses.get(row.subscriber_id);
    return { ...project(row), ...(email === undefined ? {} : { subscriber_email: email }) };
  };

  router.route(
    "GET",
    "/api/sequences",
    (c) => {
      const status = params(c).one("status");
      if (status !== undefined && !(sequenceStatuses as readonly string[]).includes(status))
        throw invalid(c, "status");
      return ok(
        sequences.list({
          ...paging(c),
          ...(status === undefined ? {} : { status }),
        }),
      );
    },
    auth.middleware(GET),
  );
  router.route(
    "GET",
    "/api/sequences/:id",
    (c) => {
      const found = sequences.get(BigInt(getID(c)));
      if (!found) throw new HttpError(404, "Sequence not found");
      return ok(found);
    },
    auth.middleware(GET),
    hasID,
  );
  router.route(
    "POST",
    "/api/sequences",
    async (c) => {
      const value = await body(c, limits.bodyBytes);
      return ok(save(c, value, (input) => sequences.create(input)));
    },
    auth.middleware(MANAGE),
  );
  router.route(
    "PUT",
    "/api/sequences/:id",
    async (c) => {
      const value = await body(c, limits.bodyBytes);
      const id = BigInt(getID(c));
      const saved = save(c, value, (input) => sequences.update(id, input));
      if (!saved) throw new HttpError(404, "Sequence not found");
      return ok(saved);
    },
    auth.middleware(MANAGE),
    hasID,
  );
  router.route(
    "PUT",
    "/api/sequences/:id/status",
    async (c) => {
      const value = await body(c, SMALL_BODY_BYTES);
      const status = value.status;
      if (typeof status !== "string" || !(sequenceStatuses as readonly string[]).includes(status))
        throw invalid(c, "status");
      const id = BigInt(getID(c));
      const saved = writeTransaction(c.app.db, () => {
        auth.revalidate(c, MANAGE);
        try {
          return sequences.setStatus(id, status as SequenceStatus);
        } catch (error) {
          if (error instanceof SequenceConflict) throw invalid(c, error.field, error.detail);
          throw error;
        }
      });
      if (!saved) throw new HttpError(404, "Sequence not found");
      return ok(saved);
    },
    auth.middleware(MANAGE),
    hasID,
  );
  router.route(
    "POST",
    "/api/conditions/validate",
    async (c) => {
      const value = await body(c, VALIDATE_BODY_BYTES);
      const field = value.field === undefined ? "condition" : value.field;
      if (typeof field !== "string" || !/^[A-Za-z0-9_.]{1,64}$/.test(field))
        throw invalid(c, "field");
      if (!("condition" in value)) throw invalid(c, "condition");
      // A save reads null as "no condition", so null is valid here too.
      if (value.condition === null) return ok({ ok: true, errors: [] });
      const result = validate(value.condition, {
        canUseSql: roles.can(identity(c).role, "subscribers:sql_query"),
        field,
      });
      if (!result.ok) return ok({ ok: false, errors: result.errors });
      // The compiler is what a save's evaluator will run; it touches no data.
      try {
        compile(result.condition);
      } catch {
        return ok({ ok: false, errors: [{ field, message: "invalid condition" }] });
      }
      return ok({ ok: true, errors: [] });
    },
    auth.middleware(MANAGE),
  );
  router.route(
    "POST",
    "/api/sequences/:id/steps/:step/reschedule",
    async (c) => {
      const stepRaw = c.params.step ?? "";
      if (!/^[1-9]\d{0,18}$/.test(stepRaw) || BigInt(stepRaw) > maxID) throw invalid(c, "step");
      const stepId = BigInt(stepRaw);
      const id = BigInt(getID(c));
      let cursor = 0n,
        changed = 0,
        dueNow = false,
        first = true;
      for (;;) {
        const batch = writeTransaction(c.app.db, () => {
          auth.revalidate(c, MANAGE);
          return enrollments.rescheduleBatch(id, stepId, cursor, RESCHEDULE_BATCH);
        });
        // A step deleted while batches ran has nothing left to move: the request reports the rows
        // already changed. Only a step that was never there is a 404.
        if (batch === "missing") {
          if (first) throw new HttpError(404, "Step not found");
          break;
        }
        first = false;
        changed += batch.changed;
        dueNow ||= batch.dueNow;
        if (batch.next === null) break;
        cursor = batch.next;
        // Let the scheduler and other requests take the write lock between batches.
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (dueNow) enrollments.wake();
      return ok({ changed });
    },
    auth.middleware(MANAGE),
    hasID,
  );
  /** The body of a preview or test: optional IDs and a sample, and `emails` for a test. */
  const previewBody = async (c: RequestContext, extra: readonly string[] = []) => {
    const bytes = await readBounded(c.request, PREVIEW_BODY_BYTES);
    const value = bytes.length === 0 ? {} : parseJson(c.request, bytes);
    if (!isObject(value)) throw invalid(c, "body");
    for (const key of Object.keys(value))
      if (!["subscriber_id", "trigger_event_id", "sample", ...extra].includes(key))
        throw invalid(c, key);
    const id = (field: "subscriber_id" | "trigger_event_id") => {
      try {
        return idValue(value[field], field) ?? null;
      } catch (error) {
        if (error instanceof DefinitionError) throw invalid(c, field);
        throw error;
      }
    };
    let sample: Sample | undefined;
    if (value.sample !== undefined) {
      try {
        sample = parseSampleValue(value.sample, { data: false });
      } catch (error) {
        if (error instanceof SampleError) throw invalid(c, error.field);
        throw error;
      }
    }
    return {
      subscriberId: id("subscriber_id"),
      triggerEventId: id("trigger_event_id"),
      sample,
      emails: value.emails,
    };
  };
  /** The step named by the path, with its sequence; 400 for a malformed step, else 404 when
   * either is not there. The step's form is checked first, as the reschedule route does. */
  const stepOf = (c: RequestContext) => {
    const raw = c.params.step ?? "";
    if (!/^[1-9]\d{0,18}$/.test(raw) || BigInt(raw) > maxID) throw invalid(c, "step");
    const sequence = sequences.get(BigInt(getID(c)));
    if (!sequence) throw new HttpError(404, "Sequence not found");
    const found = sequence.steps.find((step) => idOf(step.id) === BigInt(raw));
    if (!found) throw new HttpError(404, "Step not found");
    return { sequence, step: found };
  };
  /** A subscriber the caller can read, or null for none named; anything else is absent (D103). */
  const subscriberNamed = (c: RequestContext, id: bigint | null) => {
    if (id === null) return null;
    const row = subscribers.get(id);
    if (!row || !readableSubscribers(roles, subscribers, identity(c), [id]).has(id))
      throw new HttpError(404, "Subscriber not found");
    return row;
  };
  /** The step's template, which must be transactional: a step sends one (05-sequences.md). */
  const stepTemplate = (step: { template_id: number | object | null }) => {
    const template = step.template_id === null ? null : templates.get(idOf(step.template_id));
    if (!template || template.type !== "tx")
      throw new HttpError(409, "The step does not send a transactional template.");
    return template;
  };
  /** The data a send of this step would render for the request, as the scheduler builds it (D105). */
  const previewFor = (
    c: RequestContext,
    value: Awaited<ReturnType<typeof previewBody>>,
    step: NonNullable<ReturnType<typeof stepOf>["step"]>,
    sequence: NonNullable<ReturnType<typeof sequences.get>>,
    recipient?: string,
  ) => {
    const row = subscriberNamed(c, value.subscriberId);
    const settings = deps.settings();
    try {
      return stepPreview(
        {
          sequence: {
            id: idOf(sequence.id),
            name: sequence.name,
            event: (sequence.trigger as { event: string }).event,
          },
          step: {
            id: idOf(step.id),
            uuid: step.uuid,
            position: step.position,
            kind: step.kind,
            aggregates: (step.aggregates ?? {}) as Record<string, Aggregate>,
          },
          subscriber: row,
          triggerEventId: value.triggerEventId,
          sample: value.sample,
          ...(recipient === undefined ? {} : { recipient }),
          now: c.app.clock.now(),
        },
        events,
        messageLinks(settings.marketing, deps.tracking),
      );
    } catch (error) {
      if (error instanceof FieldError) throw invalid(c, error.field);
      if (error instanceof StepRefusal) throw new HttpError(409, error.message);
      throw error;
    }
  };
  /** Renders the step's template with its data, as a send does; the step's subject wins. */
  const renderStepFor = (
    c: RequestContext,
    step: { subject: string | null; kind: string },
    template: { body: string; subject: string },
    data: string,
    budget?: MessageBudget,
  ) => {
    const i18n = c.app.i18n;
    try {
      const subject = step.subject || template.subject;
      return renderStep(
        deps.renderer.compile(stepCompileInput(template.body, subject, step.kind === "marketing")),
        data,
        undefined,
        budget,
      );
    } catch (error) {
      if (error instanceof RenderCapacityError)
        throw new HttpError(429, "Too many template renders in progress.");
      if (error instanceof TemplateSourceError)
        throw new HttpError(400, i18n.Ts("templates.errorCompiling", "error", "invalid body"));
      throw new HttpError(400, i18n.Ts("templates.errorRendering", "error", "invalid template"));
    }
  };

  router.route(
    "POST",
    "/api/sequences/:id/steps/:step/preview",
    async (c) => {
      const value = await previewBody(c);
      // The body was read after the caller was authorized: its permissions are checked again
      // before its subscriber is resolved, so a revocation during the upload counts (D103).
      auth.revalidate(c, GET);
      const { sequence, step } = stepOf(c);
      const template = stepTemplate(step);
      const prepared = previewFor(c, value, step, sequence);
      const data = stepDataText(prepared.data);
      const rendered = renderStepFor(c, step, template, data);
      return ok({
        subject: rendered.subject,
        body: rendered.body,
        // The exact context rendered, with integers beyond 2^53 kept exact.
        context: JSON.parse(data, (_key, item, source?: { source?: string }) =>
          typeof item === "number" && !Number.isSafeInteger(item) && source?.source
            ? (JSON as typeof JSON & { rawJSON(text: string): object }).rawJSON(source.source)
            : item,
        ) as unknown,
      });
    },
    auth.middleware(GET),
    hasID,
  );
  let testing = 0;
  router.route(
    "POST",
    "/api/sequences/:id/steps/:step/test",
    async (c) => {
      refuseWhileHeld(c.app.db);
      const value = await previewBody(c, ["emails"]);
      // As for the preview: the permissions are checked again once the body is read, before the
      // subscriber is resolved and before anything renders (and again right before sending).
      auth.revalidate(c, "tx:send");
      auth.revalidate(c, MANAGE);
      const addresses = testAddresses(c, value.emails);
      const { sequence, step } = stepOf(c);
      const template = stepTemplate(step);
      if (testing >= MAX_TEST_SENDS)
        throw new HttpError(429, "Too many test sends in progress.", { "Retry-After": "1" });
      // A blocklisted address never receives mail (04-sending.md), so it is skipped.
      const reachable = addresses.filter(
        (email) => subscribers.byEmail(email)?.status !== "blocklisted",
      );
      // B108 (D114): every address blocklisted says so, and names the addresses the caller gave.
      if (!reachable.length)
        throw new HttpError(400, `No recipients: blocklisted: ${addresses.join(", ")}`);
      testing++;
      let queued = false;
      try {
        const settings = deps.settings();
        const messages: Message[] = [];
        for (const email of reachable) {
          const prepared = previewFor(c, value, step, sequence, email);
          const data = stepDataText(prepared.data);
          // One budget for the message's render and its generated text part (D118).
          const budget = createMessageBudget();
          const rendered = renderStepFor(c, step, template, data, budget);
          // The generated text part of an HTML step (B120, D118); none when it has no text.
          const text = await plainText(rendered.body, budget);
          messages.push({
            from: settings.fromEmail,
            to: [email],
            subject: `${TEST_SUBJECT}${rendered.subject}`,
            contentType: "html",
            body: Buffer.from(rendered.body),
            ...(text ? { altBody: Buffer.from(text) } : {}),
            headers: { ...prepared.links.headers },
            // B108 (D114): chosen here, so its record is written before the message is queued.
            messageId: newMessageId(settings.marketing.rootUrl),
          });
        }
        // The sender may have changed its mind while these rendered: the permission is checked again.
        auth.revalidate(c, "tx:send");
        auth.revalidate(c, MANAGE);
        // B108 (D114): every Message-ID is recorded before any message is handed to the emailer. A
        // failed write throws here, so nothing is sent and the request answers 500.
        writeTransaction(c.app.db, () =>
          testSends.record(
            messages.map((message) => ({
              messageId: message.messageId!,
              kind: "sequence_step",
              campaign_id: null,
              sequence_id: Number(sequence.id),
              step_id: Number(step.id),
            })),
          ),
        );
        // Queued to the emailer like a campaign test: nothing is journaled, counted or tracked. Its
        // own pool (B101), and an undelivered outcome is logged (B101): `result` never rejects.
        const dispatched = messages.map((message) => ({
          message,
          dispatch: deps.emailer.push(message, {
            copies: false,
            priority: "outbox",
            testPool: true,
          }),
        }));
        const results = dispatched.map(({ message, dispatch }) =>
          dispatch.result.then((outcome) => {
            if (outcome.status === "accepted" && !outcome.rejected.length) return;
            c.app.logger.attention(
              `Test send to ${message.to[0]} for sequence ${sequence.id} step ${step.id} not delivered: ${outcome.status}, stage ${outcome.stage}`,
              "Test send not delivered: the server error output names the recipient and stage",
            );
          }),
        );
        queued = true;
        void Promise.all(results).finally(() => testing--);
        return ok(true);
      } finally {
        if (!queued) testing--;
      }
    },
    auth.middleware(MANAGE),
    hasID,
  );
  /** The test recipients: 1 to 5 distinct addresses, validated as a subscriber's are. */
  function testAddresses(c: RequestContext, value: unknown): string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TEST_EMAILS)
      throw invalid(c, "emails");
    const policy = deps.settings();
    const seen = new Set<string>();
    for (const raw of value) {
      const email = typeof raw === "string" ? sanitizeEmail(raw) : undefined;
      if (
        email === undefined ||
        /[\r\n\0]/.test(email) ||
        !allowedDomain(email, policy.domainAllowlist, policy.domainBlocklist) ||
        seen.has(email)
      )
        throw invalid(c, "emails");
      seen.add(email);
    }
    return [...seen];
  }

  router.route(
    "DELETE",
    "/api/sequences/:id",
    (c) => {
      const id = BigInt(getID(c));
      const result = writeTransaction(c.app.db, () => {
        auth.revalidate(c, MANAGE);
        return sequences.remove(id);
      });
      if (result === "missing") throw new HttpError(404, "Sequence not found");
      if (result === "enrolled")
        throw new HttpError(409, "The sequence has enrollments; archive it instead.");
      return ok(true);
    },
    auth.middleware(MANAGE),
    hasID,
  );

  router.route(
    "GET",
    "/api/enrollments",
    (c) => {
      const { one, positive } = params(c);
      const filter: EnrollmentFilter = paging(c);
      const sequenceId = positive("sequence_id", maxID),
        subscriberId = positive("subscriber_id", maxID),
        status = one("status"),
        exitReason = one("exit_reason");
      if (status !== undefined && !enrollmentStatuses.has(status)) {
        throw invalid(c, "status");
      }
      if (exitReason !== undefined && (!exitReason || exitReason.length > MAX_EXIT_REASON)) {
        throw invalid(c, "exit_reason");
      }
      if (sequenceId !== undefined) {
        filter.sequenceId = sequenceId;
      }
      if (subscriberId !== undefined) {
        filter.subscriberId = subscriberId;
      }
      if (status !== undefined) {
        filter.status = status;
      }
      if (exitReason !== undefined) {
        filter.exitReason = exitReason;
      }
      return ok(
        enrollments.list(filter, (rows) => {
          const addresses = readable(c, rows);
          return rows.map((row) => addressed(row, addresses));
        }),
      );
    },
    auth.middleware(GET),
  );
  router.route(
    "GET",
    "/api/enrollments/:id",
    (c) => {
      const row = enrollments.get(BigInt(getID(c)));
      if (!row) {
        throw new HttpError(404, "Enrollment not found");
      }
      return ok(addressed(row, readable(c, [row])));
    },
    auth.middleware(GET),
    hasID,
  );
  router.route(
    "GET",
    "/api/enrollments/:id/timeline",
    (c) => {
      const row = enrollments.get(BigInt(getID(c)));
      if (!row) {
        throw new HttpError(404, "Enrollment not found");
      }
      const addresses = readable(c, [row]);
      return ok({
        enrollment: addressed(row, addresses),
        entries: timeline(
          row,
          row.trigger_event_id !== null && addresses.has(row.subscriber_id)
            ? events.get(row.trigger_event_id)
            : null,
          enrollments.steps(row.sequence_id),
          sends.enrollmentSends(row.id),
        ),
      });
    },
    auth.middleware(GET),
    hasID,
  );
  router.route(
    "POST",
    "/api/enrollments",
    async (c) => {
      const value = await body(c, SMALL_BODY_BYTES);
      let sequenceId: bigint | undefined, subscriberId: bigint | undefined;
      let triggerEventId: bigint | undefined;
      try {
        sequenceId = idValue(value.sequence_id, "sequence_id");
        subscriberId = idValue(value.subscriber_id, "subscriber_id");
        triggerEventId = idValue(value.trigger_event_id, "trigger_event_id");
      } catch (error) {
        if (error instanceof DefinitionError) {
          throw invalid(c, error.field);
        }
        throw error;
      }
      if (sequenceId === undefined) {
        throw invalid(c, "sequence_id");
      }
      if (subscriberId === undefined) {
        throw invalid(c, "subscriber_id");
      }
      if (value.force !== undefined && typeof value.force !== "boolean") {
        throw invalid(c, "force");
      }
      if (value.test !== undefined && typeof value.test !== "boolean") {
        throw invalid(c, "test");
      }
      const force = value.force === true;
      const test = value.test === true;
      // A test never replaces anything, which is what `force` asks for.
      if (test && force) {
        throw invalid(c, "force");
      }
      if (test) {
        refuseWhileHeld(c.app.db);
      }
      const outcome = writeTransaction(c.app.db, () => {
        auth.revalidate(c, MANAGE);
        const subscriber = subscribers.get(subscriberId);
        if (!subscriber) {
          throw new HttpError(404, "Subscriber not found");
        }
        // D103: a subscriber the caller cannot read under GET's rule is absent to it, so the
        // answer and the write it refuses match an absent subscriber's.
        if (
          !readableSubscribers(roles, subscribers, identity(c), [subscriberId]).has(subscriberId)
        ) {
          throw new HttpError(404, "Subscriber not found");
        }
        if (subscriber.status === "blocklisted") {
          throw new HttpError(409, "The subscriber is blocklisted.");
        }
        // An existing event the enrollment starts from (D101); an unknown one is refused here.
        let trigger: TriggerEvent | null = null;
        if (triggerEventId !== undefined) {
          const event = events.get(triggerEventId);
          if (!event) {
            throw invalid(c, "trigger_event_id");
          }
          trigger = { id: event.id, subscriber_id: event.subscriber_id, name: event.name };
        }
        return test
          ? enrollments.enrollTest(
              sequenceId,
              subscriberId,
              (list) => sends.marketingReason(subscriberId, list),
              trigger,
            )
          : enrollments.enroll(sequenceId, subscriberId, force, trigger);
      });
      if ("enrollment" in outcome) {
        return ok(project(outcome.enrollment));
      }
      if (outcome.error === "sequence_missing") {
        throw new HttpError(404, "Sequence not found");
      }
      if (outcome.error === "trigger_event") {
        throw invalid(c, "trigger_event_id");
      }
      if (outcome.error === "sequence_inactive") {
        throw new HttpError(409, "The sequence is not active.");
      }
      if (outcome.error === "no_steps") {
        throw new HttpError(409, "The sequence has no steps.");
      }
      if (outcome.error === "test_running") {
        throw new HttpError(409, "A test of this sequence is already running for this subscriber.");
      }
      if (outcome.error === "no_consent") {
        throw new HttpError(
          409,
          `The subscriber can't receive this sequence's marketing steps (${outcome.reason}).`,
        );
      }
      throw new HttpError(409, "The sequence's reentry rule does not allow this enrollment.");
    },
    auth.middleware(MANAGE),
  );
  router.route(
    "DELETE",
    "/api/enrollments/:id",
    (c) => {
      const id = BigInt(getID(c));
      const result = writeTransaction(c.app.db, () => {
        auth.revalidate(c, MANAGE);
        return enrollments.cancel(id);
      });
      if (result === "missing") {
        throw new HttpError(404, "Enrollment not found");
      }
      if (result === "inactive") {
        throw new HttpError(409, "The enrollment is not active.");
      }
      return ok(project(result));
    },
    auth.middleware(MANAGE),
    hasID,
  );
}
