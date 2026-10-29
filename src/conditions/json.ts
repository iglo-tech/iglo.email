// Typed comparisons of JSON object fields for conditions (docs/design/05-sequences.md#conditions);
// no upstream source. Owners of JSON columns build their predicates with these, so every
// condition compares values the same way. Paths and values are always bound parameters.
//
// Type rules:
// - A path walks object keys only (`a.b` is `$."a"."b"`); a missing key, an array or a scalar
//   on the way makes the field missing.
// - A string value equals only JSON text with the same characters; a number only a JSON number
//   with the same numeric value (`5` equals `5.0`); a boolean only the same JSON boolean.
//   Nothing is coerced: `"5"` never equals `5`, and `true` never equals `1`.
// - A condition's numbers are safe integers (within ±(2^53 − 1)) or finite fractions; validation
//   refuses others, which JSON parsing has already rounded. Stored numbers of any size compare
//   with them exactly, as SQLite compares int64 and double values.
// - Ordering (`gt`, `gte`, `lt`, `lte`) compares numbers numerically and text by UTF-8 bytes
//   (code point order). It is false when the field is missing or of another type.
// - `ne` is the negation of `eq`, so it holds for a missing field or a field of another type.
// - `in` holds when `eq` holds for any value.
// - `exists` holds when the field is present and not JSON null.
import { limits, type Scalar } from "@/conditions/types";

export type Param = string | number | bigint;
export interface SQLPart<P = never> {
  sql: string;
  args: (Param | P)[];
}

const segment = new RegExp(`^[\\p{L}\\p{N}_-]{1,${limits.segmentLength}}$`, "u");

/** A dotted path of letters, digits, `_` and `-` segments. */
export function validPath(path: string): boolean {
  // At most two UTF-16 units per character; checked before anything is split.
  if (path.length > limits.pathSegments * (2 * limits.segmentLength + 1) - 1) return false;
  const parts = path.split(".");
  return parts.length <= limits.pathSegments && parts.every((part) => segment.test(part));
}

/** The SQLite JSON path of a validated dotted path; each label is quoted. */
export const jsonPath = (path: string) =>
  `$${path
    .split(".")
    .map((part) => `."${part}"`)
    .join("")}`;

export type CompareOp = "eq" | "gt" | "gte" | "lt" | "lte";
const operators: Record<CompareOp, string> = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" };

/** `column` at `path` compared with `value`; always 0 or 1. `column` is trusted SQL. */
export function compareSQL(column: string, path: string, op: CompareOp, value: Scalar): SQLPart {
  const p = jsonPath(path);
  if (typeof value === "boolean")
    return { sql: `coalesce(json_type(${column}, ?) = ?, 0)`, args: [p, value ? "true" : "false"] };
  const types = typeof value === "number" ? "IN ('integer', 'real')" : "= 'text'";
  return {
    sql: `coalesce(json_type(${column}, ?) ${types} AND json_extract(${column}, ?) ${operators[op]} ?, 0)`,
    args: [p, p, value],
  };
}

/** `column` at `path` equals any of `values`; always 0 or 1. */
export function inSQL(column: string, path: string, values: Scalar[]): SQLPart {
  const parts = values.map((value) => compareSQL(column, path, "eq", value));
  return {
    sql: `(${parts.map((part) => part.sql).join(" OR ")})`,
    args: parts.flatMap((part) => part.args),
  };
}

/** `column` has a non-null value at `path`; always 0 or 1. */
export function existsSQL(column: string, path: string): SQLPart {
  return { sql: `coalesce(json_type(${column}, ?) <> 'null', 0)`, args: [jsonPath(path)] };
}
