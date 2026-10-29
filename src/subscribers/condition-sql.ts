// Read-only subscriber SQL for sequence conditions (docs/design/05-sequences.md#conditions);
// no upstream source. The subscribers module owns `subscribers` and `subscriber_lists`, so the
// condition compiler takes these parts instead of querying the tables itself.
import { compareSQL, existsSQL, inSQL, type CompareOp, type SQLPart } from "@/conditions/json";
import type { Scalar } from "@/conditions/types";
import { idsSQL, type Arg } from "@/subscribers/query-filter";

const attribs = "subscribers.attribs";

/** A typed comparison of an attribute path (see the type rules in conditions/json). */
export function attributeSQL(
  path: string,
  op: CompareOp | "ne" | "in" | "exists",
  value?: Scalar | Scalar[],
): SQLPart {
  if (op === "exists") return existsSQL(attribs, path);
  if (op === "in") return inSQL(attribs, path, value as Scalar[]);
  if (op === "ne") {
    const eq = compareSQL(attribs, path, "eq", value as Scalar);
    return { sql: `NOT ${eq.sql}`, args: eq.args };
  }
  return compareSQL(attribs, path, op, value as Scalar);
}

/** The subscriber's status equals (or with `negate`, differs from) any of `statuses`. */
export function statusSQL(statuses: string[], negate = false): SQLPart {
  return {
    sql: `subscribers.status ${negate ? "NOT IN" : "IN"} (${statuses.map(() => "?").join(", ")})`,
    args: statuses,
  };
}

/** Membership of the subscriber in `list` with one of `statuses`; uses the primary key. */
export function membershipSQL(list: number, statuses: string[]): SQLPart {
  return {
    sql: `EXISTS (SELECT 1 FROM subscriber_lists WHERE subscriber_lists.subscriber_id = subscribers.id AND subscriber_lists.list_id = ? AND subscriber_lists.status IN (${statuses.map(() => "?").join(", ")}))`,
    args: [list, ...statuses],
  };
}

/**
 * One statement that yields 0 or 1 for the subscriber whose ID is the last argument, or no row
 * when it does not exist. `expression` is built from the parts above and other owners' parts.
 */
export function subscriberConditionSQL<P>(expression: SQLPart<P>, subscriber: P): SQLPart<P> {
  return {
    sql: `SELECT coalesce((${expression.sql}), 0) AS matched FROM subscribers WHERE subscribers.id = ?`,
    args: [...expression.args, subscriber],
  };
}

/**
 * A raw segment-query fragment checked for one subscriber, in M1.7's query shape, for the
 * read-only child runner: it yields the subscriber's ID when the fragment matches.
 */
export function fragmentSQL(fragment: string, subscriber: bigint): { sql: string; args: Arg[] } {
  return idsSQL(
    { lists: null, subscriptionStatus: "", search: "", subscriberStatus: "", fragment },
    { only: [subscriber] },
  );
}
