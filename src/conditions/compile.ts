// Compilation of a validated condition to one parameterized statement
// (docs/design/05-sequences.md#conditions); no upstream source. Values, paths, names and list
// IDs are bound parameters; context times are bound when the condition is evaluated.
import { formatSQLExp } from "@/subscribers/query-filter";
import { eventCountSQL } from "@/events/condition-sql";
import type { SQLPart } from "@/conditions/json";
import type { Condition, Since } from "@/conditions/types";
import {
  attributeSQL,
  membershipSQL,
  statusSQL,
  subscriberConditionSQL,
} from "@/subscribers/condition-sql";

/** A parameter filled from the evaluation context. */
export type Slot =
  | { slot: "subscriber" }
  | { slot: "after"; since: Since }
  | { slot: "sql"; index: number };

export interface CompiledCondition {
  /** One SELECT yielding 0 or 1 for the subscriber, or no row when it does not exist. */
  sql: string;
  params: SQLPart<Slot>["args"];
  /** Raw `sql` fragments, run in the read-only child; their results bind to `sql` slots. */
  fragments: string[];
}

const subscriber: Slot = { slot: "subscriber" };
export const defaultListStatuses = ["unconfirmed", "confirmed"];

export function compile(condition: Condition): CompiledCondition {
  const fragments: string[] = [];
  const part = (c: Condition): SQLPart<Slot> => {
    if ("all" in c || "any" in c) {
      const items = "all" in c ? c.all : c.any;
      const parts = items.map(part);
      return {
        sql: `(${parts.map((p) => p.sql).join("all" in c ? " AND " : " OR ")})`,
        args: parts.flatMap((p) => p.args),
      };
    }
    if ("not" in c) {
      const inner = part(c.not);
      return { sql: `(NOT ${inner.sql})`, args: inner.args };
    }
    if ("sql" in c) {
      fragments.push(formatSQLExp(c.sql));
      return { sql: "(? = 1)", args: [{ slot: "sql", index: fragments.length - 1 }] };
    }
    if ("list" in c) return membershipSQL(c.list, c.status ?? defaultListStatuses);
    if ("attr" in c) {
      if (c.attr === "status") {
        const values = (Array.isArray(c.value) ? c.value : [c.value]) as string[];
        return statusSQL(values, c.op === "ne");
      }
      return attributeSQL(c.attr, c.op, c.value);
    }
    return eventCountSQL<Slot>({
      subscriber,
      name: c.event,
      ...(c.since !== undefined ? { after: { slot: "after", since: c.since } } : {}),
      ...(c.where ? { where: c.where } : {}),
      count: c.count ?? { gte: 1 },
    });
  };
  const statement = subscriberConditionSQL(part(condition), subscriber);
  return { sql: statement.sql, params: statement.args, fragments };
}
