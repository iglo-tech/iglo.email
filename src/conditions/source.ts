// Conditions and aggregates of external sequences, read from the project's source
// (15-external-sources section 6, docs/design/05-sequences.md#conditions, #aggregates, D172); no
// upstream source. The condition language is the same; its `event` predicates and aggregates read the
// source's events collection and `recipient` reads the recipients view, while `attr` and `list` stay
// local (the SQLite evaluator). Every read is a network call: nothing here runs inside a transaction.
//
// - A window is `occurredAt` strictly after `since`, as the local window is, and at or before the
//   trigger record for a trigger condition, else at or before `now` plus `MAX_OCCURRED_AHEAD_MS`
//   (D180): a pushed event further ahead is refused when it arrives, so a source record further
//   ahead counts only once it is no further ahead than that.
// - The source's filter is only a narrowing: PocketBase compares JSON loosely (`data.b = true` also
//   matches `1`), so every `where` is checked again here with the condition language's type rules
//   (src/conditions/strict.ts) on the rows read. A `where` part the filter cannot state exactly as a
//   superset (a path with an array index or a non-ASCII key, a number PocketBase would read in another
//   form) is left to that check alone.
// - Without `where`, a count is the source's own count, read up to the comparand + 1. With `where`,
//   pages continue until enough strict matches or the window ends, at most `SCAN_LIMIT` records.
// - An aggregate reads its window (`event`, `since`) up to `AGGREGATE_LIMIT` + 1 records before
//   `where`, as the local one does, and is not computed past the limit.
// - A source failure is never false or zero: it is returned as `source_transient` or `source_permanent`.
import { ContextError, instant, sinceBound } from "@/conditions/since";
import type { ConditionEvaluator } from "@/conditions/evaluate";
import { predicateHolds, valueAt, whereHolds } from "@/conditions/strict";
import type {
  Condition,
  ConditionContext,
  ConditionError,
  EvaluationResult,
  EventCount,
  Scalar,
} from "@/conditions/types";
import { validate } from "@/conditions/validate";
import { AGGREGATE_LIMIT } from "@/events/aggregate";
import type { Aggregate, AggregateResult } from "@/events/aggregate";
import { MAX_OCCURRED_AHEAD_MS } from "@/events/input";
import { isSourceError, SCAN_LIMIT, SourceError } from "@/sources/source";
import type {
  CallOptions,
  EventQuery,
  ExternalSource,
  SourceRecipient,
  SourceScalar,
} from "@/sources/source";

const SAFE = Number.MAX_SAFE_INTEGER;
/** A `data` path segment the source's filter states exactly: an ASCII key, never an array index. */
const filterSegment = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FILTER_SEGMENTS = 8;

/** What an external condition or aggregate is evaluated against. */
export interface SourceContext {
  /** The local subscriber, for `attr` and `list`; absent for a trigger condition. */
  subscriberId?: bigint;
  /** The subscriber's `external_id`: the source's user ID. `null` when it has none. */
  externalId: string | null;
  /** The enrollment's trigger record `occurredAt` (or its start without a trigger). */
  triggerAt?: Date | string;
  enrolledAt?: Date | string;
  lastStepAt?: Date | string | null;
  /** Durations count back from here: the clock's now, or the trigger record's `occurredAt`. */
  now: Date;
  /** An upper bound of every event window, inclusive: the trigger record for a trigger condition. */
  through?: Date;
}

export interface SourceReads {
  source: ExternalSource;
  /** The SQLite evaluator, for the local `attr` and `list` predicates. */
  local?: Pick<ConditionEvaluator, "evaluate">;
  signal?: AbortSignal;
}

/** A local predicate's failure, carried out of the walk. */
class LocalFailure extends Error {
  constructor(readonly error: ConditionError) {
    super(error.message);
    this.name = "LocalFailure";
  }
}
const isLocalFailure = (error: unknown): error is LocalFailure =>
  typeof error === "object" && error !== null && "name" in error && error.name === "LocalFailure";

/** A failed evaluation: what a condition and an aggregate return alike. */
type Failed = Extract<EvaluationResult, { ok: false }>;

