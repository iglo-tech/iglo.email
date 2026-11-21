// Sequence definition validation (docs/design/05-sequences.md#sequence-definition); no upstream
// source. Every field is checked against the definition table before anything is written, and
// every walk is bounded before it iterates, so a hostile body costs no more than the limits.
import { parseDuration } from "@/conditions/duration";
import { validPath } from "@/conditions/json";
import type { Condition, Scalar } from "@/conditions/types";
import { validate } from "@/conditions/validate";
import type { Aggregate } from "@/events/aggregate";
import { trimSpace } from "@/lists/store";

export const sequenceStatuses = ["draft", "active", "paused", "archived"] as const;
export type SequenceStatus = (typeof sequenceStatuses)[number];
const reentries = ["never", "after_exit", "always"] as const;
export type Reentry = (typeof reentries)[number];

/** Bounds against hostile definitions. Conditions are bounded by conditions/types limits. */
export const limits = {
  /** UTF-8 bytes in a sequence name. */
  nameBytes: 200,
  /** Active steps in one sequence. */
  steps: 50,
  /** Event names in `exit_on`. */
  exitOn: 20,
  /** Named aggregates in one step (docs/design/05-sequences.md#aggregates). */
  aggregates: 10,
  /** UTF-8 bytes in a step subject override. */
  subjectBytes: 2048,
  /** Request body bytes of a definition. */
  bodyBytes: 256 * 1024,
} as const;

export interface StepInput {
  id: bigint | null;
  wait: string;
  kind: "marketing" | "transactional";
  templateId: bigint;
  subject: string | null;
  /** Validated condition as JSON text. */
  condition: string | null;
  /** Validated named aggregates as JSON text, or null for none (D100). */
  aggregates: string | null;
  onFalse: "skip" | "exit";
  capPolicy: "defer" | "skip";
  maxLate: string | null;
}
export interface DefinitionInput {
  name: string;
  status: SequenceStatus | undefined;
  /** Validated `{event, where?}` as JSON text. */
  trigger: string;
  exitOn: Array<string>;
  reentry: Reentry;
  listId: bigint | null;
  steps: Array<StepInput>;
}

export class DefinitionError extends Error {
  constructor(
    readonly field: string,
    readonly detail: string,
  ) {
    super(`${field}: ${detail}`);
  }
}

export interface DefinitionContext {
  /** The caller holds `subscribers:sql_query`. */
  canUseSql: boolean;
  /** A template's type, or null when it does not exist. */
  templateType(id: bigint): string | null;
  /** The list exists and the caller may see it. */
  listUsable(id: bigint): boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
// Control characters are refused on purpose: the range is the check.
// oxlint-disable-next-line no-control-regex
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const fail = (field: string, detail: string): never => {
  throw new DefinitionError(field, detail);
};

/** A positive JSON integer ID within the safe range, or undefined for absent/null. */
export function idValue(value: unknown, field: string): bigint | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return fail(field, "must be an ID");
  }
  return BigInt(value);
}

/** An event name as the events API accepts it. */
export function validEventName(name: unknown): name is string {
  return typeof name === "string" && validate({ event: name }, { canUseSql: false }).ok;
}

function containsSql(condition: Condition): boolean {
  if ("sql" in condition) {
    return true;
  }
  if ("all" in condition) {
    return condition.all.some(containsSql);
  }
  if ("any" in condition) {
    return condition.any.some(containsSql);
  }
  if ("not" in condition) {
    return containsSql(condition.not);
  }
  return false;
}

/** The first error of a condition validation as a definition error. */
function checked(result: ReturnType<typeof validate>, field: string): Condition {
  if (result.ok) {
    return result.condition;
  }
  const first = result.errors[0];
  return fail(first?.field ?? field, first?.message ?? "invalid condition");
}

/**
 * `trigger.where`: either the design's shorthand, an object of `data.*` equalities on the
 * triggering event (`{"data.product": "prepaid"}`), or a condition evaluated for the
 * subscriber after the event's upsert. Raw `sql` is refused: triggers run inside the event's
 * write transaction, where the read-only child runner cannot see the uncommitted event.
 */
function triggerWhere(where: unknown, event: string): Record<string, unknown> | Condition {
  if (!isObject(where)) {
    return fail("trigger.where", "must be an object");
  }
  let shorthand = false;
  for (const key in where) {
    if (!Object.hasOwn(where, key)) {
      continue;
    }
    shorthand = key.startsWith("data.");
    if (!shorthand) {
      break;
    }
  }
  if (shorthand) {
    const result = checked(
      validate({ event, where }, { canUseSql: false, field: "trigger" }),
      "trigger.where",
    ) as { where: Record<string, unknown> };
    return result.where;
  }
  const condition = checked(
    validate(where, { canUseSql: true, field: "trigger.where" }),
    "trigger.where",
  );
  if (containsSql(condition)) {
    fail("trigger.where", "sql conditions are not supported in triggers");
  }
  return condition;
}

