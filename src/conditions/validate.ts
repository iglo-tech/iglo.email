// Validation of the sequence condition language (docs/design/05-sequences.md#conditions);
// no upstream source. The walk checks bounds before it descends or iterates, so hostile
// nesting and huge arrays cost no more than the limits allow.
import { parseDuration } from "@/conditions/duration";
import { validPath } from "@/conditions/json";
import {
  limits,
  type Condition,
  type FieldError,
  type Scalar,
  type ValidationResult,
} from "@/conditions/types";
import { checkFragment, formatSQLExp } from "@/subscribers/query-filter";

const kinds = ["all", "any", "not", "event", "attr", "list", "sql"] as const;
const fieldsOf: Record<(typeof kinds)[number], readonly string[]> = {
  all: ["all"],
  any: ["any"],
  not: ["not"],
  event: ["event", "since", "where", "count"],
  attr: ["attr", "op", "value"],
  list: ["list", "status"],
  sql: ["sql"],
};
const ops = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "exists"];
const subscriberStatuses = ["enabled", "disabled", "blocklisted"];
const listStatuses = ["unconfirmed", "confirmed", "unsubscribed"];
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const safeKey = /^[A-Za-z0-9_.-]{1,64}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const bytes = (value: string) => Buffer.byteLength(value);

const unsafeNumber =
  "number must be a safe integer (within ±9007199254740991) or a finite fraction";

class Stop extends Error {}

