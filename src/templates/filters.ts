// Bounded Liquid filters beside the reviewed set in renderer.ts (D23, D54). Each filter charges the
// message budget it is given before it allocates its output, so a filter that would exceed the
// emission or work budget is refused like the existing ones. Registration and arity live in
// renderer.ts; the functions here hold the value rules.

import { decodeReferences } from "@/messaging/plain";

/** The budget a filter charges: work steps and emitted bytes (renderer.ts Budget). */
export interface FilterBudget {
  step(count?: number): void;
  charge(bytes: number): void;
}

/**
 * A failure that depends on the value a message carries, such as a non-integer filter argument or a
 * list over its item limit. The save-time check (D134) does not refuse a template for it, unless the
 * failing expression reads no data at all, because its sample does not carry the message's values;
 * the send still refuses that message, and names the expression and the kind of value.
 */
export class ValueError extends Error {}

/**
 * Printing a loop object (`forloop`, `tablerowloop`) is the template's own text, so a save refuses it with
 * this message (B135 review B1). Data never carries a loop object, so the send would fail the same way.
 */
export const LOOP_PRINT =
  "a loop object (forloop or tablerowloop) cannot be printed; print one of its properties, such as forloop.index";

export const byteLength = (value: string) => Buffer.byteLength(value, "utf-8");

/** The kind of a value, as an error names it (D134): never the value itself. */
export function kindOf(value: unknown): string {
  if (value === null || value === undefined) {
    return "nil";
  }
  if (typeof value === "string") {
    return "text";
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  return Array.isArray(value) ? "list" : "object";
}

/** A list holds at most this many items (D54), so printing or walking one is bounded. */
const LIST_LIMIT = 1024;
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
      throw new ValueError("a number is not finite, so it has no JSON form");
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
        throw new ValueError("a list has a hole, so it has no JSON form");
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
  throw new ValueError("an object of this kind has no JSON form");
}

/**
 * The UTF-8 bytes of the text a list or object prints as (see `scalar`), counted before the text
 * exists: a list's items joined with nothing, an object's JSON. Nesting is bounded by JSON_DEPTH.
 */
function printBytes(value: unknown, depth: number, walk: { nodes: number }): number {
  if (depth > JSON_DEPTH) {
    throw new Error("Nesting limit");
  }
  walk.nodes++;
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "string") {
    return byteLength(value);
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return jsonBytes(value, depth, walk);
  }
  if (Array.isArray(value)) {
    if (value.length > LIST_LIMIT) {
      throw new ValueError(`a list has ${value.length} items, over the limit of 1,024`);
    }
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
      bytes += printBytes(value[i], depth + 1, walk);
    }
    return bytes;
  }
  return jsonBytes(value, 0, walk);
}

/** The text a value prints as, after `printBytes` has counted it. */
function printText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    let out = "";
    for (const item of value) {
      out += printText(item);
    }
    return out;
  }
  return JSON.stringify(value);
}

/**
 * A value printed as text. A text, a number and a boolean print as themselves, and nil is empty.
 * A list prints as LiquidJS prints it, its items' text joined with nothing (so `[1, "two", null]`
 * is `1two`), and an object prints as its `json` text. A list or object is counted and charged to
 * the budget before its text is built, so its output cannot exceed the limit by being built first
 * (D54). A number that is not finite has no text here and is a value failure.
 */
export function scalar(value: unknown, b: FilterBudget): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return String(value);
  }
  const walk = { nodes: 0 };
  const bytes = printBytes(value, 0, walk);
  b.step(walk.nodes);
  b.charge(bytes);
  return printText(value);
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
  const input = scalar(value, b);
  b.charge(mappedBytes(input, (c) => c.toLowerCase()));
  return input.toLowerCase();
}

/** `capitalize`: the first character in upper case and the rest in lower case, as LiquidJS does. */
export function capitalize(value: unknown, b: FilterBudget): string {
  b.step();
  const input = scalar(value, b);
  const head = input.charAt(0).toUpperCase();
  const tail = input.slice(1);
  b.charge(byteLength(head) + mappedBytes(tail, (c) => c.toLowerCase()));
  return head + tail.toLowerCase();
}

