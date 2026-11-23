// Read-only subscriber SQL for sequence conditions (docs/design/05-sequences.md#conditions);
// no upstream source. The subscribers module owns `subscribers` and `subscriber_lists`, so the
// condition compiler takes these parts instead of querying the tables itself.
import { compareSQL, existsSQL, inSQL } from "@/conditions/json";
import type { CompareOp, SQLPart } from "@/conditions/json";
import type { Scalar } from "@/conditions/types";
import { fragmentConditionSQL } from "@/subscribers/query-filter";
import type { Scope } from "@/subscribers/store";

const attribs = "subscribers.attribs";

/** A typed comparison of an attribute path (see the type rules in conditions/json). */
export function attributeSQL(
  path: string,
  op: CompareOp | "ne" | "in" | "exists",
  value?: Scalar | Array<Scalar>,
): SQLPart {
  if (op === "exists") {
    return existsSQL(attribs, path);
  }
  if (op === "in") {
    return inSQL(attribs, path, value as Array<Scalar>);
  }
  if (op === "ne") {
    const eq = compareSQL(attribs, path, "eq", value as Scalar);
    return { sql: `NOT ${eq.sql}`, args: eq.args };
  }
  return compareSQL(attribs, path, op, value as Scalar);
}

/** The subscriber's status equals (or with `negate`, differs from) any of `statuses`. */
export function statusSQL(statuses: Array<string>, negate = false): SQLPart {
  return {
    sql: `subscribers.status ${negate ? "NOT IN" : "IN"} (${statuses.map(() => "?").join(", ")})`,
    args: statuses,
  };
}

/** Membership of the subscriber in `list` with one of `statuses`; uses the primary key. */
export function membershipSQL(list: number, statuses: Array<string>): SQLPart {
  return {
    sql: `EXISTS (SELECT 1 FROM subscriber_lists WHERE subscriber_lists.subscriber_id = subscribers.id AND subscriber_lists.list_id = ? AND subscriber_lists.status IN (${statuses.map(() => "?").join(", ")}))`,
    args: [list, ...statuses],
  };
}

/**
 * The subscriber in `column` has a membership on one of the lists of `scope`, in any status: the rule a
 * subscriber read applies, for the send log's list-scoped reads (B117d, D139). The subquery reads the
 * list's members from the subscriber_lists list index; callers check `scope.all` first, since a reader of
 * every list needs no filter.
 */
export function inListScopeSQL(column: string, scope: Scope): SQLPart {
  return {
    sql: `${column} IN (SELECT m.subscriber_id FROM subscriber_lists m WHERE m.list_id IN (SELECT value FROM json_each(?)))`,
    args: [`[${scope.ids.join(",")}]`],
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
 * The part for a raw segment-query fragment: true when it matches the subscriber. Its text
 * contains a fragment slot that only the read-only child fills, after checking the fragment
 * (prepareCondition), so the whole condition runs there in one snapshot.
 */
export function fragmentPartSQL<P>(subscriber: P): SQLPart<P> {
  return { sql: fragmentConditionSQL, args: [subscriber] };
}
