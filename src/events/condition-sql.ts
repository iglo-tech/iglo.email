// Read-only event SQL for sequence conditions (docs/design/05-sequences.md#conditions);
// no upstream source. The events module owns `events`; the condition compiler takes this part.
import { compareSQL, type SQLPart } from "@/conditions/json";
import type { EventCount, Scalar } from "@/conditions/types";

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
  const args: SQLPart<P>["args"] = [input.subscriber, input.name];
  let filter = "events.subscriber_id = ? AND events.name = ?";
  if (input.after !== undefined) {
    filter += " AND events.occurred_at > ?";
    args.push(input.after);
  }
  for (const [key, value] of Object.entries(input.where ?? {})) {
    const part = compareSQL("events.data", key.slice("data.".length), "eq", value);
    filter += ` AND ${part.sql}`;
    args.push(...part.args);
  }
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