/** `prepend` and `append` join a literal string to the text; both are charged before the join. */
export function prepend(value: unknown, argument: unknown, b: FilterBudget): string {
  b.step();
  const input = scalar(value, b);
  const added = scalar(argument, b);
  b.charge(byteLength(input) + byteLength(added));
  return added + input;
}

export function append(value: unknown, argument: unknown, b: FilterBudget): string {
  b.step();
  const input = scalar(value, b);
  const added = scalar(argument, b);
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
  const input = scalar(value, b);
  const find = scalar(pattern, b);
  const withText = scalar(replacement, b);
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
  const input = scalar(value, b);
  const find = scalar(pattern, b);
  const withText = scalar(replacement, b);
  const at = input.indexOf(find);
  if (at === -1) {
    b.charge(byteLength(input));
    return input;
  }
  b.charge(byteLength(input) - byteLength(find) + byteLength(withText));
  return input.slice(0, at) + withText + input.slice(at + find.length);
}

/**
 * A whole number a filter reads: a safe integer, or a text of up to 15 digits that holds one (data often
 * carries numbers as text). Undefined for anything else. The save check (D134) reads literals with it too.
 */
export function wholeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d{1,15}$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** An integer argument. A nil or non-integer argument often comes from data, so it is a value failure. */
function integer(value: unknown): number {
  const whole = wholeNumber(value);
  if (whole === undefined) {
    throw new ValueError(`needs a whole-number argument, got ${kindOf(value)}`);
  }
  return whole;
}

/**
 * `split`: the parts of a text around a literal separator, with trailing empty parts dropped (the
 * rule of LiquidJS, which follows Ruby). Its parts are counted before the array is built, and an
 * array holds at most 1,024 items (D54).
 */
export function split(value: unknown, separator: unknown, b: FilterBudget): Array<string> {
  b.step();
  const input = scalar(value, b);
  const find = scalar(separator, b);
  const count = separators(input, find) + 1;
  if (count > 1024) {
    throw new ValueError(`split would make ${count} parts, over the limit of 1,024`);
  }
  b.step(count);
  b.charge(byteLength(input));
  const parts = input.split(find);
  while (parts.length > 0 && parts.at(-1) === "") {
    parts.pop();
  }
  return parts;
}

/**
 * `join`: an array's items, each printed as text, with a literal separator (a single space when
 * none is given). Any other value is printed as its text, so nil is empty. The bytes of the result
 * are counted before it is joined.
 */
export function join(value: unknown, separator: unknown, b: FilterBudget): string {
  b.step();
  const find = separator === undefined ? " " : scalar(separator, b);
  if (!Array.isArray(value)) {
    return scalar(value, b);
  }
  if (value.length > 1024) {
    throw new ValueError(`join needs at most 1,024 items, got ${value.length}`);
  }
  const items = value.map((item: unknown) => scalar(item, b));
  let bytes = Math.max(0, items.length - 1) * byteLength(find);
  for (const item of items) {
    bytes += byteLength(item);
  }
  b.step(items.length);
  b.charge(bytes);
  return items.join(find);
}

/**
 * The code points of a text, counted without building them (D54: the scan is charged per KiB). A low
 * surrogate that follows a high one is the second half of a character outside the Basic Multilingual
 * Plane, so it is not counted again: the count is the one `for...of` walks.
 */
function codePointCount(text: string, b: FilterBudget): number {
  b.step(Math.ceil(byteLength(text) / 1024));
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const pairs =
      c >= 0xdc_00 &&
      c <= 0xdf_ff &&
      i > 0 &&
      text.charCodeAt(i - 1) >= 0xd8_00 &&
      text.charCodeAt(i - 1) <= 0xdb_ff;
    if (!pairs) {
      count++;
    }
  }
  return count;
}

/** `count` code points of a text from `start`, which is at least zero. A surrogate pair is never split. */
function sliceCodePoints(text: string, start: number, count: number): string {
  let out = "";
  let index = 0;
  for (const character of text) {
    if (index >= start + count) {
      break;
    }
    if (index >= start) {
      out += character;
    }
    index++;
  }
  return out;
}

/**
 * `slice`: `count` characters of a text from `begin` (a negative `begin` counts from the end; the
 * count defaults to one), or `count` items of an array. A character is a code point, so a character
 * outside the Basic Multilingual Plane is one character and is never split. A nil text is empty.
 */
