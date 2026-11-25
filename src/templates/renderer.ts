// Liquid rendering context and composition adapted from listmonk models/campaigns.go,
// models/messages.go and internal/manager/message.go at 6fcd95f.
import {
  Context,
  Drop,
  Expression,
  Liquid,
  Output,
  TypeGuards,
  Value,
  defaultOperators,
  toValueSync,
} from "liquidjs";
import type {
  Emitter,
  Filter,
  FilterImplOptions,
  LiquidOptions,
  PropertyAccessToken,
  Template,
} from "liquidjs";
import { must } from "@/invariant";
import type { Clock } from "@/clock";
import type { Translation } from "@/i18n/i18n";
import { parseTemplateData } from "@/templates/data";
import type { TemplateData } from "@/templates/data";
import { createMarkdownBudget, renderMarkdown } from "@/templates/markdown";
import {
  LineBreaks,
  LOOP_PRINT,
  append,
  arithmetic,
  byteLength,
  capitalize,
  downcase,
  escapedBytes,
  escapeHtml,
  first,
  firstName,
  join,
  json,
  kindOf,
  last,
  newlineToBr,
  numberOf,
  prepend,
  replace,
  replaceFirst,
  round,
  scalar,
  sizeOf,
  slice,
  split,
  stripHtml,
  truncate,
  truncatewords,
  urlEncode,
  ValueError,
  wholeNumber,
} from "@/templates/filters";
import type { FilterBudget } from "@/templates/filters";

const SOURCE_LIMIT = 64 * 1024;
const OUTPUT_LIMIT = 1024 * 1024;
const SUBJECT_LIMIT = 2048;
const TOTAL_LIMIT = 4 * 1024 * 1024;
const MAX_WORK = 10_000;
const MAX_DEPTH = 32;
const dangerous = new Set(["__proto__", "prototype", "constructor"]);
const loopProperties = new Set(["index", "index0", "rindex", "rindex0", "first", "last", "length"]);
/** The name of the loop object a `for` tag binds, and of the only one a template may read (D134, B117e). */
const LOOP_OBJECT = "forloop";
const filterArguments = new Map([
  ["raw", 0],
  ["default", 1],
  ["upcase", 0],
  ["strip", 0],
  ["t", 8],
  ["date", 1],
  ["track_link", 0],
  ["number", 0],
  ["size", 0],
  ["json", 0],
  ["downcase", 0],
  ["capitalize", 0],
  ["prepend", 1],
  ["append", 1],
  ["replace", 2],
  ["replace_first", 2],
  ["split", 1],
  ["join", 1],
  ["slice", 2],
  ["truncate", 2],
  ["truncatewords", 2],
  ["strip_html", 0],
  ["plus", 1],
  ["minus", 1],
  ["times", 1],
  ["divided_by", 2],
  ["round", 1],
  ["first", 0],
  ["last", 0],
  ["newline_to_br", 0],
  ["url_encode", 0],
  ["first_name", 0],
]);
/** The filters the renderer registers, in the order of its arity table (the documented allow-list). */
export const registeredFilters: ReadonlyArray<string> = [...filterArguments.keys()];

export class TemplateSourceError extends Error {
  /**
   * `detail` names the unknown filter of a body or subject (D134), or is empty. A `loop` is a `for`
   * tag whose collection has a filter, which LiquidJS would silently drop.
   */
  constructor(
    readonly field: "body" | "subject" | "slot" | "loop",
    readonly detail = "",
  ) {
    super(field);
  }
}
/**
 * A `for` tag whose collection has a filter: LiquidJS reads only the value and ignores the filter. A `|`
 * inside a quoted string is not a filter, and the tag ends at its `%}`, so the pattern steps over quotes.
 */