const sourceFailure = (error: SourceError): ConditionError => ({
  kind: error.kind === "transient" ? "source_transient" : "source_permanent",
  message: error.message,
});

/** The failure of a walk as a result; anything else (a caller's abort) is thrown on. */
function failed(error: unknown): Failed {
  if (isSourceError(error)) {
    return { ok: false, error: sourceFailure(error) };
  }
  if (isLocalFailure(error)) {
    return { ok: false, error: error.error };
  }
  if (error instanceof ContextError) {
    return { ok: false, error: { kind: "context", message: error.message } };
  }
  throw error;
}

function user(context: SourceContext): string {
  if (context.externalId === null || !context.externalId) {
    throw new SourceError(
      "permanent",
      "The subscriber has no external ID, so the source cannot be read for it",
    );
  }
  return context.externalId;
}

/** The lower bound of `since`, or undefined for none. */
function after(context: SourceContext, since: string | undefined): Date | undefined {
  if (since === undefined) {
    return undefined;
  }
  const bound = sinceBound(
    { ...context, subscriberId: context.subscriberId ?? 0n },
    instant(context.now, "now"),
    since,
  );
  return bound ? new Date(bound) : undefined;
}

/**
 * The upper bound of every window (D180): the trigger record for a trigger condition, else `now`
 * plus the ahead tolerance a pushed event's `occurred_at` gets when it arrives.
 */
function through(context: SourceContext): Date {
  return context.through ?? new Date(context.now.getTime() + MAX_OCCURRED_AHEAD_MS);
}

/** A value PocketBase's filter can compare exactly as a superset of the strict rule. */
function filterable(path: string, value: Scalar): boolean {
  const segments = path.split(".");
  if (segments.length > FILTER_SEGMENTS || !segments.every((part) => filterSegment.test(part))) {
    return false;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && !/e/i.test(String(value));
  }
  return typeof value !== "string" || !value.includes("\0");
}

/** The events query of a window: the user, the name, the bounds and the stateable `where` parts. */
function windowQuery(
  userId: string,
  name: string,
  bounds: { after: Date | undefined; through: Date | undefined },
  where?: Readonly<Record<string, Scalar>>,
): EventQuery {
  const query: EventQuery = { user: userId, names: [name] };
  if (bounds.after) {
    query.after = bounds.after;
  }
  if (bounds.through) {
    query.through = bounds.through;
  }
  if (where) {
    const data: Record<string, SourceScalar> = {};
    for (const [key, value] of Object.entries(where)) {
      const path = key.slice("data.".length);
      if (filterable(path, value)) {
        data[path] = value;
      }
    }
    if (Object.keys(data).length) {
      query.data = data;
    }
  }
  return query;
}

/**
 * How many of the user's events in the window match `where` strictly, counting no further than
 * `need`. A count that cannot be decided within `SCAN_LIMIT` records is a permanent failure.
 */
async function countMatches(
  source: ExternalSource,
  query: EventQuery,
  where: Readonly<Record<string, Scalar>> | undefined,
  need: number,
  call: CallOptions,
): Promise<number> {
  if (!where) {
    return source.count(query, need, call);
  }
  let matched = 0,
    read = 0;
  let last: string | undefined;
  for await (const page of source.scan(query, ["data"], SCAN_LIMIT, call)) {
    for (const row of page) {
      read++;
      last = row.id;
      if (whereHolds(row.data, where) && ++matched >= need) {
        return matched;
      }
    }
  }
  // A window of exactly `SCAN_LIMIT` records was read whole when its last record is the newest
  // match in the same `(occurredAt, id)` order; any other answer means a further page (D180).
  if (read >= SCAN_LIMIT && (await source.latest(query, call))?.id !== last) {
    throw new SourceError(
      "permanent",
      `An event condition read ${SCAN_LIMIT} source records without deciding`,
    );
  }
  return matched;
}

/** Whether `n` (capped at the largest comparand + 1) is within every comparator. */
function within(n: number, count: EventCount): boolean {
  return (
    (count.gte === undefined || n >= count.gte) &&
    (count.lte === undefined || n <= count.lte) &&
    (count.eq === undefined || n === count.eq)
  );
}

