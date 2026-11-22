// Bounded Liquid filters beside the reviewed set in renderer.ts (D23, D54). Each filter charges the
// message budget it is given before it allocates its output, so a filter that would exceed the
// emission or work budget is refused like the existing ones. Registration and arity live in
// renderer.ts; the functions here hold the value rules.

/** The budget a filter charges: work steps and emitted bytes (renderer.ts Budget). */
export interface FilterBudget {
  step(count?: number): void;
  charge(bytes: number): void;
}

/**
 * A failure that depends on the value a message carries, such as a nil or non-date for `date`, or
 * an object printed as text. The save-time check (D134) does not refuse a template for it, because
 * its sample does not carry the message's values; the send still refuses that message.
 */
export class ValueError extends Error {}

export const byteLength = (value: string) => Buffer.byteLength(value, "utf-8");

/** A value printed as text. Objects and arrays are refused: they have no text form here (D23). */
export function scalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return String(value);
  }
  throw new ValueError("Invalid value");
}

/**
 * `size`: the length of a string in characters (JavaScript's `length`, so a character outside the
 * Basic Multilingual Plane counts as two), the items of an array, or the own keys of a plain
 * object. Anything else, nil included, is 0. A plain object walks its keys, charged a step each;
 * the keys of a message's data are at most 1,024 (D54).
 */
export function sizeOf(value: unknown, b: FilterBudget): number {
  b.step();
  if (typeof value === "string") {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  if (value !== null && typeof value === "object") {
    // A loop record or another class instance is not message data; it has no size here.
    if (Object.getPrototypeOf(value) !== null) {
      throw new Error("Invalid value");
    }
    const keys = Object.keys(value).length;
    b.step(keys);
    return keys;
  }
  return 0;
}