const forWithFilter = /\{%-?\s*for\s(?:"[^"]*"|'[^']*'|[^%"'])*?\|/;
/** The contents of `raw` and `comment` blocks: their text is never parsed as a tag (D134). */
const literalBlocks = /\{%-?\s*(raw|comment)\s*-?%\}[\s\S]*?\{%-?\s*end\1\s*-?%\}/g;
/** Whether a template has a `for` tag with a filter outside its literal blocks. */
function hasForWithFilter(source: string): boolean {
  return forWithFilter.test(source.replaceAll(literalBlocks, ""));
}
/** The name of an unknown filter in a parse error, or "" (the library's text is not shown). */
function unknownFilter(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^undefined filter: ([^\s,]+)/.exec(message)?.[1] ?? "";
}
export class RenderCapacityError extends Error {
  constructor() {
    super("Render capacity");
  }
}
/**
 * A failure of a message's render, with the expression that failed and what was wrong (D134). `detail`
 * names the expression and the kind of value, with no value itself, and is what a send or a preview
 * shows. `refused` is set when the template's own text causes the failure: a save refuses it with that
 * reason, and it is undefined for a failure that depends on a value.
 */
export class RenderFaultError extends Error {
  constructor(
    readonly detail: string,
    readonly refused?: string,
  ) {
    super(detail);
  }
}
/**
 * A failure the template's own text causes, whatever data a message carries, such as a date format with
 * an unsupported directive. Its message is the reason a save gives.
 */
export class TextError extends Error {}
/**
 * The outcome of a save-time render (D134). `refused` names the cause of a template's own text in
 * words, with the expression that causes it; `busy` is the render capacity, not a template fault.
 */
export type SaveCheck =
  | { readonly outcome: "ok" }
  | { readonly outcome: "refused"; readonly reason: string }
  | { readonly outcome: "busy" };
/**
 * The renderer's messages for the template text that causes them, and the reason a save names. Only
 * these and TextError and literal faults refuse a save: any other failure depends on a value.
 */
const refusalReasons = new Map<string, string>([
  [LOOP_PRINT, LOOP_PRINT],
  ["Invalid filter arguments", "a filter has the wrong number of arguments"],
  ["Invalid for arguments", "a for tag has an unsupported argument"],
  ["Invalid lookup", "a property name is not allowed"],
  ["Invalid loop property", "a loop property is not available"],
  ["Invalid collection", "a loop collection is not supported"],
  ["Invalid translation", "a translation call is invalid"],
  ["Nesting limit", "the template nests too deeply"],
  ["Render limit", "the template exceeds a render limit"],
  ["Output limit", "the template exceeds a render limit"],
  ["Work limit", "the template exceeds a render limit"],
]);
/**
 * The reason a save refuses a render fault, or undefined when the failure depends on the values a
 * message carries: those are refused, if at all, at send (D134).
 */
function refusal(error: unknown): string | undefined {
  if (error instanceof RenderFaultError) {
    return error.refused;
  }
  if (error instanceof TextError) {
    return error.message;
  }
  const message = error instanceof Error ? error.message : "";
  return refusalReasons.get(message);
}
/** The expression a template holds, without its delimiters, shortened: the author's own text, no data. */
function expressionOf(template: Template): string {
  const text = template.token
    .getText()
    .replace(/^\{[{%]-?\s*/, "")
    .replace(/\s*-?[}%]\}$/, "")
    .trim();
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}
/**
 * The error under LiquidJS's wrappers, which keep the thrown one as `originalError`. A wrapper adds the
 * position of the template to its message, so the thrown message is the one that names the failure.
 */
function rootError(error: unknown): unknown {
  let current = error;
  for (
    let depth = 0;
    depth < 4 && current instanceof Error && "originalError" in current;
    depth++
  ) {
    current = current.originalError;
  }
  return current;
}
/**
 * LiquidJS's own range guard: a range whose bounds are not whole numbers, or span more than 1,024
 * values. Its bounds come from the template or from data, so it is classified as a value failure.
 */
const RANGE_LIMIT = "range limit exceeded";
/**
 * The fault a template's failure becomes (D134). A value failure of an expression that read no data is a
 * literal failure, which the template's own text causes: its detail is the reason a save refuses it.
 * Any other failure names its expression and what was wrong, and a text cause keeps its refusal.
 */
function faultOf(error: unknown, template: Template, literal: boolean): RenderFaultError {
  if (error instanceof RenderFaultError) {
    return error;
  }
  const root = rootError(error);
  const raw = root instanceof Error ? root.message : "";
  const message = raw === RANGE_LIMIT ? "a range or loop is out of bounds" : raw;
  const at = expressionOf(template);
  const detail = message === "" ? at : `${at}: ${message}`;
  const value = root instanceof ValueError || raw === RANGE_LIMIT;
  if (value && literal) {
    return new RenderFaultError(detail, detail);
  }
  if (root instanceof TextError) {
    return new RenderFaultError(detail, message);
  }
  return new RenderFaultError(detail, value ? undefined : refusalReasons.get(message));
}

class Budget {
  bytes = 0;
  work = 0;
  depth = 0;
  /** Property reads so far, and the count when the template being rendered started (D134). */
  reads = 0;
  start = 0;
  /** True while the template being rendered has read no data: its text alone decides its result. */
  literal(): boolean {
    return this.reads === this.start;
  }
  charge(n: number) {
    if (!Number.isSafeInteger(n) || n < 0 || this.bytes + n > TOTAL_LIMIT) {
      throw new Error("Render limit");
    }
    this.bytes += n;
  }
  step(count = 1) {
    if (!Number.isSafeInteger(count) || count < 0 || this.work + count > MAX_WORK) {
      throw new Error("Work limit");
    }
    this.work += count;
  }
}
/**
 * One message's output and work budget. Pass the same budget to every compiled part of a
 * message (subject, body, from, headers) so the parts share one limit instead of each
 * receiving a fresh one.
 */
export interface MessageBudget {
  readonly bytes: number;
  readonly work: number;
  /** Charges emitted bytes, such as a generated text part (B120); throws when exhausted. */
  charge(bytes: number): void;
}
export function createMessageBudget(): MessageBudget {
  return new Budget();
}
class BoundedEmitter implements Emitter {
  buffer = "";
  bytes = 0;
  constructor(
    private readonly budget: Budget,
    private readonly limit: number,
  ) {}
  write(value: unknown) {
    const string = scalar(plainValue(value), this.budget);
    const n = byteLength(string);
    if (this.bytes + n > this.limit) {
      throw new Error("Output limit");
    }
    this.budget.charge(n);
    this.bytes += n;
    this.buffer += string;
  }
}
function url(value: unknown, b: FilterBudget): string {
  const text = scalar(value, b);
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ValueError("Invalid URL");
    }
    return text;
  } catch {
    throw new ValueError("Invalid URL");
  }
}
function checkSource(value: string, limit: number) {
  if (typeof value !== "string" || byteLength(value) > limit || value.includes("\0")) {
    throw new Error("Invalid source");
  }
}
export interface RenderRequest {
  body: string;
  layout?: string;
  subject?: string;
  mode: "html" | "plain" | "markdown";
  data: string;
  transactional?: boolean;
}
/**
 * Per-message tracking supplied by the send owner (M2.4 src/unsubscribe). Without it
 * `track_link` returns its URL unchanged and `track_view` renders nothing.
 */
export interface RenderTracking {
  /** Absolute view-pixel URL; `track_view` renders listmonk's hidden 1x1 image in HTML. */
  readonly view?: string;
  /** Rewrites an accepted HTTP(S) URL from `track_link` to its tracked redirect. */
  readonly link?: (url: string) => string;
}
const attribute = (value: string) => value.replaceAll(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** The single-character directives of a date format (`-d` is the day without padding). */
const DIRECTIVES = "%YymdeHIMSpbBaAj";
const SUPPORTED_DIRECTIVES =
  "%%, %Y, %y, %m, %d, %-d, %e, %H, %I, %M, %S, %p, %b, %B, %a, %A and %j";
/**
 * The first directive of a date format that is not supported, or undefined. A format is read left to
 * right, so `%%` is one literal percent sign and its second `%` is not a directive of its own.
 */
function unsupportedDirective(format: string): string | undefined {
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== "%") {
      continue;
    }
    const next = format[i + 1];
    if (next === "-" && format[i + 2] === "d") {
      i += 2;
    } else if (next !== undefined && DIRECTIVES.includes(next)) {
      i += 1;
    } else {
      return `%${next ?? ""}`;
    }
  }
  return undefined;
}
/** The text one directive writes for a UTC date. Only the directive asked for is computed. */
function directive(key: string, date: Date): string {
  const hour = date.getUTCHours();
  const month = date.getUTCMonth();
  const weekday = date.getUTCDay();
  switch (key) {
    case "%":
      return "%";
    case "Y":
      return String(date.getUTCFullYear());
    case "y":
      return pad(date.getUTCFullYear() % 100);
    case "m":
      return pad(month + 1);
    case "d":
      return pad(date.getUTCDate());
    case "-d":
      return String(date.getUTCDate());
    case "e":
      return String(date.getUTCDate()).padStart(2, " ");
    case "H":
      return pad(hour);
    case "I":
      return pad(hour % 12 === 0 ? 12 : hour % 12);
    case "M":
      return pad(date.getUTCMinutes());
    case "S":
      return pad(date.getUTCSeconds());
    case "p":
      return hour < 12 ? "AM" : "PM";
    case "b":
      return must(MONTHS[month], "month").slice(0, 3);
    case "B":
      return must(MONTHS[month], "month");
    case "a":
      return must(WEEKDAYS[weekday], "weekday").slice(0, 3);
    case "A":
      return must(WEEKDAYS[weekday], "weekday");
    case "j": {
      const year = date.getUTCFullYear();
      const startOfYear = Date.UTC(year, 0, 1);
      const day = Date.UTC(year, month, date.getUTCDate());
      return String(Math.floor((day - startOfYear) / 86_400_000) + 1).padStart(3, "0");
    }
    default:
      // Every directive has been checked by `unsupportedDirective`, so this is not reached.
      return key;
  }
}
/** The UTC date a format writes, one directive at a time. */
function formatDate(format: string, date: Date): string {
  return format.replaceAll(/%(-d|.)/g, (_, key: string) => directive(key, date));
}
/** One positional argument of a filter, and what its literal value must be (D134). */
interface ArgumentRule {
  readonly kind: "whole" | "digits" | "number" | "format" | "flag";
  /** A missing argument is a fault too: the filter reads it before anything else, so it fails every value. */
  readonly required?: boolean;
}
/**
 * The literal rules of the filters' arguments (D134), each the rule its filter applies at send: the
 * same readers (`wholeNumber`, `numberOf`, the date format check) decide a literal here. An argument with
 * no rule is text, which any literal is. An optional argument has a default the filter uses when it is
 * missing. `plus`, `minus`, `times`, `divided_by` and `slice` read a required argument before any value.
 */