/** The fewest matches that decide every comparator: one past the largest one that bounds above. */
function needed(count: EventCount): number {
  return Math.max(
    count.gte ?? 0,
    count.lte === undefined ? 0 : count.lte + 1,
    count.eq === undefined ? 0 : count.eq + 1,
  );
}

/**
 * Evaluates a validated condition of an external sequence. `all` and `any` stop at the first
 * deciding child, so a source is read no more than the answer needs; the recipient row is read at
 * most once per evaluation.
 */
export async function evaluateOnSource(
  condition: Condition,
  context: SourceContext,
  reads: SourceReads,
): Promise<EvaluationResult> {
  const call: CallOptions = reads.signal ? { signal: reads.signal } : {};
  let recipient: Promise<SourceRecipient | null> | undefined;
  const holds = async (c: Condition): Promise<boolean> => {
    if ("all" in c) {
      for (const child of c.all) {
        if (!(await holds(child))) {
          return false;
        }
      }
      return true;
    }
    if ("any" in c) {
      for (const child of c.any) {
        if (await holds(child)) {
          return true;
        }
      }
      return false;
    }
    if ("not" in c) {
      return !(await holds(c.not));
    }
    if ("recipient" in c) {
      recipient ??= reads.source.recipient(user(context), call);
      // A user the view no longer has holds no fields: `exists` is false and `ne` true.
      const row = await recipient;
      return predicateHolds(row ? valueAt(row.fields, c.recipient) : undefined, c.op, c.value);
    }
    if ("event" in c) {
      const count = c.count ?? { gte: 1 };
      const need = needed(count);
      if (!need) {
        return within(0, count);
      }
      const query = windowQuery(
        user(context),
        c.event,
        { after: after(context, c.since), through: through(context) },
        c.where,
      );
      return within(await countMatches(reads.source, query, c.where, need, call), count);
    }
    if ("sql" in c) {
      // Refused when an external sequence is saved; a stored one is never run against the source.
      throw new SourceError("permanent", "An external sequence's condition holds sql");
    }
    // `attr` and `list` read the local subscriber.
    if (!reads.local || context.subscriberId === undefined) {
      throw new LocalFailure({
        kind: "invalid",
        message: "a trigger condition reads the source only",
      });
    }
    const local: ConditionContext = { subscriberId: context.subscriberId, now: context.now };
    if (context.triggerAt !== undefined) {
      local.triggerAt = context.triggerAt;
    }
    if (context.enrolledAt !== undefined) {
      local.enrolledAt = context.enrolledAt;
    }
    if (context.lastStepAt !== undefined) {
      local.lastStepAt = context.lastStepAt;
    }
    const result = await reads.local.evaluate(c, local);
    if (!result.ok) {
      throw new LocalFailure(result.error);
    }
    return result.value;
  };
  try {
    return { ok: true, value: await holds(condition) };
  } catch (error) {
    return failed(error);
  }
}

/** A stored condition of an external sequence: validated as saved, then evaluated. */
export async function evaluateStoredOnSource(
  condition: unknown,
  context: SourceContext,
  reads: SourceReads,
): Promise<EvaluationResult> {
  const checked = validate(condition, { canUseSql: false, source: "external" });
  if (!checked.ok) {
    const first = checked.errors[0];
    return {
      ok: false,
      error: {
        kind: "invalid",
        message: first ? `${first.field}: ${first.message}` : "invalid condition",
      },
    };
  }
  return evaluateOnSource(checked.condition, context, reads);
}

/** `trigger.condition`'s answer for one record (D172): B150d calls it before its write transaction. */
export type TriggerConditionResult =
  | { ok: true; value: boolean }
  | { ok: false; kind: "transient" | "permanent"; message: string };

/**
 * Evaluates an external sequence's `trigger.condition` for the user of an arriving record. Durations
 * count back from the record's `occurredAt`, and every window ends at it (inclusive), so the record
 * itself counts. Only `event` and `recipient` predicates are allowed (validated on save); a stored
 * condition that no longer validates is a permanent failure. A network call: never call it inside a
 * transaction.
 */
