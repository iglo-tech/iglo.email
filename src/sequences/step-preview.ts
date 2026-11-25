// The render context of a sequence step's preview and test send (docs/design/05-sequences.md
// #preview-and-test-send, D105): the subscriber, trigger, aggregates and links a real send would
// use, with a sample replacing the named parts. Reads only; the routes decide what to do with it.
// No upstream source.
import { aggregateOnSource } from "@/conditions/source";
import type { SourceReads } from "@/conditions/source";
import type { Aggregate, AggregateResult } from "@/events/aggregate";
import type { EventRow, EventStore } from "@/events/store";
import { dummyUUID } from "@/campaigns/render";
import { must } from "@/invariant";
import type { PreparedLinks } from "@/unsubscribe/message";
import type { Sample } from "@/templates/sample";
import type { BrandSite } from "@/public/brand";
import type { StepData } from "@/sequences/step-data";
import { SourceError } from "@/sources/source";
import type { ExternalSource } from "@/sources/source";

/** A request field that names no valid value. `field` is what the API reports. */
export class FieldError extends Error {
  constructor(readonly field: string) {
    super(`Invalid fields: ${field}`);
  }
}

/** The step cannot be previewed as stated; it would not be sent this way either (409). */
export class StepRefusal extends Error {}

export interface StepPreviewInput {
  /** The site's brand, as a send renders it (B130, D128). */
  brand: BrandSite;
  sequence: { id: bigint; name: string; event: string };
  step: {
    id: bigint;
    uuid: string;
    position: number;
    kind: string;
    aggregates: Record<string, Aggregate>;
  };
  /** A readable subscriber, or null for the dummy one. */
  subscriber: {
    id: bigint;
    uuid: string;
    email: string;
    name: string;
    external_id: string | null;
    attribs: string;
  } | null;
  triggerEventId: bigint | null;
  /** An external sequence's trigger record (D172); `triggerEventId` is a pushed sequence's. */
  triggerExternalId?: string | null;
  sample: Sample | undefined;
  /** A test send's recipient: the address the context names unless the sample gives one. */
  recipient?: string;
  now: Date;
}

export interface StepPreview {
  data: StepData;
  links: PreparedLinks;
}

const has = (object: Record<string, unknown> | undefined, key: string) =>
  object !== undefined && Object.hasOwn(object, key);

/**
 * Where a preview reads the trigger and the aggregates: the local events, or an external sequence's
 * source (D172). A source failure is thrown as the `SourceError` it is.
 */
export interface PreviewReads {
  /** The trigger: the named one (checked), else the subscriber's latest; null for none. */
  trigger(input: StepPreviewInput): Promise<StepData["trigger"]>;
  aggregate(
    aggregates: Record<string, Aggregate>,
    context: {
      subscriberId: bigint;
      externalId: string | null;
      triggerAt: Date | string;
      now: Date;
    },
  ): Promise<AggregateResult>;
}

/** A pushed-event sequence's reads: the local events table. */
export function eventReads(events: Pick<EventStore, "get" | "latest" | "aggregate">): PreviewReads {
  return {
    trigger(input) {
      const { subscriber, sequence } = input;
      let event: EventRow | null = null;
      if (input.triggerExternalId) {
        throw new FieldError("trigger_external_id");
      }
      if (input.triggerEventId !== null) {
        const named = events.get(input.triggerEventId);
        if (
          !subscriber ||
          !named ||
          named.subscriber_id !== subscriber.id ||
          named.name !== sequence.event
        ) {
          throw new FieldError("trigger_event_id");
        }
        event = named;
      } else if (subscriber) {
        event = events.latest(subscriber.id, sequence.event);
      }
      return Promise.resolve(
        event ? { name: event.name, data: event.data, occurred_at: event.occurred_at } : null,
      );
    },
    aggregate(aggregates, context) {
      return Promise.resolve(
        events.aggregate(aggregates, {
          subscriberId: context.subscriberId,
          triggerAt: context.triggerAt,
          enrolledAt: context.now,
          now: context.now,
        }),
      );
    },
  };
}

/** An external sequence's reads (D172): its source, by the subscriber's `external_id`. */
export function sourcePreviewReads(source: ExternalSource, signal?: AbortSignal): PreviewReads {
  const call = signal ? { signal } : {};
  return {
    async trigger(input) {
      const { subscriber, sequence } = input;
      if (input.triggerEventId !== null) {
        throw new FieldError("trigger_event_id");
      }
      const externalId = subscriber?.external_id ?? null;
      if (subscriber && !externalId) {
        throw new StepRefusal(
          "The subscriber has no external ID, so its source records cannot be read.",
        );
      }
      let record = null;
      if (input.triggerExternalId) {
        record = subscriber ? await source.record(input.triggerExternalId, call) : null;
        if (!record || record.user !== externalId || record.name !== sequence.event) {
          throw new FieldError("trigger_external_id");
        }
      } else if (externalId) {
        record = await source.latest({ user: externalId, names: [sequence.event] }, call);
      }
      return record
        ? {
            name: record.name,
            data: JSON.stringify(record.data),
            occurred_at: record.occurredAt.toISOString(),
          }
        : null;
    },
    async aggregate(aggregates, context) {
      const reads: SourceReads = { source };
      if (signal) {
        reads.signal = signal;
      }
      const result = await aggregateOnSource(
        aggregates,
        {
          subscriberId: context.subscriberId,
          externalId: context.externalId,
          triggerAt: context.triggerAt,
          enrolledAt: context.now,
          now: context.now,
        },
        reads,
      );
      if (!result.ok && "error" in result && result.error.kind.startsWith("source_")) {
        throw new SourceError(
          result.error.kind === "source_transient" ? "transient" : "permanent",
          result.error.message,
        );
      }
      return result;
    },
  };
}