const argumentRules = new Map<string, ReadonlyArray<ArgumentRule>>([
  ["truncate", [{ kind: "whole" }]],
  ["truncatewords", [{ kind: "whole" }]],
  ["slice", [{ kind: "whole", required: true }, { kind: "whole" }]],
  ["round", [{ kind: "digits" }]],
  ["plus", [{ kind: "number", required: true }]],
  ["minus", [{ kind: "number", required: true }]],
  ["times", [{ kind: "number", required: true }]],
  ["divided_by", [{ kind: "number", required: true }, { kind: "flag" }]],
  ["date", [{ kind: "format" }]],
]);
const ORDINALS = ["first", "second"];
/** The longest literal shown in a save reason. The author's text is shown; data never is. */
const SHOWN = 40;

function expectedOf(rule: ArgumentRule): string {
  switch (rule.kind) {
    case "whole":
      return "a whole number";
    case "digits":
      return "whole digits from 0 to 15";
    case "number":
      return "a number";
    case "format":
      return "a date format";
    case "flag":
      return "true or false";
  }
}

/**
 * A literal argument's value and text, or undefined when the argument is not written as a literal (a
 * variable, a range, a property, or a keyword argument), which depends on data and is left to the send.
 */
function literalOf(argument: Filter["args"][number]): { value: unknown; text: string } | undefined {
  if (Array.isArray(argument)) {
    return undefined;
  }
  if (
    TypeGuards.isNumberToken(argument) ||
    TypeGuards.isQuotedToken(argument) ||
    TypeGuards.isLiteralToken(argument)
  ) {
    return { value: argument.content, text: argument.getText() };
  }
  return undefined;
}

/** The fault in one argument of a filter, or undefined. A literal is judged by the filter's own reader. */
function argumentFault(
  name: string,
  index: number,
  rule: ArgumentRule,
  argument: Filter["args"][number] | undefined,
): string | undefined {
  const where = ORDINALS[index] ?? "";
  if (argument === undefined) {
    return rule.required
      ? `${name}: missing its ${where} argument, which must be ${expectedOf(rule)}`
      : undefined;
  }
  const literal = literalOf(argument);
  if (literal === undefined) {
    return undefined;
  }
  const { value, text } = literal;
  const shown = text.length > SHOWN ? `${text.slice(0, SHOWN)}...` : text;
  const wrong = `${name}: the ${where} argument must be ${expectedOf(rule)}, got ${shown}`;
  switch (rule.kind) {
    case "whole":
      return wholeNumber(value) === undefined ? wrong : undefined;
    case "digits": {
      const digits = wholeNumber(value);
      return digits === undefined || digits < 0 || digits > 15 ? wrong : undefined;
    }
    case "number": {
      const number = numberOf(value);
      if (number === undefined) {
        return wrong;
      }
      return name === "divided_by" && number === 0
        ? `${name}: the ${where} argument cannot be zero`
        : undefined;
    }
    case "flag":
      // The whole-number flag of `divided_by` is a boolean: the literal `true` or `false`, never a number or text.
      return typeof value === "boolean" ? undefined : wrong;
    case "format": {
      // A date format is text, or the number a literal writes; a nil or true literal is not a format.
      if (typeof value !== "string" && typeof value !== "number") {
        return undefined;
      }
      const format = String(value);
      if (byteLength(format) > 256) {
        return `${name}: the format is longer than 256 bytes`;
      }
      const unsupported = unsupportedDirective(format);
      return unsupported === undefined
        ? undefined
        : `${name}: the format has the unsupported directive ${unsupported}; the supported directives are ${SUPPORTED_DIRECTIVES}`;
    }
  }
}

/** The fault in a filter's arguments (D134), or undefined: too many, an odd number for `t`, or a literal one that cannot be read. */
function filterFault(filter: Filter): string | undefined {
  const { name, args } = filter;
  const maximum = filterArguments.get(name);
  if (maximum === undefined) {
    return undefined;
  }
  if (args.length > maximum) {
    const allowed =
      maximum === 0
        ? "no arguments"
        : `at most ${maximum} ${maximum === 1 ? "argument" : "arguments"}`;
    return `${name}: takes ${allowed}, got ${args.length}`;
  }
  if (name === "t" && args.length % 2 !== 0) {
    return `${name}: takes its arguments in pairs, got ${args.length}`;
  }
  // A named argument (`divided_by: 4, integer: true`) is passed on by LiquidJS but never read by the whole-number
  // flag, so it would be ignored: refused at save instead (lead decision 2, D134).
  const named =
    name === "divided_by" ? args.find((argument) => Array.isArray(argument)) : undefined;
  if (named !== undefined) {
    return `${name}: takes no named arguments, got ${String(named[0])}`;
  }
  for (const [index, rule] of (argumentRules.get(name) ?? []).entries()) {
    const fault = argumentFault(name, index, rule, args[index]);
    if (fault !== undefined) {
      return fault;
    }
  }
  return undefined;
}

/**
 * The first fault in a template's literal filter arguments (D134), or undefined. Every output, assign,
 * echo and tag body is checked, including the branches a sample never reaches, because the text alone
 * decides it. An argument that reads data or a variable is not a literal, and the send judges it. The walk
 * is iterative, so a deeply nested template cannot exhaust the stack, and it visits each template once.
 */
/** An output that prints a loop object on its own (`{{ forloop }}`): a template fault whatever the data is (B135 review B1). */
const bareLoop = /^\{\{-?\s*(?:forloop|tablerowloop)\s*-?\}\}$/;

/**
 * How a token's value is used where it stands (B117e, B117f): printed or read by a filter, a `for` tag's list or a
 * range bound, a `for` tag's limit, offset or reversed argument, stored with `assign`, or neither.
 */
type LoopUse = "print" | "list" | "argument" | "assign" | "none";

/** A bare loop object that a `for` tag loops over, or a range ends at (B117e): the send fails there wherever the loop runs. */
const LOOP_LIST =
  "a loop object (forloop) cannot be a for tag's list or a range bound; loop over a list from data";

