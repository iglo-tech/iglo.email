// An in-memory reference evaluator for the documented condition semantics
// (docs/design/05-sequences.md#conditions). It reads the fixture model, never SQL, and is
// written from the documented type rules rather than from the compiler.
import type { ModelSubscriber } from "@/test/conditions/fixture";
import { asBody } from "@/test/read-body";

const at = (value: string | null | undefined) => {
  if (!value) {
    throw new Error("missing context time");
  }
  return Date.parse(value);
};

type Context = {
  triggerAt?: string;
  enrolledAt?: string;
  lastStepAt?: string | null;
  now: Date;
};

const missing = Symbol("missing");

function lookup(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return missing;
    }
    if (!Object.hasOwn(current, segment)) {
      return missing;
    }
    current = asBody<Record<string, unknown>>(current)[segment];
  }
  return current;
}

// SQLite compares text as UTF-8 bytes.
const utf8Compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function equals(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "string") {
    return typeof actual === "string" && actual === expected;
  }
  if (typeof expected === "number") {
    return typeof actual === "number" && actual === expected;
  }
  if (typeof expected === "boolean") {
    return actual === expected;
  }
  return false;
}

function ordered(actual: unknown, op: string, expected: unknown): boolean {
  let order: number;
  if (typeof expected === "string" && typeof actual === "string") {
    order = utf8Compare(actual, expected);
  } else if (typeof expected === "number" && typeof actual === "number") {
    order = actual < expected ? -1 : actual > expected ? 1 : 0;
  } else {
    return false;
  }
  return op === "gt" ? order > 0 : op === "gte" ? order >= 0 : op === "lt" ? order < 0 : order <= 0;
}

function durationMs(text: string): number {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text)!;
  const [w, d, h, min, s] = m.slice(1).map((part) => Number(part ?? 0));
  return ((((w! * 7 + d!) * 24 + h!) * 60 + min!) * 60 + s!) * 1000;
}

function lowerBound(since: string | undefined, context: Context): number | undefined {
  if (since === undefined) {
    return undefined;
  }
  if (since === "trigger") {
    return at(context.triggerAt);
  }
  if (since === "enrollment") {
    return at(context.enrolledAt);
  }
  if (since === "last_step") {
    return at(context.lastStepAt ?? context.triggerAt);
  }
  return context.now.getTime() - durationMs(since);
}

export function referenceEvaluate(
  condition: Record<string, unknown>,
  subscriber: ModelSubscriber,
  context: Context,
  sql?: (fragment: string, subscriber: ModelSubscriber) => boolean,
): boolean {
  if ("all" in condition) {
    return asBody<Array<Record<string, unknown>>>(condition.all).every((c) =>
      referenceEvaluate(c, subscriber, context, sql),
    );
  }
  if ("any" in condition) {
    return asBody<Array<Record<string, unknown>>>(condition.any).some((c) =>
      referenceEvaluate(c, subscriber, context, sql),
    );
  }
  if ("not" in condition) {
    return !referenceEvaluate(
      asBody<Record<string, unknown>>(condition.not),
      subscriber,
      context,
      sql,
    );
  }
  if ("sql" in condition) {
    if (!sql) {
      throw new Error("no sql model");
    }
    return sql(asBody<string>(condition.sql), subscriber);
  }
  if ("list" in condition) {
    const statuses = asBody<Array<string> | undefined>(condition.status) ?? [
      "unconfirmed",
      "confirmed",
    ];
    return subscriber.lists.some((m) => m.list === condition.list && statuses.includes(m.status));
  }
  if ("attr" in condition) {
    const op = asBody<string>(condition.op),
      value = condition.value;
    const actual =
      condition.attr === "status"
        ? subscriber.status
        : lookup(subscriber.attribs, asBody<string>(condition.attr));
    switch (op) {
      case "eq":
        return equals(actual, value);
      case "ne":
        return !equals(actual, value);
      case "in":
        return asBody<Array<unknown>>(value).some((v) => equals(actual, v));
      case "exists":
        return actual !== missing && actual !== null;
      default:
        return ordered(actual, op, value);
    }
  }
  if ("event" in condition) {
    const after = lowerBound(asBody<string | undefined>(condition.since), context);
    const where = asBody<Record<string, unknown>>(condition.where ?? {});
    const n = subscriber.events.filter(
      (e) =>
        e.name === condition.event &&
        (after === undefined || Date.parse(e.occurredAt) > after) &&
        Object.entries(where).every(([path, v]) => equals(lookup(e.data, path.slice(5)), v)),
    ).length;
    const count = asBody<Record<string, number>>(condition.count ?? { gte: 1 });
    return (
      (count.gte === undefined || n >= count.gte) &&
      (count.lte === undefined || n <= count.lte) &&
      (count.eq === undefined || n === count.eq)
    );
  }
  throw new Error("unknown condition");
}