export function validate(
  condition: unknown,
  options: { canUseSql: boolean; field?: string },
): ValidationResult {
  const errors: FieldError[] = [];
  let nodes = 0,
    sqls = 0;
  const fail = (field: string, message: string) => {
    errors.push({ field, message });
    if (errors.length >= limits.errors) throw new Stop();
  };

  const scalar = (value: unknown, field: string, ordered = false): Scalar | undefined => {
    if (typeof value === "string") {
      if (value !== value.toWellFormed() || bytes(value) > limits.stringBytes)
        return void fail(field, "invalid text value");
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return void fail(field, "number must be finite");
      // SQLite keeps JSON integers as exact int64; a JavaScript number past 2^53 is already
      // rounded, so it could differ from the stored value it was meant to equal.
      if (
        (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
        Number(String(value)) !== value
      )
        return void fail(field, unsafeNumber);
      return value;
    }
    if (typeof value === "boolean") {
      if (ordered) return void fail(field, "booleans cannot be ordered");
      return value;
    }
    return void fail(field, "must be a string, number or boolean");
  };

  const walk = (value: unknown, field: string, depth: number): Condition | undefined => {
    if (depth > limits.depth) return void fail(field, "nesting is too deep");
    if (++nodes > limits.nodes) return void fail(field, "too many conditions");
    if (!isObject(value)) return void fail(field, "must be a condition object");
    const keys = Object.keys(value);
    const present = kinds.filter((kind) => Object.hasOwn(value, kind));
    if (present.length !== 1)
      return void fail(field, "must have exactly one of all, any, not, event, attr, list or sql");
    const kind = present[0]!;
    for (const key of keys)
      if (!fieldsOf[kind].includes(key))
        return void fail(safeKey.test(key) ? `${field}.${key}` : field, "unknown field");

    if (kind === "all" || kind === "any") {
      const items = value[kind];
      if (!Array.isArray(items) || !items.length)
        return void fail(`${field}.${kind}`, "must be a non-empty array of conditions");
      if (nodes + items.length > limits.nodes)
        return void fail(`${field}.${kind}`, "too many conditions");
      const out: Condition[] = [];
      for (const [i, item] of items.entries()) {
        const child = walk(item, `${field}.${kind}.${i}`, depth + 1);
        if (child) out.push(child);
      }
      return kind === "all" ? { all: out } : { any: out };
    }
    if (kind === "not") {
      if (!isObject(value.not)) return void fail(`${field}.not`, "must be a condition object");
      const child = walk(value.not, `${field}.not`, depth + 1);
      return child && { not: child };
    }
    if (kind === "sql") {
      const sql = value.sql;
      if (!options.canUseSql)
        return void fail(`${field}.sql`, "permission denied for raw SQL conditions");
      if (++sqls > limits.sqlPredicates)
        return void fail(`${field}.sql`, "too many sql conditions");
      if (typeof sql !== "string" || sql.length > limits.sqlLength || !formatSQLExp(sql))
        return void fail(`${field}.sql`, "must be a non-empty SQL expression");
      const problem = checkFragment(formatSQLExp(sql));
      if (problem) return void fail(`${field}.sql`, problem);
      return { sql };
    }
    if (kind === "list") {
      const list = value.list;
      if (typeof list !== "number" || !Number.isSafeInteger(list) || list < 1)
        return void fail(`${field}.list`, "must be a list ID");
      if (value.status === undefined) return { list };
      const status = value.status;
      if (!Array.isArray(status) || !status.length || status.length > listStatuses.length)
        return void fail(`${field}.status`, "must be a non-empty array of subscription statuses");
      let valid = true;
      for (const [i, s] of status.entries())
        if (typeof s !== "string" || !listStatuses.includes(s)) {
          fail(`${field}.status.${i}`, "unknown subscription status");
          valid = false;
        }
      return valid ? { list, status: [...(status as string[])] } : undefined;
    }
    if (kind === "attr") return attr(value, field);
    return event(value, field);
  };

  const attr = (value: Record<string, unknown>, field: string): Condition | undefined => {
    const path = value.attr,
      op = value.op;
    if (typeof path !== "string" || (path !== "status" && !validPath(path)))
      return void fail(`${field}.attr`, "must be an attribute name or dotted path");
    if (typeof op !== "string" || !ops.includes(op))
      return void fail(`${field}.op`, "unknown operator");
    const status = path === "status";
    if (status && !["eq", "ne", "in"].includes(op))
      return void fail(`${field}.op`, "status supports eq, ne and in");
    const checkStatus = (v: Scalar | undefined, f: string) => {
      if (v === undefined) return undefined;
      if (status && (typeof v !== "string" || !subscriberStatuses.includes(v)))
        return void fail(f, "unknown subscriber status");
      return v;
    };
    if (op === "exists") {
      if (value.value !== undefined) return void fail(`${field}.value`, "exists takes no value");
      return { attr: path, op };
    }
    if (op === "in") {
      const list = value.value;
      if (!Array.isArray(list) || !list.length || list.length > limits.inValues)
        return void fail(`${field}.value`, `must be an array of 1 to ${limits.inValues} values`);
      const out: Scalar[] = [];
      for (const [i, item] of list.entries()) {
        const v = checkStatus(scalar(item, `${field}.value.${i}`), `${field}.value.${i}`);
        if (v !== undefined) out.push(v);
      }
      return out.length === list.length ? { attr: path, op, value: out } : undefined;
    }
    if (value.value === undefined) return void fail(`${field}.value`, "is required");
    const ordered = op !== "eq" && op !== "ne";
    const v = checkStatus(scalar(value.value, `${field}.value`, ordered), `${field}.value`);
    return v === undefined ? undefined : { attr: path, op: op as "eq", value: v };
  };

  const event = (value: Record<string, unknown>, field: string): Condition | undefined => {
    const name = value.event;
    if (
      typeof name !== "string" ||
      !name ||
      name !== name.toWellFormed() ||
      controls.test(name) ||
      bytes(name) > limits.eventNameBytes
    )
      return void fail(`${field}.event`, "must be an event name");
    const out: Condition & { event: string } = { event: name };
    let valid = true;
    const since = value.since;
    if (since !== undefined) {
      if (
        typeof since !== "string" ||
        (!["trigger", "enrollment", "last_step"].includes(since) &&
          parseDuration(since) === undefined)
      ) {
        fail(`${field}.since`, "must be trigger, enrollment, last_step or an ISO 8601 duration");
        valid = false;
      } else out.since = since;
    }
    const where = value.where;
    if (where !== undefined) {
      const entries = isObject(where) ? Object.entries(where) : [];
      if (!entries.length || entries.length > limits.whereFields) {
        fail(`${field}.where`, `must be an object of 1 to ${limits.whereFields} data fields`);
        valid = false;
      } else {
        const copy: Record<string, Scalar> = {};
        for (const [key, v] of entries) {
          if (!key.startsWith("data.") || !validPath(key.slice(5))) {
            fail(`${field}.where`, "fields must be data.* paths");
            valid = false;
            continue;
          }
          const s = scalar(v, `${field}.where.${key}`);
          if (s === undefined) valid = false;
          else copy[key] = s;
        }
        out.where = copy;
      }
    }
    const count = value.count;
    if (count !== undefined) {
      const entries = isObject(count) ? Object.entries(count) : [];
      if (!entries.length) {
        fail(`${field}.count`, "must be an object with gte, lte or eq");
        valid = false;
      } else {
        const copy: Record<string, number> = {};
        for (const [key, n] of entries) {
          if (!["gte", "lte", "eq"].includes(key)) {
            fail(
              safeKey.test(key) ? `${field}.count.${key}` : `${field}.count`,
              "unknown comparator",
            );
            valid = false;
          } else if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > limits.count) {
            fail(`${field}.count.${key}`, `must be an integer from 0 to ${limits.count}`);
            valid = false;
          } else copy[key] = n;
        }
        out.count = copy;
      }
    }
    return valid ? out : undefined;
  };

  let result: Condition | undefined;
  try {
    result = walk(condition, options.field ?? "condition", 1);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
  }
  return errors.length || !result ? { ok: false, errors } : { ok: true, condition: result };
}