/** A bare loop object that a `for` tag reads as its limit, offset or reversed argument (B117f): the send fails there. */
const LOOP_ARGUMENT =
  "a loop object (forloop) cannot be a for tag's limit, offset or reversed argument; use a number from data";

/**
 * A bare loop object stored with `assign` (B117f): the renderer's loop object is read through a property later, and
 * a property it does not expose fails the send. Refusing the store is exact, where tracking each read of the name is not.
 */
const LOOP_ASSIGN =
  "a loop object (forloop) cannot be stored with assign; read its properties inside the loop instead";

/** The fault of a loop property the renderer does not expose (B117e), or undefined for one it does or a computed key. */
function loopPropertyFault(property: unknown): string | undefined {
  const name =
    TypeGuards.isWordToken(property) || TypeGuards.isQuotedToken(property)
      ? property.content
      : undefined;
  if (name === undefined || loopProperties.has(name)) {
    return undefined;
  }
  const shown = name.length > SHOWN ? `${name.slice(0, SHOWN)}...` : name;
  return `${LOOP_OBJECT}.${shown}: a loop property is not available; the loop properties are index, index0, rindex, rindex0, first, last and length`;
}

/** The loop-object fault in a property access (B117e): the root `forloop` by itself, read as `use`, and its parts. */
function propertyLoopFault(token: PropertyAccessToken, use: LoopUse): string | undefined {
  const [root, property] = token.props;
  if (
    token.variable === undefined &&
    TypeGuards.isWordToken(root) &&
    root.content === LOOP_OBJECT
  ) {
    if (property === undefined) {
      if (use === "print") {
        return LOOP_PRINT;
      }
      if (use === "list") {
        return LOOP_LIST;
      }
      if (use === "argument") {
        return LOOP_ARGUMENT;
      }
      if (use === "assign") {
        return LOOP_ASSIGN;
      }
    } else {
      const fault = loopPropertyFault(property);
      if (fault !== undefined) {
        return fault;
      }
    }
  }
  // A bracket key is a value of its own, read by the renderer: `data.m[forloop.parentloop]` fails the same way.
  for (const part of [token.variable, ...token.props]) {
    const fault = loopFaultIn(part, "none");
    if (fault !== undefined) {
      return fault;
    }
  }
  return undefined;
}

/** The loop-object fault in filter arguments (B117e): a filter reads each argument, so a bare loop object is refused. A keyword argument is `[name, value]`. */
function argumentsLoopFault(
  filters: ReadonlyArray<{ readonly args: ReadonlyArray<unknown> }>,
): string | undefined {
  for (const filter of filters) {
    for (const argument of filter.args) {
      const token: unknown = Array.isArray(argument) ? argument[1] : argument;
      const fault = loopFaultIn(token, "print");
      if (fault !== undefined) {
        return fault;
      }
    }
  }
  return undefined;
}

/**
 * The loop-object fault in one expression token, at the position it is used (B117e). The walk covers every
 * position a value can stand in: the output and the filter arguments, a `for` tag's list, a `limit` or `offset`,
 * a bracket key, a range bound and a grouped expression.
 */
function loopFaultIn(token: unknown, use: LoopUse): string | undefined {
  if (TypeGuards.isPropertyAccessToken(token)) {
    return propertyLoopFault(token, use);
  }
  if (TypeGuards.isRangeToken(token)) {
    return loopFaultIn(token.lhs, "list") ?? loopFaultIn(token.rhs, "list");
  }
  if (TypeGuards.isFilteredValueToken(token)) {
    return (
      loopFaultIn(token.initial, token.filters.length > 0 ? "print" : use) ??
      argumentsLoopFault(token.filters)
    );
  }
  if (token instanceof Expression) {
    for (const operand of token.postfix) {
      const fault = loopFaultIn(operand, use);
      if (fault !== undefined) {
        return fault;
      }
    }
  }
  return undefined;
}

/**
 * The loop-object fault in one value (B117e), whatever data a message carries. A bare `forloop` that an output
 * prints, or that a filter reads (`{{ forloop | json }}`, `{{ 'x' | append: forloop }}`), is the template's own
 * text: every filter and output refuses a loop object (`plainValue`), so the send fails wherever the loop runs.
 * A bare `forloop` that a `for` tag loops over fails the same way (`LOOP_LIST`). A property the renderer does not
 * expose (`forloop.parentloop`) fails wherever it stands. The loop properties it does expose are data, and are not
 * judged here. A loop object stored with `assign` is not refused: `{% assign f = forloop %}` then `{{ f.index }}`
 * works, and only printing `f` itself fails, at send.
 */
function loopFaultOf(value: Value, printed: boolean, assigned: boolean): string | undefined {
  const use: LoopUse = printed || value.filters.length > 0 ? "print" : assigned ? "assign" : "none";
  return loopFaultIn(value.initial, use) ?? argumentsLoopFault(value.filters);
}

/**
 * Every template in source order, each before its children: the walk the save check makes. It is iterative, so a
 * deeply nested template cannot exhaust the stack, and it visits each template once.
 */
function* walkTemplates(templates: ReadonlyArray<Template>): Generator<Template> {
  const pending = [...templates].reverse();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    yield next;
    // Children in source order: the first one is popped next. A copy is reversed, since a tag such as `capture`
    // returns its own template list, which the renders that follow still read in order (B117f).
    const children = next.children ? toValueSync(next.children(false, true)) : [];
    pending.push(...[...children].reverse());
  }
}

function literalFault(templates: ReadonlyArray<Template>): string | undefined {
  for (const next of walkTemplates(templates)) {
    const printed = next instanceof Output ? next.token.getText() : "";
    if (bareLoop.test(printed)) {
      return LOOP_PRINT;
    }
    const isFor = "name" in next && next.name === "for";
    const isAssign = "name" in next && next.name === "assign";
    // A `for` tag's first argument is its list, which the renderer loops over; its other arguments are its limit,
    // offset and reversed, which it reads too (B117f).
    let index = 0;
    for (const argument of next.arguments?.() ?? []) {
      const position = index;
      index += 1;
      if (argument instanceof Value) {
        const loopFault = loopFaultOf(argument, next instanceof Output, isAssign);
        if (loopFault !== undefined) {
          return loopFault;
        }
        for (const filter of argument.filters) {
          const fault = filterFault(filter);
          if (fault !== undefined) {
            return fault;
          }
        }
      } else {
        const use: LoopUse = !isFor ? "none" : position === 0 ? "list" : "argument";
        const fault = loopFaultIn(argument, use);
        if (fault !== undefined) {
          return fault;
        }
      }
    }
  }
  return undefined;
}

