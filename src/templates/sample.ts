// Sample data for a template preview and a sequence step preview (docs/design/06-templates.md
// #preview-data, 05-sequences.md#preview-and-test-send, D105). A sample replaces the named parts of
// the context it previews with; whatever it does not name keeps its value. Bounded as template
// data is (parseTemplateData). No upstream source.
import { parseTemplateData } from "@/templates/data";
import type { TemplateData } from "@/templates/data";

/** A sample field that is not allowed or not of its type. `field` names it, as the API reports it. */
export class SampleError extends Error {
  constructor(readonly field: string) {
    super(`Invalid fields: ${field}`);
  }
}

type Json = { [key: string]: TemplateData };

export interface Sample {
  subscriber?: { name?: string; email?: string; external_id?: string; attribs?: Json };
  trigger?: { name?: string; data?: Json; occurred_at?: string };
  aggregates?: Record<string, number>;
  /** The template's own `data`. A sequence step's template has none, so a step refuses it. */
  data?: Json;
}

const isObject = (value: unknown): value is Record<string, TemplateData> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Only the named members, each one an object. */
function members(value: unknown, field: string, allowed: ReadonlyArray<string>) {
  if (!isObject(value)) {
    throw new SampleError(field);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new SampleError(`${field}.${key}`);
  }
  return value;
}
function str(value: TemplateData, field: string): string {
  if (typeof value !== "string") {
    throw new SampleError(field);
  }
  return value;
}
function obj(value: TemplateData, field: string): Json {
  if (!isObject(value)) {
    throw new SampleError(field);
  }
  return value;
}

/**
 * Parses a sample from its JSON text (a request's string field, or the JSON of a body member).
 * Anything over the template data limits, not JSON, or not of the shape below is a SampleError
 * naming the field, and nothing is rendered. `data` is admitted only where a template has one.
 */
export function parseSample(json: string, options: { data: boolean }): Sample {
  let parsed: { [key: string]: TemplateData };
  try {
    parsed = parseTemplateData(json);
  } catch {
    throw new SampleError("sample");
  }
  const allowed = options.data
    ? ["subscriber", "trigger", "aggregates", "data"]
    : ["subscriber", "trigger", "aggregates"];
  const top = members(parsed, "sample", allowed);
  const sample: Sample = {};

  if (top.subscriber !== undefined) {
    const s = members(top.subscriber, "sample.subscriber", [
      "name",
      "email",
      "external_id",
      "attribs",
    ]);
    const out: NonNullable<Sample["subscriber"]> = {};
    if (s.name !== undefined) {
      out.name = str(s.name, "sample.subscriber.name");
    }
    if (s.email !== undefined) {
      out.email = str(s.email, "sample.subscriber.email");
    }
    if (s.external_id !== undefined) {
      out.external_id = str(s.external_id, "sample.subscriber.external_id");
    }
    if (s.attribs !== undefined) {
      out.attribs = obj(s.attribs, "sample.subscriber.attribs");
    }
    sample.subscriber = out;
  }
  if (top.trigger !== undefined) {
    const t = members(top.trigger, "sample.trigger", ["name", "data", "occurred_at"]);
    const out: NonNullable<Sample["trigger"]> = {};
    if (t.name !== undefined) {
      out.name = str(t.name, "sample.trigger.name");
    }
    if (t.data !== undefined) {
      out.data = obj(t.data, "sample.trigger.data");
    }
    if (t.occurred_at !== undefined) {
      const occurred = str(t.occurred_at, "sample.trigger.occurred_at");
      if (Number.isNaN(Date.parse(occurred))) {
        throw new SampleError("sample.trigger.occurred_at");
      }
      out.occurred_at = occurred;
    }
    sample.trigger = out;
  }
  if (top.aggregates !== undefined) {
    const aggregates = obj(top.aggregates, "sample.aggregates");
    for (const [name, value] of Object.entries(aggregates)) {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new SampleError(`sample.aggregates.${name}`);
    }
    sample.aggregates = aggregates as Record<string, number>;
  }
  if (top.data !== undefined) {
    sample.data = obj(top.data, "sample.data");
  }
  return sample;
}

/** listmonk's first and last name: the first and last word over two bytes (tx/routes.ts). */
function nameChunk(name: string, last: boolean) {
  const chunks = name.split(" ");
  if (last) {
    chunks.reverse();
  }
  return chunks.find((chunk) => Buffer.byteLength(chunk) > 2) ?? name;
}

/**
 * The depth and node limits of template data (data.ts parseTemplateData): the same numbers, so a
 * sample is refused here exactly when parseTemplateData would refuse it.
 */
const MAX_DEPTH = 16;
const MAX_NODES = 10_000;

/**
 * Whether a parsed value is within the template data depth and node limits. It walks the value
 * with an explicit stack, so a value nested without limit (JSON.parse admits any depth) costs
 * nothing beyond the limits: the walk stops at the first excess.
 */
function withinLimits(value: unknown): boolean {
  const pending: Array<[unknown, number]> = [[value, 0]];
  let nodes = 0;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [item, depth] = next;
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      return false;
    }
    if (typeof item === "object" && item !== null) {
      for (const child of Object.values(item)) pending.push([child, depth + 1]);
    }
  }
  return true;
}

/**
 * Parses a sample that a request body already parsed (its `sample` member). Such a value has no
 * depth limit yet, so it is checked against the template data limits before anything recurses
 * over it, and only then serialized for parseSample.
 */
export function parseSampleValue(value: unknown, options: { data: boolean }): Sample {
  if (!withinLimits(value)) {
    throw new SampleError("sample");
  }
  return parseSample(JSON.stringify(value), options);
}

/**
 * The template preview's context: the dummy one with the sample's parts replacing it. A sample
 * name also sets the first and last name, as a transactional subscriber's context does.
 */
export function previewContext(
  dummy: Record<string, unknown>,
  sample: Sample,
): Record<string, unknown> {
  const subscriber: Record<string, unknown> = {
    ...(dummy.subscriber as Record<string, unknown>),
    ...sample.subscriber,
  };
  if (sample.subscriber?.name !== undefined) {
    subscriber.first_name = nameChunk(sample.subscriber.name, false);
    subscriber.last_name = nameChunk(sample.subscriber.name, true);
  }
  return {
    ...dummy,
    subscriber,
    trigger: { ...(dummy.trigger as Record<string, unknown>), ...sample.trigger },
    aggregates: { ...(dummy.aggregates as Record<string, unknown>), ...sample.aggregates },
    data: sample.data ?? dummy.data,
  };
}