export async function evaluateTriggerCondition(
  source: ExternalSource,
  condition: unknown,
  userId: string,
  record: { occurredAt: Date },
  options: { signal?: AbortSignal } = {},
): Promise<TriggerConditionResult> {
  const checked = validate(condition, {
    canUseSql: false,
    source: "external",
    trigger: true,
    field: "trigger.condition",
  });
  if (!checked.ok) {
    const first = checked.errors[0];
    return {
      ok: false,
      kind: "permanent",
      message: first ? `${first.field}: ${first.message}` : "invalid trigger condition",
    };
  }
  const reads: SourceReads = { source };
  if (options.signal) {
    reads.signal = options.signal;
  }
  const result = await evaluateOnSource(
    checked.condition,
    { externalId: userId, now: record.occurredAt, through: record.occurredAt },
    reads,
  );
  if (result.ok) {
    return result;
  }
  return {
    ok: false,
    kind: result.error.kind === "source_transient" ? "transient" : "permanent",
    message: result.error.message,
  };
}

/** A running `sum`: exact integers as BigInt; any fraction makes it a float sum, as SQLite's does. */
function summer() {
  let integers = 0n,
    floats = 0,
    fractional = false,
    unsafe = false;
  return {
    add(value: number) {
      if (Number.isInteger(value) && !fractional) {
        // A stored integer past 2^53 was rounded when it was parsed: its sum is not exact.
        if (Math.abs(value) > SAFE) {
          unsafe = true;
        }
        integers += BigInt(value);
        return;
      }
      if (!fractional) {
        fractional = true;
        floats = Number(integers);
      }
      floats += value;
    },
    total(): number | undefined {
      if (unsafe) {
        return undefined;
      }
      const total = fractional ? floats : Number(integers);
      if (!fractional && (integers > BigInt(SAFE) || integers < -BigInt(SAFE))) {
        return undefined;
      }
      return Math.abs(total) <= SAFE ? total : undefined;
    },
  };
}

/** One aggregate over the rows of its window; `undefined` when it has no exact total. */
async function aggregateOne(
  aggregate: Aggregate,
  context: SourceContext,
  reads: SourceReads,
  call: CallOptions,
): Promise<number | "limit"> {
  const query = windowQuery(user(context), aggregate.event, {
    after: after(context, aggregate.since),
    through: through(context),
  });
  const path = aggregate.field?.slice("data.".length);
  let read = 0,
    count = 0;
  const sum = summer();
  const numbers = new Set<number>(),
    texts = new Set<string>(),
    booleans = new Set<boolean>();
  for await (const page of reads.source.scan(query, ["data"], AGGREGATE_LIMIT + 1, call)) {
    read += page.length;
    if (read > AGGREGATE_LIMIT) {
      return "limit";
    }
    for (const row of page) {
      if (!whereHolds(row.data, aggregate.where)) {
        continue;
      }
      if (aggregate.fn === "count") {
        count++;
        continue;
      }
      const value = valueAt(row.data, path ?? "");
      if (aggregate.fn === "sum") {
        if (typeof value === "number") {
          sum.add(value);
        }
      } else if (typeof value === "number") {
        numbers.add(value);
      } else if (typeof value === "string") {
        texts.add(value);
      } else if (typeof value === "boolean") {
        booleans.add(value);
      }
    }
  }
  if (aggregate.fn === "count") {
    return count;
  }
  if (aggregate.fn === "distinct") {
    return numbers.size + texts.size + booleans.size;
  }
  return sum.total() ?? "limit";
}

/**
 * Every aggregate of one step for one subscriber, from the source. The result has the local
 * aggregates' shape: no total at all when any aggregate is past its bounds.
 */
export async function aggregateOnSource(
  aggregates: Record<string, Aggregate>,
  context: SourceContext,
  reads: SourceReads,
): Promise<AggregateResult> {
  const call: CallOptions = reads.signal ? { signal: reads.signal } : {};
  const values: Array<[string, number]> = [];
  try {
    for (const [name, aggregate] of Object.entries(aggregates)) {
      const value = await aggregateOne(aggregate, context, reads, call);
      if (value === "limit") {
        return { ok: false, limit: true };
      }
      values.push([name, value]);
    }
  } catch (error) {
    return failed(error);
  }
  // Each name an own property, so `__proto__` stays data.
  return { ok: true, values: Object.fromEntries(values) };
}