/** What the reads gave a preview: its trigger and its totals, the same for every recipient. */
export interface PreviewParts {
  trigger: StepData["trigger"];
  totals: Record<string, number>;
}

/** Reads the trigger and the aggregates of one preview or test send, once for all its recipients. */
export async function previewParts(
  input: StepPreviewInput,
  reads: PreviewReads,
): Promise<PreviewParts> {
  const { sequence, step, subscriber, sample, now } = input;
  const defined = step.aggregates;
  for (const name of Object.keys(sample?.aggregates ?? {})) {
    if (!has(defined, name)) {
      throw new FieldError(`sample.aggregates.${name}`);
    }
  }

  // The trigger: the named event, else the subscriber's latest one under the trigger's name.
  const event = await reads.trigger(input);
  let trigger: StepData["trigger"] = event
    ? event
    : subscriber
      ? null
      : { name: sequence.event, data: "{}", occurred_at: now.toISOString() };
  if (sample?.trigger !== undefined) {
    trigger = {
      name: sample.trigger.name ?? trigger?.name ?? sequence.event,
      data:
        sample.trigger.data === undefined
          ? (trigger?.data ?? "{}")
          : JSON.stringify(sample.trigger.data),
      occurred_at: sample.trigger.occurred_at ?? trigger?.occurred_at ?? now.toISOString(),
    };
  }

  // The aggregates: read for a real subscriber, measured from the trigger, except where the
  // sample names one; zero for the dummy subscriber. An aggregate over its limit is no total.
  const computed = Object.keys(defined).filter((name) => !has(sample?.aggregates, name));
  let measured: Record<string, number> = {};
  if (subscriber && computed.length) {
    const result = await reads.aggregate(
      Object.fromEntries(computed.map((name) => [name, must(defined[name], "step aggregate")])),
      {
        subscriberId: subscriber.id,
        externalId: subscriber.external_id,
        // Without a trigger a step measures from now, as a manual enrollment's first step does.
        triggerAt: trigger?.occurred_at ?? now,
        now,
      },
    );
    if (!result.ok) {
      throw new StepRefusal(
        "limit" in result
          ? "An aggregate of this step is past its limit for this subscriber, so the step would be skipped."
          : "The step's aggregates could not be computed for this subscriber.",
      );
    }
    measured = result.values;
  }
  // In the step's own order, as the scheduler's totals are (events.evaluate iterates the same
  // definition): a sampled value keeps its place, and a name with nothing measured is zero.
  const sampled = sample?.aggregates ?? {};
  const totals = Object.fromEntries(
    Object.keys(defined).map((name) => [
      name,
      has(sampled, name)
        ? must(sampled[name], "sampled aggregate")
        : has(measured, name)
          ? must(measured[name], "measured aggregate")
          : 0,
    ]),
  );
  return { trigger, totals };
}

/**
 * The step's data for one send. `linksFor` is the send links of a message (unsubscribe and
 * headers); a preview names the placeholder send UUID, which is what unsubscribe links carry.
 */
export function stepPreview(
  input: StepPreviewInput,
  parts: PreviewParts,
  linksFor: (send: {
    uuid: string;
    kind: "transactional" | "marketing";
    subscriberUuid: string | null;
  }) => PreparedLinks,
): StepPreview {
  const { sequence, step, subscriber, sample } = input;
  const { trigger, totals } = parts;

  // The subscriber: the real one, or the dummy one, with the sample's named fields replacing it.
  const base = subscriber ?? {
    id: 0n,
    uuid: dummyUUID,
    email: "dummy@example.invalid",
    name: "John Doe",
    external_id: null,
    attribs: "{}",
  };
  const named = sample?.subscriber;
  // D126: a preview or a test names the placeholder subscriber UUID in its data and its links. A test
  // goes to addresses the operator chose, and a real UUID there would unlock that subscriber's paths.
  const chosen = {
    id: base.id,
    uuid: dummyUUID,
    email: named?.email ?? input.recipient ?? base.email,
    name: named?.name ?? base.name,
    external_id: named?.external_id ?? base.external_id ?? "",
    attribs: named?.attribs === undefined ? base.attribs : JSON.stringify(named.attribs),
  };
  const kind = step.kind === "marketing" ? "marketing" : "transactional";
  const links = linksFor({ uuid: dummyUUID, kind, subscriberUuid: chosen.uuid });
  // `chosen.uuid` is the placeholder (above): the links name it, as the send placeholder is named.
  return {
    data: {
      subscriber: chosen,
      trigger,
      sequence: { id: sequence.id, name: sequence.name },
      step: { id: step.id, uuid: step.uuid, position: step.position, kind: step.kind },
      aggregates: totals,
      // D126 (r2): unsubscribe_url is marketing mail's; every step carries its manage link.
      unsubscribe_url: kind === "marketing" ? (links.unsubscribeUrl ?? "") : "",
      manage_url: links.unsubscribeUrl ? `${links.unsubscribeUrl}?manage=true` : "",
      brand: input.brand,
    },
    links,
  };
}