// Aggregate names become template variables, so they are plain identifiers.
const aggregateName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const aggregateFields = new Set(["event", "since", "where", "fn", "field"]);

/**
 * A step's `aggregates` (D100): 1 to 10 named aggregates, each an event predicate of the condition
 * language (`event`, `since`, `where`, checked by the same validator) with `fn` and `field`.
 * Returns the normalized JSON text, or null for an absent or null value.
 */
function aggregatesInput(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const range = `must have 1 to ${limits.aggregates} aggregates`;
  if (!isObject(value)) return fail(field, range);
  const names: string[] = [];
  for (const name in value) {
    if (!Object.hasOwn(value, name)) continue;
    if (names.length === limits.aggregates) return fail(field, range);
    if (!aggregateName.test(name))
      return fail(
        field,
        "names must be letters, digits or underscores, starting with a letter or underscore, up to 64",
      );
    names.push(name);
  }
  if (!names.length) return fail(field, range);
  const entries: [string, Aggregate][] = [];
  for (const name of names) {
    const at = `${field}.${name}`;
    const spec = value[name];
    if (!isObject(spec)) return fail(at, "must be an aggregate object");
    for (const key in spec)
      if (Object.hasOwn(spec, key) && !aggregateFields.has(key)) {
        return fail(`${at}.${key}`, "unknown field");
      }
    // An absent key is absent; a present one is checked as given, so null is refused as a condition
    // refuses it. Only `fn` defaults, as the other step fields do.
    const path = spec.field;
    const predicate = checked(
      validate(
        {
          event: spec.event,
          ...(spec.since === undefined ? {} : { since: spec.since }),
          ...(spec.where === undefined ? {} : { where: spec.where }),
        },
        { canUseSql: false, field: at },
      ),
      at,
    ) as { event: string; since?: string; where?: Record<string, Scalar> };
    const fn = aggregateFn(spec.fn, `${at}.fn`);
    if (fn === "count") {
      if (path !== undefined) {
        fail(`${at}.field`, "is only for sum and distinct");
      }
    } else if (path === undefined) {
      fail(`${at}.field`, "is required for sum and distinct");
    } else if (typeof path !== "string" || !path.startsWith("data.") || !validPath(path.slice(5))) {
      fail(`${at}.field`, "must be a data.* path");
    }
    entries.push([
      name,
      {
        ...predicate,
        fn,
        ...(fn === "count" ? {} : { field: path as string }),
      },
    ]);
  }
  // Object.fromEntries defines each name as an own property, so `__proto__` stays a name.
  return JSON.stringify(Object.fromEntries(entries));
}

const aggregateFns = ["count", "sum", "distinct"] as const;
/**
 * An aggregate's `fn` (D103): only an absent key defaults to `count`. A `null` is a value, refused
 * as `since` and `where` refuse one, so `{"fn": null}` cannot save as a count.
 */
function aggregateFn(value: unknown, field: string): (typeof aggregateFns)[number] {
  if (value === undefined) {
    return "count";
  }
  if (typeof value !== "string" || !(aggregateFns as ReadonlyArray<string>).includes(value)) {
    return fail(field, `must be one of ${aggregateFns.join(", ")}`);
  }
  return value as (typeof aggregateFns)[number];
}

