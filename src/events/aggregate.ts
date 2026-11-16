// Event aggregates for sequence step templates (docs/design/05-sequences.md#aggregates, D100);
// no upstream source. The events module owns `events`, so the one read that counts, sums or
// distinct-counts a `data` field lives here. Each aggregate is one statement bound to the
// subscriber, on the `(subscriber_id, name, occurred_at)` index. `where` and `since` compile with
// the condition language's own pieces, so an aggregate matches exactly the events a condition
// with the same predicate would count.
import type { Database, Statement } from "bun:sqlite";
import { compareSQL, jsonPath, type Param } from "@/conditions/json";
import { ContextError, instant, sinceBound, subscriberID } from "@/conditions/since";
import type { ConditionContext, ConditionError, Scalar } from "@/conditions/types";

/** Prepared statements kept per reader; the least recently used is finalized beyond it. */
const CACHE = 64;
const SAFE = Number.MAX_SAFE_INTEGER;

export type AggregateFn = "count" | "sum" | "distinct";

/** One aggregate as a sequence step stores it. Validated by sequences before it reaches here. */
export interface Aggregate {
  event: string;
  since?: string;
  where?: Record<string, Scalar>;
  fn: AggregateFn;
  /** A `data.*` path, for `sum` and `distinct`. */
  field?: string;
}

export type AggregateResult =
  | { ok: true; values: Record<string, number> }
  | { ok: false; error: ConditionError };

/**
 * The SQL of one aggregate and the arguments it binds for one subscriber and lower bound
 * (`after`, "" for none). Only the statement's shape is cached; values are bound each time.
 */
interface Compiled {
  sql: string;
  args: (id: bigint, after: string | undefined) => Param[];
}

function compile(aggregate: Aggregate): Compiled {
  const { event, where, fn, field } = aggregate;
  const filters: string[] = ["events.subscriber_id = ?", "events.name = ?"];
  const filterArgs: Param[] = [];
  // Filters bind in text order: subscriber, name, the lower bound, then each `where` field.
  const bound = aggregate.since !== undefined;
  if (bound) filters.push("events.occurred_at > ?");
  for (const [key, value] of Object.entries(where ?? {})) {
    const part = compareSQL("events.data", key.slice("data.".length), "eq", value);
    filters.push(part.sql);
    filterArgs.push(...(part.args as Param[]));
  }
  const from = `FROM events WHERE ${filters.join(" AND ")}`;
  const path = field === undefined ? "" : jsonPath(field.slice("data.".length));
  const numeric = "json_type(events.data, ?) IN ('integer', 'real')";
  let select: string;
  // Parameters of the select list come before the filters in the statement text.
  let selectArgs: Param[];
  if (fn === "count") {
    select = "count(*)";
    selectArgs = [];
  } else if (fn === "sum") {
    select = `coalesce(sum(CASE WHEN ${numeric} THEN json_extract(events.data, ?) END), 0)`;
    selectArgs = [path, path];
  } else {
    // Numbers (5 and 5.0 are one value), text (its characters) and booleans (a type of their own)
    // never equal one another, as the condition language's eq does. Missing values, JSON null and
    // objects or arrays, which no eq can match, are not counted.
    select = [
      `count(DISTINCT CASE WHEN ${numeric} THEN json_extract(events.data, ?) END)`,
      "count(DISTINCT CASE WHEN json_type(events.data, ?) = 'text' THEN json_extract(events.data, ?) END)",
      "count(DISTINCT CASE WHEN json_type(events.data, ?) IN ('true', 'false') THEN json_type(events.data, ?) END)",
    ].join(" + ");
    selectArgs = [path, path, path, path, path, path];
  }
  return {
    sql: `SELECT ${select} AS n ${from}`,
    args: (id, after) => {
      const head: Param[] = [...selectArgs, id, event];
      if (bound) head.push(after ?? "");
      return [...head, ...filterArgs];
    },
  };
}

export function createEventAggregates(db: Database) {
  const statements = new Map<string, Statement>();
  const prepared = (sql: string) => {
    let stmt = statements.get(sql);
    if (stmt) statements.delete(sql);
    else stmt = db.prepare(sql);
    statements.set(sql, stmt);
    if (statements.size > CACHE) {
      const [oldest, old] = statements.entries().next().value!;
      statements.delete(oldest);
      old.finalize();
    }
    return stmt;
  };

  return {
    /**
     * Every aggregate of one step for one subscriber, computed against the context's `now`.
     * Values are JSON numbers. A sum beyond the safe integer range is an error rather than a
     * rounded total, and no aggregate is ever truncated: the count is always complete.
     */
    evaluate(aggregates: Record<string, Aggregate>, context: ConditionContext): AggregateResult {
      let id: bigint, now: number;
      try {
        id = subscriberID(context.subscriberId);
        now = instant(context.now, "now");
      } catch (error) {
        if (error instanceof ContextError)
          return { ok: false, error: { kind: "context", message: error.message } };
        return { ok: false, error: { kind: "execution", message: "aggregate query failed" } };
      }
      const values: [string, number][] = [];
      for (const [name, aggregate] of Object.entries(aggregates)) {
        let after: string | undefined;
        try {
          after =
            aggregate.since === undefined ? undefined : sinceBound(context, now, aggregate.since);
        } catch (error) {
          if (error instanceof ContextError)
            return { ok: false, error: { kind: "context", message: error.message } };
          throw error;
        }
        const compiled = compile(aggregate);
        let value: number;
        try {
          const row = prepared(compiled.sql).get(...compiled.args(id, after)) as {
            n: bigint | number | null;
          };
          value = Number(row.n ?? 0);
        } catch {
          return { ok: false, error: { kind: "execution", message: "aggregate query failed" } };
        }
        if (aggregate.fn === "sum" && !(Math.abs(value) <= SAFE))
          return {
            ok: false,
            error: { kind: "execution", message: "aggregate is outside the safe integer range" },
          };
        values.push([name, value]);
      }
      // `Object.fromEntries` defines each name as an own property, so a name such as `__proto__`
      // stays data.
      return { ok: true, values: Object.fromEntries(values) };
    },
    close() {
      for (const stmt of statements.values()) stmt.finalize();
      statements.clear();
    },
  };
}
export type EventAggregates = ReturnType<typeof createEventAggregates>;