export function slice(
  value: unknown,
  begin: unknown,
  count: unknown,
  b: FilterBudget,
): string | Array<unknown> {
  b.step();
  const from = integer(begin);
  const take = count === undefined ? 1 : integer(count);
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    const start = from < 0 ? value.length + from : from;
    if (start < 0 || take < 0) {
      return [];
    }
    const items: Array<unknown> = value.slice(start, start + take);
    b.step(items.length);
    return items;
  }
  const text = scalar(value, b);
  const start = from < 0 ? codePointCount(text, b) + from : from;
  if (start < 0 || take < 0) {
    return "";
  }
  const out = sliceCodePoints(text, start, take);
  b.charge(byteLength(out));
  return out;
}

/**
 * `truncate`: a text no longer than `limit` characters (50 when none is given) is unchanged; a longer
 * one is cut to `limit` characters including the ellipsis (`...` when none is given). Characters are
 * code points, so a cut never splits a surrogate pair.
 */
export function truncate(
  value: unknown,
  limit: unknown,
  ellipsis: unknown,
  b: FilterBudget,
): string {
  b.step();
  const input = scalar(value, b);
  const max = limit === undefined ? 50 : integer(limit);
  const dots = ellipsis === undefined ? "..." : scalar(ellipsis, b);
  b.charge(byteLength(input) + byteLength(dots));
  const length = codePointCount(input, b);
  if (length <= max) {
    return input;
  }
  return sliceCodePoints(input, 0, Math.max(0, max - codePointCount(dots, b))) + dots;
}

/**
 * `truncatewords`: the first `count` words (15 when none is given, at least one), joined by single
 * spaces. The ellipsis is added only when words were left out, which is Shopify's rule; LiquidJS
 * also adds it when the count matches exactly. A word is a run of non-space characters.
 */
export function truncatewords(
  value: unknown,
  count: unknown,
  ellipsis: unknown,
  b: FilterBudget,
): string {
  b.step();
  const input = scalar(value, b);
  const keep = Math.max(1, count === undefined ? 15 : integer(count));
  const dots = ellipsis === undefined ? "..." : scalar(ellipsis, b);
  b.charge(byteLength(input) + byteLength(dots));
  const words: Array<string> = [];
  let more = false;
  for (const match of input.matchAll(/\S+/g)) {
    b.step();
    if (words.length === keep) {
      more = true;
      break;
    }
    words.push(match[0]);
  }
  return words.join(" ") + (more ? dots : "");
}

const TAG_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  ["<script", "</script>"],
  ["<style", "</style>"],
  ["<!--", "-->"],
  ["<", ">"],
];

/**
 * `strip_html`: the text without comments, `script` and `style` elements and tags, as LiquidJS
 * removes them, and then with its character references decoded (D134), so `&lt;b&gt;` is the text
 * `<b>` and an HTML output escapes it once. A block opener whose closer never comes is dropped from the
 * search, so the scan is linear in the text. The output is no longer than the input, which is charged
 * first (a reference decodes to no more bytes than it is written in).
 */
export function stripHtml(value: unknown, b: FilterBudget): string {
  b.step();
  const input = scalar(value, b);
  b.step(Math.ceil(byteLength(input) / 1024));
  b.charge(byteLength(input));
  return decodeReferences(stripTags(input));
}

/** The text of `input` without its comments, script and style elements and tags (see `stripHtml`). */
function stripTags(input: string): string {
  const blocks = new Map(TAG_BLOCKS);
  let out = "";
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt < 0) {
      return out + input.slice(i);
    }
    out += input.slice(i, lt);
    for (const [opener, closer] of blocks) {
      if (!input.startsWith(opener, lt)) {
        continue;
      }
      const end = input.indexOf(closer, lt + opener.length);
      if (end >= 0) {
        i = end + closer.length;
        break;
      }
      blocks.delete(opener);
    }
    if (i <= lt) {
      return out + input.slice(lt);
    }
  }
  return out;
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
      throw new ValueError("an object of this kind has no size");
    }
    const keys = Object.keys(value).length;
    b.step(keys);
    return keys;
  }
  return 0;
}