function hasContent(templates: Array<Template>): boolean {
  for (const tpl of templates) {
    if (tpl instanceof Output && /^{{-?\s*content\s*\|\s*raw\s*-?}}$/.test(tpl.token.getText())) {
      return true;
    }
    // A content reference captured into a variable is not itself a layout output.
    if ("name" in tpl && tpl.name === "capture") {
      continue;
    }
    if (
      "children" in tpl &&
      tpl.children &&
      hasContent(toValueSync<Array<Template>>(tpl.children(false, true)))
    ) {
      return true;
    }
  }
  return false;
}
/** A filter's handler as LiquidJS registers it: `this` carries the render context and the filter's token. */
type FilterHandler = Extract<FilterImplOptions, (...args: Array<never>) => unknown>;
/**
 * The value a message prints, or a filter reads (B135 review B1). A literal `nil`, `empty` or `blank` is a LiquidJS
 * Drop whose value is nil or empty, and it is nil. Any other Drop is a loop object (`forloop`): the template's own
 * text, refused when it is printed or read by a filter.
 */
function plainValue(value: unknown) {
  if (value instanceof LineBreaks) {
    return value.text;
  }
  if (value instanceof Drop) {
    const text: unknown = value.valueOf();
    if (text === null || text === "") {
      return null;
    }
    throw new Error(LOOP_PRINT);
  }
  return value;
}
/** A handler that reads its input and arguments with `plainValue`. The `raw` filter reads its own input. */
function readsText(handler: FilterHandler): FilterHandler {
  return function (
    this: ThisParameterType<FilterHandler>,
    value: unknown,
    ...args: Array<unknown>
  ) {
    const result: unknown = handler.apply(this, [plainValue(value), ...args.map(plainValue)]);
    return result;
  };
}
/** Instance-owned renderer. Includes, render and layout tags are deliberately unavailable. */
export function createRenderer(clock: Clock, translation: Translation) {
  // en-US only (D102). Negative zero and values that round to zero render as 0, not -0.
  const numberFormat = new Intl.NumberFormat("en-US", { signDisplay: "negative" });
  const budgets = new WeakMap<Context, Budget>();
  const trackers = new WeakMap<Context, RenderTracking>();
  const budget = (ctx: Context) => {
    const result = budgets.get(ctx);
    if (!result) {
      throw new Error("Missing budget");
    }
    return result;
  };
  /**
   * The UTC date a `date` filter reads (D134): `now` and `today` are the clock's, and anything else must be
   * a calendar date or UTC timestamp that exists. JavaScript rolls 2026-02-30 over to 2026-03-02, so a date
   * is kept only when its canonical form keeps the date (and the time, for a timestamp).
   */
  function parseDate(text: string): Date | undefined {
    if (text === "now" || text === "today") {
      return clock.now();
    }
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(text)) {
      return undefined;
    }
    const date = new Date(text);
    if (!Number.isFinite(date.getTime())) {
      return undefined;
    }
    const digits = text.length === 10 ? 10 : 19;
    return date.toISOString().slice(0, digits) === text.slice(0, digits) ? date : undefined;
  }
  function engine(html: boolean) {
    const operators = { ...defaultOperators };
    const chargeComparison = (value: unknown, b: Budget): number => {
      let cost = 1;
      b.step();
      if (typeof value === "string") {
        const textCost = Math.ceil(byteLength(value) / 1024);
        b.step(textCost);
        cost += textCost;
      } else if (Array.isArray(value)) {
        if (value.length > 1024) {
          throw new ValueError("Array limit");
        }
        for (let i = 0; i < value.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (descriptor && !("value" in descriptor)) {
            throw new ValueError("Invalid value");
          }
          cost += chargeComparison(descriptor?.value, b);
        }
      }
      return cost;
    };
    // JavaScript's relational operators join arrays into one string before
    // comparing. Reserve a conservative size for that string first.
    const joinedBytes = (value: unknown): number => {
      if (typeof value === "string") {
        return byteLength(value);
      }
      if (Array.isArray(value)) {
        let bytes = Math.max(0, value.length - 1);
        for (const item of value) {
          bytes += joinedBytes(item);
        }
        return bytes;
      }
      return value === null || value === undefined ? 0 : 32;
    };
    for (const name of ["==", "!=", ">", "<", ">=", "<=", "contains"] as const) {
      const original = operators[name] as (left: unknown, right: unknown, ctx: Context) => unknown;
      // The driver resolves each yielded operator result to a boolean, so the yield expression is one.
      operators[name] = function* (
        left: unknown,
        right: unknown,
        ctx: Context,
      ): Generator<unknown, boolean, boolean> {
        const b = budget(ctx);
        chargeComparison(left, b);
        const rightCost = chargeComparison(right, b);
        if (name !== "==" && name !== "!=" && name !== "contains") {
          for (const operand of [left, right]) {
            if (Array.isArray(operand)) {
              b.charge(joinedBytes(operand));
            }
          }
        }
        if (name === "contains" && Array.isArray(left) && left.length > 1) {
          b.step((left.length - 1) * rightCost);
        }
        return yield original(left, right, ctx);
      };
    }
    const options: LiquidOptions = {
      operators,
      templates: Object.create(null),
      strictFilters: true,
      ownPropertyOnly: true,
      parseLimit: SOURCE_LIMIT,
      memoryLimit: TOTAL_LIMIT,
      globals: Object.create(null),
      locale: "en-US",
    };
    // The HTML engine escapes output; the plain-text engine has no escape option at all.
    if (html) {
      options.outputEscape = function outputEscape(this: { context: Context }, value: unknown) {
        // A line break output is marked up already, escaped and charged when it was built (B135 review N5).
        if (value instanceof LineBreaks) {
          return value.markup;
        }
        const b = budget(this.context);
        const input = scalar(plainValue(value), b);
        b.charge(escapedBytes(input));
        return escapeHtml(input);
      };
    }
    const liquid = new Liquid(options);
    for (const tag of Object.keys(liquid.tags)) {
      if (
        ![
          "assign",
          "capture",
          "for",
          "if",
          "unless",
          "comment",
          "raw",
          "break",
          "continue",
        ].includes(tag)
      ) {
        delete liquid.tags[tag];
      }
    }
    for (const filter of Object.keys(liquid.filters)) {
      liquid.unregisterFilter(filter);
    }
    // Every filter registered below reads its input and arguments with `plainValue` (B135 review B1).
    const registerFilter = liquid.registerFilter.bind(liquid);
    liquid.registerFilter = (name: string, filter: FilterImplOptions) => {
      registerFilter(name, typeof filter === "function" ? readsText(filter) : filter);
    };
    liquid.registerFilter("raw", {
      raw: true,
      handler(value) {
        const b = budget(this.context);
        b.step();
        // A line break output is written as its markup, which is already escaped (B135 review N5).
        return value instanceof LineBreaks ? value.markup : scalar(plainValue(value), b);
      },
    });
    liquid.registerFilter("default", function (value, fallback) {
      const b = budget(this.context);
      b.step();
      const out =
        value === null || value === undefined || value === false || value === ""
          ? scalar(fallback, b)
          : scalar(value, b);
      b.charge(byteLength(out));
      return out;
    });
    liquid.registerFilter("strip", function (value) {
      const b = budget(this.context);
      b.step();
      const input = scalar(value, b);
      b.charge(byteLength(input));
      return input.trim();
    });
    liquid.registerFilter("upcase", function (value) {
      const b = budget(this.context);
      b.step();
      const input = scalar(value, b);
      let size = 0;
      for (const c of input) {
        size += byteLength(c.toUpperCase());
        if (b.bytes + size > TOTAL_LIMIT) {
          throw new Error("Render limit");
        }
      }
      b.charge(size);
      return input.toUpperCase();
    });
    liquid.registerFilter("t", function (value, ...args) {
      const b = budget(this.context);
      b.step();
      const key = scalar(value, b);
      if (byteLength(key) > 256 || args.length > 8 || args.length % 2) {
        throw new Error("Invalid translation");
      }
      let out = translation.T(key);
      b.charge(byteLength(out));
      for (let i = 0; i < args.length; i += 2) {
        const name = scalar(args[i], b);
        const value = scalar(args[i + 1], b);
        if (!/^[a-z0-9_.-]{1,128}$/i.test(name) || byteLength(value) > 1024) {
          throw new Error("Invalid translation");
        }
        const marker = `{${name}}`;
        let count = 0,
          pos = 0;
        while ((pos = out.indexOf(marker, pos)) !== -1) {
          count++;
          pos += marker.length;
        }
        const size = byteLength(out) + count * (byteLength(value) - byteLength(marker));
        b.charge(size);
        out = out.replaceAll(marker, () => value);
      }
      return out;
    });
    liquid.registerFilter("track_link", function (value) {
      const b = budget(this.context);
      b.step();
      let out = url(value, b);
      // listmonk trackLink: unescape &amp; and register the URL for this message.
      const link = trackers.get(this.context)?.link;
      if (out && link) {
        out = link(out.replaceAll("&amp;", "&"));
      }
      b.charge(byteLength(out));
      return out;
    });
    liquid.registerFilter("date", function (value, format) {
      const b = budget(this.context);
      b.step();
      // Nil is empty, so a date of nothing renders nothing (D134).
      const text = value === null || value === undefined ? "" : scalar(value, b);
      const fmt = scalar(format, b);
      if (byteLength(fmt) > 256) {
        throw new TextError("a date format is longer than 256 bytes");
      }
      const unsupported = unsupportedDirective(fmt);
      if (unsupported !== undefined) {
        throw new TextError(
          `a date format has the unsupported directive ${unsupported}; the supported directives are ${SUPPORTED_DIRECTIVES}`,
        );
      }
      // An empty format returns the input, as LiquidJS does.
      if (fmt === "") {
        return text;
      }
      const date = parseDate(text);
      if (date === undefined) {
        // A value that is not a date renders empty. A literal one is the template's own text, which a save refuses.
        if (b.literal() && text !== "") {
          throw new ValueError(
            `needs a valid date (YYYY-MM-DD or a UTC timestamp), got ${kindOf(value)}`,
          );
        }
        return "";
      }
      // Each format byte writes at most a month or weekday name of nine bytes, so the bound is charged first.
      b.charge(byteLength(fmt) * 9);
      return formatDate(fmt, date);
    });
    liquid.registerFilter("size", function (value: unknown) {
      return sizeOf(value, budget(this.context));
    });
    liquid.registerFilter("json", function (value: unknown) {
      return json(value, budget(this.context));
    });
    liquid.registerFilter("downcase", function (value: unknown) {
      return downcase(value, budget(this.context));
    });
    liquid.registerFilter("capitalize", function (value: unknown) {
      return capitalize(value, budget(this.context));
    });
    liquid.registerFilter("prepend", function (value: unknown, argument: unknown) {
      return prepend(value, argument, budget(this.context));
    });
    liquid.registerFilter("append", function (value: unknown, argument: unknown) {
      return append(value, argument, budget(this.context));
    });
    liquid.registerFilter(
      "replace",
      function (value: unknown, pattern: unknown, replacement: unknown) {
        return replace(value, pattern, replacement, budget(this.context));
      },
    );
    liquid.registerFilter(
      "replace_first",
      function (value: unknown, pattern: unknown, replacement: unknown) {
        return replaceFirst(value, pattern, replacement, budget(this.context));
      },
    );
    liquid.registerFilter("split", function (value: unknown, separator: unknown) {
      return split(value, separator, budget(this.context));
    });
    liquid.registerFilter("join", function (value: unknown, separator: unknown) {
      return join(value, separator, budget(this.context));
    });
    liquid.registerFilter("slice", function (value: unknown, begin: unknown, count: unknown) {
      return slice(value, begin, count, budget(this.context));
    });
    liquid.registerFilter("truncate", function (value: unknown, limit: unknown, ellipsis: unknown) {
      return truncate(value, limit, ellipsis, budget(this.context));
    });
    liquid.registerFilter(
      "truncatewords",
      function (value: unknown, count: unknown, ellipsis: unknown) {
        return truncatewords(value, count, ellipsis, budget(this.context));
      },
    );
    liquid.registerFilter("strip_html", function (value: unknown) {
      return stripHtml(value, budget(this.context));
    });
    liquid.registerFilter("plus", function (value: unknown, argument: unknown) {
      return arithmetic("plus", value, argument, budget(this.context));
    });
    liquid.registerFilter("minus", function (value: unknown, argument: unknown) {
      return arithmetic("minus", value, argument, budget(this.context));
    });
    liquid.registerFilter("times", function (value: unknown, argument: unknown) {
      return arithmetic("times", value, argument, budget(this.context));
    });
    liquid.registerFilter(
      "divided_by",
      function (value: unknown, argument: unknown, whole: unknown) {
        // Division is always a decimal, as LiquidJS's own is (lead decision 1, D134): `10 | divided_by: 4` is 2.5,
        // whatever the operands were written as. Only the literal `true` (or a JSON true from data) as the second
        // argument rounds down, as LiquidJS's integer argument does: `10 | divided_by: 4, true` is 2.
        return arithmetic("divided_by", value, argument, budget(this.context), whole === true);
      },
    );
    liquid.registerFilter("round", function (value: unknown, digits: unknown) {
      return round(value, digits, budget(this.context), this.token.args.length > 0);
    });
    liquid.registerFilter("first", function (value: unknown) {
      return first(value, budget(this.context));
    });
    liquid.registerFilter("last", function (value: unknown) {
      return last(value, budget(this.context));
    });
    liquid.registerFilter("url_encode", function (value: unknown) {
      return urlEncode(value, budget(this.context));
    });
    liquid.registerFilter("first_name", function (value: unknown) {
      return firstName(value, budget(this.context));
    });
    // Not a raw filter: its output is a LineBreaks value, which an HTML output writes as its markup (escaped once)
    // and a later filter reads as its text, so that filter escapes it once (B135 review N5).
    liquid.registerFilter("newline_to_br", function (value: unknown) {
      return newlineToBr(value, html, budget(this.context));
    });
    liquid.registerFilter("number", function (value: unknown) {
      const b = budget(this.context);
      b.step();
      // Only finite numbers are formatted. Anything else returns unchanged, so it renders as it would
      // without the filter: text is kept, nil is empty, and objects, arrays and non-finite numbers
      // are refused by the output step exactly as they are without it.
      if (typeof value !== "number" || !Number.isFinite(value)) {
        if (typeof value === "string") {
          b.charge(byteLength(value));
        }
        return value;
      }
      // The largest finite number has 309 integer digits; with grouping and sign, at most 412 bytes.
      const out = numberFormat.format(value);
      b.charge(byteLength(out));
      return out;
    });
    // Every nested render, including capture, receives a bounded emitter and the same context budget.
    liquid.renderer.renderTemplates = function* (
      templates: Array<Template>,
      ctx: Context,
      emitter?: Emitter,
    ): IterableIterator<unknown> {
      const b = budget(ctx);
      b.step();
      if (++b.depth > MAX_DEPTH) {
        throw new Error("Nesting limit");
      }
      const out = emitter ?? new BoundedEmitter(b, OUTPUT_LIMIT);
      try {
        for (const template of templates) {
          b.step();
          const start = b.reads;
          b.start = start;
          let value: unknown;
          try {
            value = yield template.render(ctx, out);
          } catch (error) {
            throw faultOf(error, template, b.reads === start);
          }
          if (value) {
            out.write(value);
          }
          if (ctx.breakCalled || ctx.continueCalled) {
            break;
          }
        }
        return out.buffer;
      } finally {
        b.depth--;
      }
    };
    return liquid;
  }
  const htmlEngine = engine(true);
  const plainEngine = engine(false);
  function parse(source: string, html: boolean, limit = SOURCE_LIMIT) {
    checkSource(source, limit);
    return (html ? htmlEngine : plainEngine).parse(source);
  }
  function validate(body: string, subject: string, campaign: boolean) {
    let compiled: Array<Template>;
    try {
      compiled = parse(body, true);
    } catch (error) {
      throw new TemplateSourceError("body", unknownFilter(error));
    }
    try {
      parse(subject, false, SUBJECT_LIMIT);
    } catch (error) {
      throw new TemplateSourceError("subject", unknownFilter(error));
    }
    if (hasForWithFilter(body) || hasForWithFilter(subject)) {
      throw new TemplateSourceError("loop");
    }
    if (campaign && !hasContent(compiled)) {
      throw new TemplateSourceError("slot");
    }
  }
  let active = 0;
  type Compiled = { body: Array<Template>; subject: Array<Template>; layout?: Array<Template> };
  function runMessage(
    request: RenderRequest,
    data: { [key: string]: TemplateData },
    compiled?: Compiled,
    tracking?: RenderTracking,
    budget?: MessageBudget,
  ) {
    if (budget !== undefined && !(budget instanceof Budget)) {
      throw new Error("Invalid budget");
    }
    if (request.mode !== "html" && request.mode !== "plain" && request.mode !== "markdown") {
      throw new Error("Invalid render mode");
    }
    const b = budget ?? new Budget();
    for (const key of [
      "unsubscribe_url",
      "manage_url",
      "optin_url",
      "message_url",
      "archive_url",
      "logo_url",
      "reset_url",
      "root_url",
    ]) {
      if (data[key] !== null && data[key] !== undefined) {
        data[key] = url(data[key], b);
      }
    }
    if (request.transactional) {
      data.unsubscribe_url = "";
    }
    // A per-render random marker survives escaping and Markdown; the trusted pixel
    // markup replaces it after the whole message is rendered.
    const viewMarker = tracking?.view ? `igloview${crypto.randomUUID().replaceAll("-", "")}` : "";
    data.track_view = viewMarker;
    const run = (source: string, html: boolean, limit: number, ready?: Array<Template>): string => {
      const e = html ? htmlEngine : plainEngine;
      const parsed =
        ready ?? parse(source, html, limit === SUBJECT_LIMIT ? SUBJECT_LIMIT : SOURCE_LIMIT);
      const ctx = new Context(data, e.options, { sync: true }, { liquid: e });
      budgets.set(ctx, b);
      if (tracking) {
        trackers.set(ctx, tracking);
      }
      // The pinned LiquidJS patch charges expression and property evaluation to
      // the same message budget used by tags, filters and emitters.
      const bounded = ctx as Context & {
        igloBudgetStep: () => void;
        igloBudgetRange: (size: number) => void;
        igloBudgetCollection: (value: unknown) => void;
        igloBudgetFilter: (name: string, count: number) => void;
        igloBudgetForloop: (name: string) => void;
        igloBudgetForArguments: (args: Record<string, unknown>) => void;
        igloBudgetForValues: (args: Record<string, unknown>) => void;
      };
      bounded.igloBudgetStep = () => {
        b.step();
      };
      bounded.igloBudgetRange = (size) => b.step(size);
      bounded.igloBudgetFilter = (name, count) => {
        // Liquid also creates a zero-argument filter for the trusted HTML escaper.
        if (name === "[object Function]" && count === 0) {
          return;
        }
        const maximum = filterArguments.get(name);
        if (maximum === undefined || count > maximum || (name === "t" && count % 2 !== 0)) {
          throw new Error("Invalid filter arguments");
        }
      };
      bounded.igloBudgetForArguments = (args) => {
        let count = 0;
        // The pinned parser admits at most these three distinct names. Reserve
        // runtime hash construction, validation and literal/flag evaluation
        // before Hash.render creates an object/key list or evaluates values.
        for (const key in args) {
          if (
            !Object.hasOwn(args, key) ||
            (key !== "offset" && key !== "limit" && key !== "reversed") ||
            ++count > 3
          ) {
            throw new Error("Invalid for arguments");
          }
        }
        b.step(1 + count * 2);
      };
      bounded.igloBudgetForValues = (args) => {
        for (const key in args) {
          const value = args[key];
          if (typeof value === "string") {
            b.step(Math.ceil(byteLength(value) / 1024));
            // Store numeric slice bounds so offset:continue adds, not concatenates.
            if (key === "offset" || key === "limit") {
              args[key] = Number(value) || 0;
            }
          } else if (
            value !== null &&
            value !== undefined &&
            typeof value !== "boolean" &&
            !(typeof value === "number" && Number.isFinite(value))
          ) {
            throw new ValueError("Invalid for argument value");
          }
        }
      };
      bounded.igloBudgetForloop = (name) => {
        const bytes = byteLength(name);
        b.step(1 + Math.ceil(bytes / 1024));
        // Reserve a conservative JSON-escaped name and finite numeric metadata
        // before Liquid's implicit Drop conversion can allocate its string.
        b.charge(128 + 6 * bytes);
      };
      bounded.igloBudgetCollection = (value) => {
        if (Array.isArray(value)) {
          if (value.length > 1024) {
            throw new ValueError("Array limit");
          }
          b.step(value.length);
          return;
        }
        if (value && typeof value === "object") {
          if (Object.getPrototypeOf(value) !== null) {
            throw new Error("Invalid collection");
          }
          let count = 0;
          for (const _key in value) {
            if (++count > 1024) {
              throw new ValueError("Array limit");
            }
            b.step(3);
          }
          return;
        }
        b.step();
      };
      const read = ctx.readProperty.bind(ctx);
      ctx.readProperty = (object, key) => {
        // Every read counts, so a failure whose expression reads nothing is a literal one (D134).
        b.reads++;
        if (typeof key === "string" && dangerous.has(key)) {
          throw new Error("Invalid lookup");
        }
        // A key from data that is nil, a list or an object is a value failure, not a template fault.
        if (typeof key !== "string" && (typeof key !== "number" || !Number.isFinite(key))) {
          throw new ValueError(`a property name must be text or a number, got ${kindOf(key)}`);
        }
        if (object instanceof Drop && (typeof key !== "string" || !loopProperties.has(key))) {
          throw new Error("Invalid loop property");
        }
        const value: unknown = read(object, key);
        return value;
      };
      // Only the range evaluator uses the built-in memory limiter in our supported subset. Its bounds
      // come from the template's text or from data: a literal one is refused at save, a data one fails
      // at send (D134).
      const use = ctx.memoryLimit.use.bind(ctx.memoryLimit);
      ctx.memoryLimit.use = (n: number) => {
        if (!Number.isInteger(n) || n < 0 || n > 1024) {
          throw new ValueError("a range or loop is out of bounds");
        }
        use(n);
      };
      const out = new BoundedEmitter(b, limit);
      toValueSync(e.renderer.renderTemplates(parsed, ctx, out));
      budgets.delete(ctx);
      return out.buffer;
    };
    let subject = run(request.subject ?? "", false, SUBJECT_LIMIT, compiled?.subject);
    let body = run(request.body, request.mode !== "plain", OUTPUT_LIMIT, compiled?.body);
    if (request.mode === "markdown") {
      body = renderMarkdown(
        body,
        createMarkdownBudget((n) => b.charge(n)),
      );
    }
    if (request.layout !== undefined) {
      data.content = body;
      body = run(request.layout, request.mode !== "plain", OUTPUT_LIMIT, compiled?.layout);
    }
    if (viewMarker) {
      const pixel =
        request.mode === "plain"
          ? ""
          : `<img src="${attribute(must(must(tracking, "render tracking").view, "tracking view"))}" width="1" height="1" style="display:none;max-height:0;max-width:0;opacity:0" alt="">`;
      const count = body.split(viewMarker).length - 1;
      const size = byteLength(body) + count * (byteLength(pixel) - byteLength(viewMarker));
      if (size > OUTPUT_LIMIT) {
        throw new Error("Output limit");
      }
      b.charge(Math.max(0, size - byteLength(body)));
      body = body.replaceAll(viewMarker, () => pixel);
      subject = subject.replaceAll(viewMarker, "");
    }
    return { body, subject };
  }

  /**
   * The first literal fault in any part of a message's text (D134), or undefined. Each part's whole text is
   * read, so a branch the sample never reaches is checked too.
   */
  function literalFaultOf(request: Omit<RenderRequest, "data">): string | undefined {
    const html = request.mode !== "plain";
    return (
      literalFault(parse(request.body, html)) ??
      (request.subject === undefined
        ? undefined
        : literalFault(parse(request.subject, false, SUBJECT_LIMIT))) ??
      (request.layout === undefined ? undefined : literalFault(parse(request.layout, html)))
    );
  }

  /**
   * The save-time render (D134): the parts render once, as a send renders them, against `data`.
   * It refuses a failure the template's own text causes (`refused`). A failure of a value
   * `data` does not carry is not refused: the sample cannot tell a missing value from a present one,
   * so that message is refused, if at all, when it is sent.
   */
  function check(request: Omit<RenderRequest, "data">, data: string): SaveCheck {
    if (active >= 4) {
      return { outcome: "busy" };
    }
    active++;
    try {
      // A literal argument its filter cannot read fails every message, whatever data it carries, so the
      // text alone refuses it, with the filter and the argument (D134).
      const fault = literalFaultOf(request);
      if (fault !== undefined) {
        return { outcome: "refused", reason: fault };
      }
      runMessage({ ...request, data }, parseTemplateData(data));
      return { outcome: "ok" };
    } catch (error) {
      const reason = refusal(error);
      return reason === undefined ? { outcome: "ok" } : { outcome: "refused", reason };
    } finally {
      active--;
    }
  }
  function renderSync(request: RenderRequest, budget?: MessageBudget) {
    if (active >= 4) {
      throw new RenderCapacityError();
    }
    active++;
    try {
      return runMessage(request, parseTemplateData(request.data), undefined, undefined, budget);
    } finally {
      active--;
    }
  }
  async function render(request: RenderRequest): Promise<{ body: string; subject: string }> {
    if (active >= 4) {
      throw new RenderCapacityError();
    }
    active++;
    try {
      const data = parseTemplateData(request.data);
      const snapshot = { ...request };
      await Promise.resolve();
      return runMessage(snapshot, data);
    } finally {
      active--;
    }
  }
  function compile(input: Omit<RenderRequest, "data">) {
    if (input.mode !== "html" && input.mode !== "plain" && input.mode !== "markdown") {
      throw new Error("Invalid render mode");
    }
    // Strings and mode are captured once; neither a caller mutation nor a same-clock
    // database update can change this snapshot. There is no instance-wide cache.
    const snapshot: Omit<RenderRequest, "data"> = { body: input.body, mode: input.mode };
    if (input.subject !== undefined) {
      snapshot.subject = input.subject;
    }
    if (input.layout !== undefined) {
      snapshot.layout = input.layout;
    }
    if (input.transactional !== undefined) {
      snapshot.transactional = input.transactional;
    }
    const compiled: Compiled = {
      body: parse(snapshot.body, snapshot.mode !== "plain"),
      subject: parse(snapshot.subject ?? "", false, SUBJECT_LIMIT),
    };
    if (snapshot.layout !== undefined) {
      compiled.layout = parse(snapshot.layout, snapshot.mode !== "plain");
    }
    return Object.freeze({
      renderSync(data: string, tracking?: RenderTracking, budget?: MessageBudget) {
        if (active >= 4) {
          throw new RenderCapacityError();
        }
        active++;
        try {
          const clean = parseTemplateData(data);
          return runMessage({ ...snapshot, data }, clean, compiled, tracking, budget);
        } finally {
          active--;
        }
      },
      async render(data: string) {
        if (active >= 4) {
          throw new RenderCapacityError();
        }
        active++;
        try {
          const clean = parseTemplateData(data);
          await Promise.resolve();
          return runMessage({ ...snapshot, data }, clean, compiled);
        } finally {
          active--;
        }
      },
    });
  }
  return { validate, check, compile, render, renderSync };
}
export type TemplateRenderer = ReturnType<typeof createRenderer>;
