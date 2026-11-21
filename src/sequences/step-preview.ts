// The render context of a sequence step's preview and test send (docs/design/05-sequences.md
// #preview-and-test-send, D105): the subscriber, trigger, aggregates and links a real send would
// use, with a sample replacing the named parts. Reads only; the routes decide what to do with it.
// No upstream source.
import type { Aggregate } from "@/events/aggregate";
import type { EventRow, EventStore } from "@/events/store";
import { dummyUUID } from "@/campaigns/render";
import type { PreparedLinks } from "@/unsubscribe/message";
import type { Sample } from "@/templates/sample";
import type { StepData } from "@/sequences/step-data";

/** A request field that names no valid value. `field` is what the API reports. */
export class FieldError extends Error {
  constructor(readonly field: string) {
    super(`Invalid fields: ${field}`);
  }
}

/** The step cannot be previewed as stated; it would not be sent this way either (409). */
export class StepRefusal extends Error {}

export interface StepPreviewInput {
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
  sample: Sample | undefined;
  /** A test send's recipient: the address the context names unless the sample gives one. */
  recipient?: string;
  now: Date;
}

export interface StepPreview {
  data: StepData;
  links: PreparedLinks;
}

const has = (object: object | undefined, key: string) =>
  object !== undefined && Object.hasOwn(object, key);

/**
 * The step's data for one send. `linksFor` is the send links of a message (unsubscribe and
 * headers); a preview names the placeholder send UUID, which is what unsubscribe links carry.
 */
export function stepPreview(
  input: StepPreviewInput,
  events: Pick<EventStore, "get" | "latest" | "aggregate">,
  linksFor: (send: {
    uuid: string;
    kind: "transactional" | "marketing";
    subscriberUuid: string | null;
  }) => PreparedLinks,
): StepPreview {
  const { sequence, step, subscriber, sample, now } = input;
  const defined = step.aggregates;
  for (const name of Object.keys(sample?.aggregates ?? {})) {
    if (!has(defined, name)) throw new FieldError(`sample.aggregates.${name}`);
  }

  // The trigger: the named event, else the subscriber's latest one under the trigger's name.
  let event: EventRow | null = null;
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
  let trigger: StepData["trigger"] = event
    ? { name: event.name, data: event.data, occurred_at: event.occurred_at }
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
    const result = events.aggregate(
      Object.fromEntries(computed.map((name) => [name, defined[name]!])),
      {
        subscriberId: subscriber.id,
        // Without a trigger a step measures from now, as a manual enrollment's first step does.
        triggerAt: trigger?.occurred_at ?? now,
        enrolledAt: now,
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
      has(sampled, name) ? sampled[name]! : has(measured, name) ? measured[name]! : 0,
    ]),
  );

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
    },
    links,
  };
}