/**
 * A number a filter reads: a finite number, or a text that holds one (data often carries numbers as text).
 * The save check (D134) reads literals with it too.
 */
export function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.length <= 64 && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** A result is a number when it is finite; otherwise it is empty. */
const finite = (result: number): number | "" => (Number.isFinite(result) ? result : "");

/**
 * `plus`, `minus`, `times` and `divided_by` (D134): the input and the argument, read as numbers. A nil or empty
 * input is empty (B135 review N6: an optional number that arrives as `""` must not fail the message). An input
 * that is not a number is a value failure, and so is an argument that is not one, or a division by zero: a
 * literal one of these is refused at save. An integer divided by an integer rounds down, as LiquidJS does, unless
 * the divisor is a literal written with a decimal point (`floatDivisor`), which divides as a float (B135 review).
 * A result that is not finite is empty.
 */
export function arithmetic(
  operator: "plus" | "minus" | "times" | "divided_by",
  value: unknown,
  argument: unknown,
  b: FilterBudget,
  floatDivisor = false,
): number | "" {
  b.step();
  const right = numberOf(argument);
  if (right === undefined) {
    throw new ValueError(`${operator} needs a number argument, got ${kindOf(argument)}`);
  }
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const left = numberOf(value);
  if (left === undefined) {
    throw new ValueError(`${operator} needs a number, got ${kindOf(value)}`);
  }
  if (operator === "plus") {
    return finite(left + right);
  }
  if (operator === "minus") {
    return finite(left - right);
  }
  if (operator === "times") {
    return finite(left * right);
  }
  if (right === 0) {
    throw new ValueError("divided_by cannot divide by zero");
  }
  const whole = Number.isInteger(left) && Number.isInteger(right) && !floatDivisor;
  return finite(whole ? Math.floor(left / right) : left / right);
}

/**
 * `round`: a number to `digits` places (none when not given, and at most 15), with halves rounded away
 * from zero. A nil or empty input is empty (B135 review N6); any other value that is not a number is a value failure.
 */
export function round(value: unknown, digits: unknown, b: FilterBudget): number | "" {
  b.step();
  const places = digits === undefined ? 0 : integer(digits);
  if (places < 0 || places > 15) {
    throw new ValueError("round needs whole digits from 0 to 15");
  }
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const n = numberOf(value);
  if (n === undefined) {
    throw new ValueError(`round needs a number, got ${kindOf(value)}`);
  }
  const scale = 10 ** places;
  return finite(Math.sign(n) * (Math.round(Math.abs(n) * scale) / scale));
}

/**
 * `first` and `last`: the first or last item of a list, as it is, or the first or last character of a text.
 * Any other value, and an empty list or text, is empty.
 */
export function first(value: unknown, b: FilterBudget) {
  b.step();
  if (Array.isArray(value)) {
    const items: Array<unknown> = value;
    return items.length > 0 ? items[0] : "";
  }
  if (typeof value === "string") {
    const [head] = value;
    return head ?? "";
  }
  return "";
}

export function last(value: unknown, b: FilterBudget) {
  b.step();
  if (Array.isArray(value)) {
    const items: Array<unknown> = value;
    return items.length > 0 ? items.at(-1) : "";
  }
  if (typeof value === "string") {
    // The characters are walked once, a step per KiB of the text, so the walk is charged.
    b.step(Math.ceil(byteLength(value) / 1024));
    let tail = "";
    for (const character of value) {
      tail = character;
    }
    return tail;
  }
  return "";
}

/**
 * `url_encode`: the text percent-encoded as `encodeURIComponent` writes it, with a space written as `+`, as
 * LiquidJS does. A lone surrogate is written as U+FFFD first, so the encoding never throws. The bytes are
 * counted before the text is built: a character outside the unreserved set takes three bytes per byte.
 */
export function urlEncode(value: unknown, b: FilterBudget): string {
  b.step();
  const text = scalar(value, b).toWellFormed();
  let bytes = 0;
  for (const character of text) {
    bytes += /[A-Za-z0-9\-_.!~*'() ]/.test(character) ? 1 : 3 * byteLength(character);
  }
  b.charge(bytes);
  return encodeURIComponent(text).replaceAll("%20", "+");
}
