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

const JSON_DEPTH = 32;

/** The UTF-8 bytes of a string as JSON.stringify writes it, counted without building the text. */
function quotedBytes(text: string): number {
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) {
      bytes += 2;
    } else if (c < 0x20) {
      // \b, \t, \n, \f and \r are two characters; every other control character is \u00XX.
      bytes += c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d ? 2 : 6;
    } else if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x08_00) {
      bytes += 2;
    } else if (c >= 0xd8_00 && c <= 0xdb_ff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc_00 && next <= 0xdf_ff) {
        bytes += 4;
        i++;
      } else {
        bytes += 6;
      }
    } else if (c >= 0xd8_00 && c <= 0xdf_ff) {
      // A lone surrogate is written as \uXXXX (well-formed JSON.stringify).
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * The UTF-8 bytes of `JSON.stringify(value)`, computed before the text exists. Only plain message
 * data is admitted: null-prototype records, dense arrays, strings, finite numbers and booleans. A
 * loop record or another class instance has no JSON form here (D23), so it is refused.
 */
function jsonBytes(value: unknown, depth: number, walk: { nodes: number }): number {
  if (depth > JSON_DEPTH) {
    throw new Error("Nesting limit");
  }
  walk.nodes++;
  if (value === null) {
    return 4;
  }
  if (typeof value === "boolean") {
    return value ? 4 : 5;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Invalid value");
    }
    // The text of a finite number is ASCII, so its length is its byte count.
    return String(value).length;
  }
  if (typeof value === "string") {
    return quotedBytes(value);
  }
  if (Array.isArray(value)) {
    let bytes = 2 + Math.max(0, value.length - 1);
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new Error("Invalid value");
      }
      bytes += jsonBytes(value[i], depth + 1, walk);
    }
    return bytes;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === null) {
    const entries = Object.entries(value);
    // Braces, a colon per member and a comma between members.
    let bytes = 2 + Math.max(0, entries.length - 1) + entries.length;
    for (const [key, item] of entries) {
      bytes += quotedBytes(key) + jsonBytes(item, depth + 1, walk);
    }
    return bytes;
  }
  throw new Error("Invalid value");
}

/**
 * `json`: the JSON text of a value, for a template that prints data as JSON. Its bytes are charged
 * to the message budget before the text is built, and the walk that counts them is bounded by the
 * data limits (D54). Nil is `null`. The text escapes like any other value in its output context
 * (HTML escapes its quotes unless it is piped through `raw`).
 */
export function json(value: unknown, b: FilterBudget): string {
  b.step();
  if (value === undefined) {
    return "null";
  }
  const walk = { nodes: 0 };
  const bytes = jsonBytes(value, 0, walk);
  b.step(walk.nodes);
  b.charge(bytes);
  return JSON.stringify(value);
}

/** The UTF-8 bytes of `text` after `map` has run on each of its characters, counted first. */
function mappedBytes(text: string, map: (character: string) => string): number {
  let bytes = 0;
  for (const character of text) {
    bytes += byteLength(map(character));
  }
  return bytes;
}

/** The occurrences `replace` substitutes: a split on the pattern, so an empty pattern splits between characters. */
function separators(text: string, pattern: string): number {
  if (pattern === "") {
    return Math.max(0, text.length - 1);
  }
  let count = 0;
  for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + pattern.length)) {
    count++;
  }
  return count;
}

/** `downcase`: the text in lower case. Its bytes are counted per character before it is built. */
export function downcase(value: unknown, b: FilterBudget): string {
  b.step();
  const input = scalar(value);
  b.charge(mappedBytes(input, (c) => c.toLowerCase()));
  return input.toLowerCase();
}

/** `capitalize`: the first character in upper case and the rest in lower case, as LiquidJS does. */
export function capitalize(value: unknown, b: FilterBudget): string {
  b.step();
  const input = scalar(value);
  const head = input.charAt(0).toUpperCase();
  const tail = input.slice(1);
  b.charge(byteLength(head) + mappedBytes(tail, (c) => c.toLowerCase()));
  return head + tail.toLowerCase();
}

/** `prepend` and `append` join a literal string to the text; both are charged before the join. */
export function prepend(value: unknown, argument: unknown, b: FilterBudget): string {
  b.step();
  const input = scalar(value);
  const added = scalar(argument);
  b.charge(byteLength(input) + byteLength(added));
  return added + input;
}

export function append(value: unknown, argument: unknown, b: FilterBudget): string {
  b.step();
  const input = scalar(value);
  const added = scalar(argument);
  b.charge(byteLength(input) + byteLength(added));
  return input + added;
}

/**
 * `replace`: every occurrence of a literal pattern replaced by a literal string (no regular
 * expression, and no `$` patterns in the replacement). The occurrences are counted first, so an
 * empty pattern or a long text is refused by the work or emission budget before the split.
 */
export function replace(
  value: unknown,
  pattern: unknown,
  replacement: unknown,
  b: FilterBudget,
): string {
  b.step();
  const input = scalar(value);
  const find = scalar(pattern);
  const withText = scalar(replacement);
  const count = separators(input, find);
  b.step(count);
  b.charge(byteLength(input) - count * byteLength(find) + count * byteLength(withText));
  return input.split(find).join(withText);
}

/** `replace_first`: the first occurrence of a literal pattern replaced by a literal string. */
export function replaceFirst(
  value: unknown,
  pattern: unknown,
  replacement: unknown,
  b: FilterBudget,
): string {
  b.step();
  const input = scalar(value);
  const find = scalar(pattern);
  const withText = scalar(replacement);
  const at = input.indexOf(find);
  if (at === -1) {
    b.charge(byteLength(input));
    return input;
  }
  b.charge(byteLength(input) - byteLength(find) + byteLength(withText));
  return input.slice(0, at) + withText + input.slice(at + find.length);
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
