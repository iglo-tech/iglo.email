// The condition language's type rules on JSON values already read (docs/design/05-sequences.md
// #conditions, 15-external-sources section 6, D172); no upstream source. External sequences read
// records from the source, whose filters compare JSON loosely (spec section 9), so every `where`,
// `recipient` and aggregate value is compared again here with the rules src/conditions/json.ts
// gives SQLite:
// - A path walks object keys only; a missing key, an array or a scalar on the way is missing.
// - A string equals only the same text, a number only a number of the same value (`5` = `5.0`), a
//   boolean only the same boolean. Nothing is coerced: `"5"` is not `5` and `true` is not `1`.
// - Ordering compares numbers numerically and text by code point (UTF-8 byte order), and is false
//   for a missing field or another type. `ne` negates `eq`; `in` is `eq` against any value;
//   `exists` is present and not null.
import type { CompareOp } from "@/conditions/json";
import type { AttrOp, Scalar } from "@/conditions/types";
import type { SourceJson } from "@/sources/json";

/** A JSON value as the source answered it: `undefined` stands for a missing field. */
export type JsonValue = SourceJson;

const isObject = (value: JsonValue | undefined): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isList = (value: Scalar | ReadonlyArray<Scalar>): value is ReadonlyArray<Scalar> =>
  Array.isArray(value);

/** The value at a dotted path of object keys, or `undefined` when it is missing. */
export function valueAt(root: JsonValue | undefined, path: string): JsonValue | undefined {
  let value: JsonValue | undefined = root;
  for (const key of path.split(".")) {
    if (!isObject(value) || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

/** Code point order, as SQLite compares UTF-8 text. */
function textOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}

/** `field` compared with `value` under the type rules; false for a missing field or another type. */
export function compareStrict(field: JsonValue | undefined, op: CompareOp, value: Scalar): boolean {
  if (typeof value === "boolean") {
    return op === "eq" && field === value;
  }
  let order: number;
  if (typeof value === "number") {
    if (typeof field !== "number") {
      return false;
    }
    order = field === value ? 0 : field < value ? -1 : 1;
  } else {
    if (typeof field !== "string") {
      return false;
    }
    order = textOrder(field, value);
  }
  if (op === "eq") {
    return order === 0;
  }
  if (op === "gt") {
    return order > 0;
  }
  if (op === "gte") {
    return order >= 0;
  }
  if (op === "lt") {
    return order < 0;
  }
  return order <= 0;
}

/** An `attr`-style predicate (`op`, `value`) on a value already read. */
export function predicateHolds(
  field: JsonValue | undefined,
  op: AttrOp,
  value: Scalar | ReadonlyArray<Scalar> | undefined,
): boolean {
  if (op === "exists") {
    return field !== undefined && field !== null;
  }
  if (value === undefined) {
    return false;
  }
  if (isList(value)) {
    return op === "in" && value.some((item) => compareStrict(field, "eq", item));
  }
  const scalar = value;
  if (op === "in") {
    return compareStrict(field, "eq", scalar);
  }
  if (op === "ne") {
    return !compareStrict(field, "eq", scalar);
  }
  return compareStrict(field, op, scalar);
}

/** Every `data.<path>` equality of a `where` holds on a record's data. */
export function whereHolds(
  data: JsonValue | undefined,
  where: Readonly<Record<string, Scalar>> | undefined,
): boolean {
  if (!where) {
    return true;
  }
  for (const [key, value] of Object.entries(where)) {
    if (!compareStrict(valueAt(data, key.slice("data.".length)), "eq", value)) {
      return false;
    }
  }
  return true;
}