function choice<T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
  field: string,
  fallback: T,
): T {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string" || !(allowed as ReadonlyArray<string>).includes(value)) {
    return fail(field, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function duration(value: unknown, field: string): string {
  if (typeof value !== "string" || parseDuration(value) === undefined) {
    return fail(field, "must be an ISO 8601 duration of weeks, days, hours, minutes or seconds");
  }
  return value;
}

function step(value: unknown, i: number, context: DefinitionContext): StepInput {
  const field = `steps.${i}`;
  if (!isObject(value)) {
    return fail(field, "must be a step object");
  }
  const id = idValue(value.id, `${field}.id`) ?? null;
  const wait = duration(value.wait, `${field}.wait`);
  if (value.kind !== "marketing" && value.kind !== "transactional") {
    fail(`${field}.kind`, "must be marketing or transactional");
  }
  const kind = value.kind as StepInput["kind"];
  const templateId = idValue(value.template_id, `${field}.template_id`);
  if (templateId === undefined) {
    return fail(`${field}.template_id`, "is required");
  }
  // Steps have no body of their own, so the template must be a complete transactional one.
  if (context.templateType(templateId) !== "tx") {
    fail(`${field}.template_id`, "must be an existing transactional template");
  }
  let subject: string | null = null;
  if (value.subject !== undefined && value.subject !== null) {
    if (
      typeof value.subject !== "string" ||
      value.subject !== value.subject.toWellFormed() ||
      value.subject.includes("\0") ||
      Buffer.byteLength(value.subject) > limits.subjectBytes
    ) {
      fail(`${field}.subject`, "invalid subject");
    }
    subject = value.subject as string;
  }
  let condition: string | null = null;
  if (value.condition !== undefined && value.condition !== null) {
    condition = JSON.stringify(
      checked(
        validate(value.condition, {
          canUseSql: context.canUseSql,
          field: `${field}.condition`,
        }),
        `${field}.condition`,
      ),
    );
  }
  const onFalse = choice(value.on_false, ["skip", "exit"] as const, `${field}.on_false`, "exit");
  const capPolicy = choice(
    value.cap_policy,
    ["defer", "skip"] as const,
    `${field}.cap_policy`,
    "defer",
  );
  const aggregates = aggregatesInput(value.aggregates, `${field}.aggregates`);
  // Missing means the default; an explicit null means no limit.
  const maxLate =
    value.max_late === undefined
      ? kind === "marketing"
        ? "P2D"
        : null
      : value.max_late === null
        ? null
        : duration(value.max_late, `${field}.max_late`);
  return {
    id,
    wait,
    kind,
    templateId,
    subject,
    condition,
    aggregates,
    onFalse,
    capPolicy,
    maxLate,
  };
}

/** A definition body for POST or PUT, validated against `context`. Throws DefinitionError. */
export function definitionInput(value: unknown, context: DefinitionContext): DefinitionInput {
  if (!isObject(value)) {
    return fail("body", "must be an object");
  }
  if (typeof value.name !== "string") {
    return fail("name", "is required");
  }
  const name = trimSpace(value.name);
  if (
    !name ||
    name !== name.toWellFormed() ||
    controls.test(name) ||
    Buffer.byteLength(name) > limits.nameBytes
  ) {
    fail("name", `must be 1 to ${limits.nameBytes} bytes of text`);
  }
  const status =
    value.status === undefined
      ? undefined
      : choice(value.status, sequenceStatuses, "status", "draft");

  const trigger = value.trigger;
  if (!isObject(trigger)) {
    return fail("trigger", "must be an object");
  }
  for (const key in trigger) {
    if (Object.hasOwn(trigger, key) && key !== "event" && key !== "where")
      fail("trigger", "unknown field");
  }
  if (!validEventName(trigger.event)) {
    return fail("trigger.event", "must be an event name");
  }
  const where =
    trigger.where === undefined ? undefined : triggerWhere(trigger.where, trigger.event);

  const exitOn: Array<string> = [];
  if (value.exit_on !== undefined && value.exit_on !== null) {
    if (!Array.isArray(value.exit_on) || value.exit_on.length > limits.exitOn) {
      fail("exit_on", `must be an array of at most ${limits.exitOn} event names`);
    }
    for (const [i, item] of (value.exit_on as Array<unknown>).entries()) {
      if (!validEventName(item)) {
        fail(`exit_on.${i}`, "must be an event name");
      }
      if (!exitOn.includes(item as string)) {
        exitOn.push(item as string);
      }
    }
  }
  const reentry = choice(value.reentry, reentries, "reentry", "never");
  const listId = idValue(value.list_id, "list_id") ?? null;
  if (listId !== null && !context.listUsable(listId)) {
    fail("list_id", "unknown list");
  }

  const steps = value.steps ?? [];
  if (!Array.isArray(steps) || steps.length > limits.steps) {
    return fail("steps", `must be an array of at most ${limits.steps} steps`);
  }
  const parsed = steps.map((item, i) => step(item, i, context));
  const ids = parsed.flatMap((s) => (s.id === null ? [] : [s.id]));
  if (new Set(ids).size !== ids.length) {
    fail("steps", "step IDs must be unique");
  }
  if (listId === null && parsed.some((s) => s.kind === "marketing")) {
    fail("list_id", "is required when a step is marketing");
  }
  if (status === "active" && !parsed.length) {
    fail("steps", "an active sequence needs a step");
  }
  return {
    name,
    status,
    trigger: JSON.stringify({
      event: trigger.event,
      ...(where ? { where } : {}),
    }),
    exitOn,
    reentry,
    listId,
    steps: parsed,
  };
}
