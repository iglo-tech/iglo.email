// Read-only event SQL for sequence conditions (docs/design/05-sequences.md#conditions);
// no upstream source. The events module owns `events`; the condition compiler takes this part.
import { compareSQL, type SQLPart } from "@/conditions/json";
import type { EventCount, Scalar } from "@/conditions/types";

/**
 * The subscriber's events named `name` that occurred after `after` (exclusive; undefined for no
 * lower bound): the window of a condition or an aggregate, on the `(subscriber_id, name,
 * occurred_at)` index. The events table's own predicate, so every owner of a window agrees on it.
 */
export function windowSQL<P>(input: { subscriber: P; name: string; after?: P }): SQLPart<P> {
  const args: SQLPart<P>["args"] = [input.subscriber, input.name];
  let sql = "events.subscriber_id = ? AND events.name = ?";
  if (input.after !== undefined) {
    sql += " AND events.occurred_at > ?";
    args.push(input.after);
  }
  return { sql, args };
}

/**
 * Every `where` data path equal to its value, as one predicate over `events.data`, always 0 or 1.
 * `1` when there are none. Shared by conditions and aggregates, so both match the same events.
 */
export function whereSQL(where?: Record<string, Scalar>): SQLPart {
  const parts = Object.entries(where ?? {}).map(([key, value]) =>
    compareSQL("events.data", key.slice("data.".length), "eq", value),
  );
  if (!parts.length) return { sql: "1", args: [] };
  return {
    sql: parts.map((part) => part.sql).join(" AND "),
    args: parts.flatMap((part) => part.args),
  };
}

/**
 * Whether the subscriber's events named `name`, after `after` (exclusive) and matching every
 * `where` data path, number within `count`. It searches the `(subscriber_id, name, occurred_at)`
 * index and stops counting one past the largest comparand, so the work per subscriber is
 * bounded by the matching rows it visits. Always 0 or 1.
 */
export function eventCountSQL<P>(input: {
  subscriber: P;
  name: string;
  /** An occurred_at instant in the stored ISO format, or undefined for no lower bound. */
  after?: P;
  where?: Record<string, Scalar>;
  count: EventCount;
}): SQLPart<P> {
  const window = windowSQL(input);
  const where = whereSQL(input.where);
  const filter = `${window.sql} AND ${where.sql}`;
  const args: SQLPart<P>["args"] = [...window.args, ...where.args];
  const { gte, lte, eq } = input.count;
  const tests: string[] = [];
  const bounds: number[] = [];
  for (const [operator, n] of [
    [">=", gte],
    ["<=", lte],
    ["=", eq],
  ] as const)
    if (n !== undefined) {
      tests.push(`n ${operator} ?`);
      bounds.push(n);
    }
  // Parameters bind in text order: the comparands come before the filter.
  return {
    sql: `(SELECT ${tests.join(" AND ")} FROM (SELECT count(*) AS n FROM (SELECT 1 FROM events WHERE ${filter} LIMIT ?)))`,
    args: [...bounds, ...args, Math.max(...bounds) + 1],
  };
}
