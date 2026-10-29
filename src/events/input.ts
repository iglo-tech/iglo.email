// Native subscriber events input (docs/design/05-sequences.md#events-api); no upstream source.
// Subscriber fields are validated with the subscriber owner's rules.
import { HttpError } from "@/server/response";
import { trimSpace } from "@/lists/store";
import { sanitizeEmail } from "@/subscribers/email";
import { validAttributes, validExternal } from "@/subscribers/input";
import type { EventSubscriber } from "@/subscribers/store";

export const SINGLE_BODY_BYTES = 64 * 1024;
export const BATCH_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_BATCH = 500;
const MAX_NAME_BYTES = 200;
const MAX_KEY_BYTES = 255;
const MAX_DATA_BYTES = 32 * 1024;
const MAX_DEPTH = 32;

export interface EventInput {
  subscriber: EventSubscriber;
  name: string;
  /** Serialized JSON object. */
  data: string;
  /** Normalized UTC ISO 8601 with milliseconds, or undefined for the receive time. */
  occurredAt?: string;
  idempotencyKey?: string;
}

/** A rejected field, reported as 400 Invalid fields: <field>. */
export class EventInputError extends Error {
  constructor(readonly field: string) {
    super(field);
    this.name = "EventInputError";
  }
}

/** Read at most `limit` bytes; a larger declared or streamed body is 413. */
export async function readBounded(request: Request, limit: number): Promise<Buffer> {
  if (Number(request.headers.get("content-length")) > limit) throw new HttpError(413);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > limit) {
          await reader.cancel();
          throw new HttpError(413);
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON request body; anything else is 415 and malformed JSON is 400. */
export function parseJson(request: Request, body: Buffer): unknown {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const optional = (value: unknown) => value === undefined || value === null;

/**
 * Copy a parsed JSON value with well-formed strings and keys, rejecting non-finite numbers
 * and nesting deeper than MAX_DEPTH. Keys are defined as own data properties, so
 * `__proto__` stays an ordinary key.
 */
function normalize(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error("depth");
  if (typeof value === "string") return value.toWellFormed();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, depth + 1));
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key.toWellFormed(), normalize(item, depth + 1)]),
    );
  return value;
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) throw new EventInputError(field);
  let normalized: Record<string, unknown>;
  try {
    normalized = normalize(value, 1) as Record<string, unknown>;
  } catch {
    throw new EventInputError(field);
  }
  if (!validAttributes(normalized)) throw new EventInputError(field);
  return normalized;
}
function known(value: Record<string, unknown>, fields: readonly string[], prefix = "") {
  for (const key of Object.keys(value))
    if (!fields.includes(key)) throw new EventInputError(`${prefix}${key}`);
}
const controls = /[\u0000-\u001f\u007f-\u009f]/;

/** RFC 3339 with a zone offset; a fraction past milliseconds is truncated. */
export function parseOccurredAt(value: string): string | undefined {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!m) return;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Number((m[7] ?? "").padEnd(3, "0").slice(0, 3));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return;
  const local = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const check = new Date(local);
  // Date.UTC maps years 0-99 to 1900-1999; reject them with impossible dates.
  if (year < 1000 || check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) return;
  let offset = 0;
  if (m[8] !== "Z") {
    const hours = Number(m[10]),
      minutes = Number(m[11]);
    if (hours > 23 || minutes > 59) return;
    offset = (m[9] === "-" ? -1 : 1) * (hours * 60 + minutes) * 60_000;
  }
  const time = local - offset;
  if (time < Date.UTC(1000, 0, 1) || time >= Date.UTC(10000, 0, 1)) return;
  return new Date(time).toISOString();
}

/** Validate one event object without touching storage. */
export function eventInput(value: unknown): EventInput {
  if (!isObject(value)) throw new EventInputError("event");
  known(value, ["subscriber", "name", "data", "occurred_at", "idempotency_key"]);
  const s = value.subscriber;
  if (!isObject(s)) throw new EventInputError("subscriber");
  known(s, ["external_id", "email", "name", "attribs"], "subscriber.");
  const subscriber: EventSubscriber = {};
  if (!optional(s.external_id)) {
    if (typeof s.external_id !== "string" || !validExternal(s.external_id))
      throw new EventInputError("subscriber.external_id");
    subscriber.external_id = s.external_id;
  }
  if (!optional(s.email)) {
    if (typeof s.email !== "string" || Buffer.byteLength(s.email) > 1000)
      throw new EventInputError("subscriber.email");
    const email = sanitizeEmail(s.email.toWellFormed());
    if (email === undefined) throw new EventInputError("subscriber.email");
    subscriber.email = email;
  }
  if (subscriber.external_id === undefined && subscriber.email === undefined)
    throw new EventInputError("subscriber");
  if (!optional(s.name)) {
    if (typeof s.name !== "string") throw new EventInputError("subscriber.name");
    const name = trimSpace(s.name.toWellFormed());
    if (name.includes("\0") || Buffer.byteLength(name) > 2000)
      throw new EventInputError("subscriber.name");
    if (name) subscriber.name = name;
  }
  if (!optional(s.attribs)) subscriber.attribs = object(s.attribs, "subscriber.attribs");

  const name = value.name;
  if (
    typeof name !== "string" ||
    !name ||
    name !== name.toWellFormed() ||
    controls.test(name) ||
    Buffer.byteLength(name) > MAX_NAME_BYTES
  )
    throw new EventInputError("name");
  const data = optional(value.data) ? "{}" : JSON.stringify(object(value.data, "data"));
  if (Buffer.byteLength(data) > MAX_DATA_BYTES) throw new EventInputError("data");
  const event: EventInput = { subscriber, name, data };
  if (!optional(value.occurred_at)) {
    const at = typeof value.occurred_at === "string" && parseOccurredAt(value.occurred_at);
    if (!at) throw new EventInputError("occurred_at");
    event.occurredAt = at;
  }
  if (!optional(value.idempotency_key)) {
    const key = value.idempotency_key;
    if (
      typeof key !== "string" ||
      !key ||
      key !== key.toWellFormed() ||
      key.includes("\0") ||
      Buffer.byteLength(key) > MAX_KEY_BYTES
    )
      throw new EventInputError("idempotency_key");
    event.idempotencyKey = key;
  }
  return event;
}

/** The batch envelope `{"events": [...]}`; items are validated one by one later. */
export function batchItems(value: unknown): unknown[] {
  if (!isObject(value)) throw new EventInputError("events");
  known(value, ["events"]);
  const events = value.events;
  if (!Array.isArray(events) || !events.length || events.length > MAX_BATCH)
    throw new EventInputError("events");
  return events;
}
