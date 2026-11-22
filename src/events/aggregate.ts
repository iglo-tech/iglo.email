// Event aggregates for sequence step templates (docs/design/05-sequences.md#aggregates, D100);
// no upstream source. The events module owns `events`, so the one read that counts, sums or
// distinct-counts a `data` field lives here. Each aggregate is one statement bound to the
// subscriber, on the `(subscriber_id, name, occurred_at)` index. Its window (`event`, `since`) and
// its `where` come from the condition language's own SQL pieces, so an aggregate matches exactly
// the events a condition with the same predicate would count.
import type { Database, Statement } from "bun:sqlite";
import { jsonPath } from "@/conditions/json";
import type { Param } from "@/conditions/json";
import { ContextError, instant, sinceBound, subscriberID } from "@/conditions/since";
import type { ConditionContext, ConditionError, Scalar } from "@/conditions/types";
import { whereSQL, windowSQL } from "@/events/condition-sql";

/** Prepared statements kept per reader; the least recently used is finalized beyond it. */
const CACHE = 64;
const SAFE = Number.MAX_SAFE_INTEGER;
/**
 * Most events of its name in its window one aggregate may read (D100). `where` does not lower
 * it: an aggregate whose window holds more events is not computed, whatever `where` keeps.
 */
export const AGGREGATE_LIMIT = 10_000;

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
  | { ok: false; error: ConditionError }
  /**
   * An aggregate cannot be computed within its bounds: its window holds more than
   * `AGGREGATE_LIMIT` events, or a sum is outside the exact integer range. No total is returned.
   */
  | { ok: false; limit: true };

/** The statement of one aggregate and the arguments it binds for one subscriber and lower bound. */
interface Compiled {
  sql: string;
  args: Array<Param>;
}

/**
 * One statement. The inner query reads the newest `AGGREGATE_LIMIT + 1` events of the window and
 * marks each one `hit` when `where` holds. The outer query reads all of them, so `scanned` is the
 * window's size (up to the limit) whatever `where` keeps, and the aggregate counts the hits only.
 * `scanned` above the limit means the aggregate is not computed.
 */
function compile(aggregate: Aggregate, subscriber: bigint, after: string | undefined): Compiled {
  const { event, where, fn, field } = aggregate;
  const input: Parameters<typeof windowSQL<Param>>[0] = { subscriber, name: event };
  if (aggregate.since !== undefined) {
    input.after = after ?? "";
  }
  const window = windowSQL<Param>(input);
  const hit = whereSQL(where);
  const path = field === undefined ? "" : jsonPath(field.slice("data.".length));
  const numeric = "json_type(data, ?) IN ('integer', 'real')";
  let select: string;
  // Parameters of the select list come before the statement's own.
  let selectArgs: Array<Param>;
  if (fn === "count") {
    select = "coalesce(sum(hit), 0)";
    selectArgs = [];
  } else if (fn === "sum") {
    select = `coalesce(sum(CASE WHEN hit AND ${numeric} THEN json_extract(data, ?) END), 0)`;
    selectArgs = [path, path];
  } else {
    // Numbers (5 and 5.0 are one value), text (its characters) and booleans (a type of their own)
    // never equal one another, as the condition language's eq does. Missing values, JSON null and
    // objects or arrays, which no eq can match, are not counted.
    select = [
      `count(DISTINCT CASE WHEN hit AND ${numeric} THEN json_extract(data, ?) END)`,
      "count(DISTINCT CASE WHEN hit AND json_type(data, ?) = 'text' THEN json_extract(data, ?) END)",
      "count(DISTINCT CASE WHEN hit AND json_type(data, ?) IN ('true', 'false') THEN json_type(data, ?) END)",
    ].join(" + ");
    selectArgs = [path, path, path, path, path, path];
  }
  const newest = `SELECT events.data AS data, (${hit.sql}) AS hit FROM events WHERE ${window.sql} ORDER BY events.occurred_at DESC LIMIT ${AGGREGATE_LIMIT + 1}`;
  // Parameters bind in text order: the select list, then `where` in the inner list, then the window.
  return {
    sql: `SELECT count(*) AS scanned, ${select} AS n FROM (${newest})`,
    args: [...selectArgs, ...hit.args, ...window.args],
  };
}

export function createEventAggregates(db: Database) {
  const statements = new Map<string, Statement>();
  const prepared = (sql: string) => {
    let stmt = statements.get(sql);
    if (stmt) {
      statements.delete(sql);
    } else {
      stmt = db.prepare(sql);
    }
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
     * Values are JSON numbers and are never truncated: an aggregate that cannot be computed
     * exactly within its bounds returns `{ ok: false, limit: true }` and no total at all.
     */
    evaluate: (
      aggregates: Record<string, Aggregate>,
      context: ConditionContext,
    ): AggregateResult => {
      let id: bigint, now: number;
      try {
        id = subscriberID(context.subscriberId);
        now = instant(context.now, "now");
      } catch (error) {
        if (error instanceof ContextError) {
          return { ok: false, error: { kind: "context", message: error.message } };
        }
        return { ok: false, error: { kind: "execution", message: "aggregate query failed" } };
      }
      const values: Array<[string, number]> = [];
      for (const [name, aggregate] of Object.entries(aggregates)) {
        let after: string | undefined;
        try {
          after =
            aggregate.since === undefined ? undefined : sinceBound(context, now, aggregate.since);
        } catch (error) {
          if (error instanceof ContextError) {
            return { ok: false, error: { kind: "context", message: error.message } };
          }
          throw error;
        }
        const compiled = compile(aggregate, id, after);
        let value: number;
        try {
          const row = prepared(compiled.sql).get(...compiled.args) as {
            scanned: bigint | number;
            n: bigint | number | null;
          };
          if (Number(row.scanned) > AGGREGATE_LIMIT) {
            return { ok: false, limit: true };
          }
          value = Number(row.n ?? 0);
        } catch (error) {
          // SQLite's 64-bit integer sum overflowed: the total is not exact, so none is returned.
          if (error instanceof Error && error.message === "integer overflow") {
            return { ok: false, limit: true };
          }
          return { ok: false, error: { kind: "execution", message: "aggregate query failed" } };
        }
        // A sum past the safe integer range would be a rounded total, so none is returned.
        if (aggregate.fn === "sum" && !(Math.abs(value) <= SAFE)) {
          return { ok: false, limit: true };
        }
        values.push([name, value]);
      }
      // `Object.fromEntries` defines each name as an own property, so a name such as `__proto__`
      // stays data.
      return { ok: true, values: Object.fromEntries(values) };
    },
    close() {
      for (const stmt of statements.values()) {
        stmt.finalize();
      }
      statements.clear();
    },
  };
}
export type EventAggregates = ReturnType<typeof createEventAggregates>;
