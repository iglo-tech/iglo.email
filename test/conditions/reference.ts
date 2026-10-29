// An in-memory reference evaluator for the documented condition semantics
// (docs/design/05-sequences.md#conditions). It reads the fixture model, never SQL, and is
// written from the documented type rules rather than from the compiler.
import type { ModelSubscriber } from "@/test/conditions/fixture";

type Value = unknown;
type Context = {
  triggerAt?: string;
  enrolledAt?: string;
  lastStepAt?: string | null;
  now: Date;
};

const missing = Symbol("missing");

function lookup(root: Record<string, unknown>, path: string): Value | typeof missing {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return missing;
    if (!Object.hasOwn(current, segment)) return missing;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// SQLite compares text as UTF-8 bytes.
const utf8Compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function equals(actual: Value | typeof missing, expected: unknown): boolean {
  if (typeof expected === "string") return typeof actual === "string" && actual === expected;
  if (typeof expected === "number") return typeof actual === "number" && actual === expected;
  if (typeof expected === "boolean") return actual === expected;
  return false;
}

function ordered(actual: Value | typeof missing, op: string, expected: unknown): boolean {
  let order: number;
  if (typeof expected === "string" && typeof actual === "string")
    order = utf8Compare(actual, expected);
  else if (typeof expected === "number" && typeof actual === "number")
    order = actual < expected ? -1 : actual > expected ? 1 : 0;
  else return false;
  return op === "gt" ? order > 0 : op === "gte" ? order >= 0 : op === "lt" ? order < 0 : order <= 0;
}

function durationMs(text: string): number {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text)!;
  const [w, d, h, min, s] = m.slice(1).map((part) => Number(part ?? 0)) as number[];
  return ((((w! * 7 + d!) * 24 + h!) * 60 + min!) * 60 + s!) * 1000;
}

function lowerBound(since: string | undefined, context: Context): number | undefined {
  if (since === undefined) return undefined;
  const at = (value: string | null | undefined) => {
    if (!value) throw new Error("missing context time");
    return Date.parse(value);
  };
  if (since === "trigger") return at(context.triggerAt);
  if (since === "enrollment") return at(context.enrolledAt);
  if (since === "last_step") return at(context.lastStepAt ?? context.triggerAt);
  return context.now.getTime() - durationMs(since);
}

export function referenceEvaluate(
  condition: Record<string, unknown>,
  subscriber: ModelSubscriber,
  context: Context,
  sql?: (fragment: string, subscriber: ModelSubscriber) => boolean,
): boolean {
  if ("all" in condition)
    return (condition.all as Record<string, unknown>[]).every((c) =>
      referenceEvaluate(c, subscriber, context, sql),
    );
  if ("any" in condition)
    return (condition.any as Record<string, unknown>[]).some((c) =>
      referenceEvaluate(c, subscriber, context, sql),
    );
  if ("not" in condition)
    return !referenceEvaluate(condition.not as Record<string, unknown>, subscriber, context, sql);
  if ("sql" in condition) {
    if (!sql) throw new Error("no sql model");
    return sql(condition.sql as string, subscriber);
  }
  if ("list" in condition) {
    const statuses = (condition.status as string[] | undefined) ?? ["unconfirmed", "confirmed"];
    return subscriber.lists.some((m) => m.list === condition.list && statuses.includes(m.status));
  }
  if ("attr" in condition) {
    const op = condition.op as string,
      value = condition.value;
    const actual =
      condition.attr === "status"
        ? subscriber.status
        : lookup(subscriber.attribs, condition.attr as string);
    switch (op) {
      case "eq":
        return equals(actual, value);
      case "ne":
        return !equals(actual, value);
      case "in":
        return (value as unknown[]).some((v) => equals(actual, v));
      case "exists":
        return actual !== missing && actual !== null;
      default:
        return ordered(actual, op, value);
    }
  }
  if ("event" in condition) {
    const after = lowerBound(condition.since as string | undefined, context);
    const where = (condition.where ?? {}) as Record<string, unknown>;
    const n = subscriber.events.filter(
      (e) =>
        e.name === condition.event &&
        (after === undefined || Date.parse(e.occurredAt) > after) &&
        Object.entries(where).every(([path, v]) => equals(lookup(e.data, path.slice(5)), v)),
    ).length;
    const count = (condition.count ?? { gte: 1 }) as Record<string, number>;
    return (
      (count.gte === undefined || n >= count.gte) &&
      (count.lte === undefined || n <= count.lte) &&
      (count.eq === undefined || n === count.eq)
    );
  }
  throw new Error("unknown condition");
}
