// Liquid rendering context and composition adapted from listmonk models/campaigns.go,
// models/messages.go and internal/manager/message.go at 6fcd95f.
import { Context, Drop, Liquid, Output, defaultOperators, toValueSync } from "liquidjs";
import type { Emitter, LiquidOptions, Template } from "liquidjs";
import { must } from "@/invariant";
import type { Clock } from "@/clock";
import type { Translation } from "@/i18n/i18n";
import { parseTemplateData } from "@/templates/data";
import type { TemplateData } from "@/templates/data";
import { createMarkdownBudget, renderMarkdown } from "@/templates/markdown";
import {
  append,
  byteLength,
  capitalize,
  downcase,
  join,
  json,
  prepend,
  replace,
  replaceFirst,
  scalar,
  sizeOf,
  slice,
  split,
  stripHtml,
  truncate,
  truncatewords,
  ValueError,
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
/** A `for` tag with a `|` in it: LiquidJS reads only the collection's value and ignores the rest. */
const forWithFilter = /\{%-?\s*for\s[^%]*\|/;
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
 * The outcome of a save-time render (D134). `refused` names the cause of a template's own text in
 * words, with no template text or data; `busy` is the render capacity, not a template fault.
 */
export type SaveCheck =
  | { readonly outcome: "ok" }
  | { readonly outcome: "refused"; readonly reason: string }
  | { readonly outcome: "busy" };
/** The renderer's messages for the template text that causes them, and the reason a save names. */
const refusalReasons = new Map<string, string>([
  ["Invalid date format", "a date format has an unsupported directive"],
  ["Invalid filter arguments", "a filter has the wrong number of arguments"],
  ["Invalid for arguments", "a for tag has an unsupported argument"],
  ["Invalid lookup", "a property name is not allowed"],
  ["Invalid loop property", "a loop property is not available"],
  ["Invalid collection", "a loop collection is not supported"],
  ["Invalid translation", "a translation call is invalid"],
  ["Nesting limit", "the template nests too deeply"],
  ["Range limit", "a range or loop is out of bounds"],
  ["range limit exceeded", "a range or loop is out of bounds"],
  ["Render limit", "the template exceeds a render limit"],
  ["Output limit", "the template exceeds a render limit"],
  ["Work limit", "the template exceeds a render limit"],
]);
/** The error under LiquidJS's wrappers, which keep the thrown one as `originalError`. */
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
 * The reason a save refuses a render error, or undefined when the failure depends on the values a
 * message carries: those are refused, if at all, at send (D134).
 */
function refusal(error: unknown): string | undefined {
  const root = rootError(error);
  if (root instanceof ValueError) {
    return undefined;
  }
  const message = root instanceof Error ? root.message : "";
  return refusalReasons.get(message) ?? "the template cannot be rendered";
}

class Budget {
  bytes = 0;
  work = 0;
  depth = 0;
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
    const string = scalar(value, this.budget);
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
        const input = scalar(value, budget(this.context));
        let size = 0;
        for (const c of input) {
          size +=
            c === "&" ? 5 : c === "<" || c === ">" ? 4 : c === '"' || c === "'" ? 5 : byteLength(c);
        }
        budget(this.context).charge(size);
        return input.replaceAll(/[&<>"']/g, (c) =>
          must({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" }[c], "escape"),
        );
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
    liquid.registerFilter("raw", {
      raw: true,
      handler(value) {
        const b = budget(this.context);
        b.step();
        return scalar(value, b);
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
      const text = scalar(value, b);
      const fmt = scalar(format, b);
      // Left to right: a percent sign is either the pair `%%` (a literal %) or one of the directives,
      // so the second percent of `%%` is not a directive of its own.
      if (byteLength(fmt) > 256 || !/^(?:[^%]|%[%YmdHMS])*$/.test(fmt)) {
        throw new Error("Invalid date format");
      }
      if (
        text !== "now" &&
        text !== "today" &&
        !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(text)
      ) {
        throw new ValueError("Invalid date");
      }
      const date = text === "now" || text === "today" ? clock.now() : new Date(text);
      if (!Number.isFinite(date.getTime())) {
        throw new ValueError("Invalid date");
      }
      // JavaScript rolls 2026-02-30 over to 2026-03-02. A date that does not exist is invalid, as an
      // unparseable one is: its canonical form must keep the date (and the time, for a timestamp).
      if (text !== "now" && text !== "today") {
        const digits = text.length === 10 ? 10 : 19;
        if (date.toISOString().slice(0, digits) !== text.slice(0, digits)) {
          throw new ValueError("Invalid date");
        }
      }
      const values = new Map([
        ["%", "%"],
        ["Y", String(date.getUTCFullYear())],
        ["m", pad(date.getUTCMonth() + 1)],
        ["d", pad(date.getUTCDate())],
        ["H", pad(date.getUTCHours())],
        ["M", pad(date.getUTCMinutes())],
        ["S", pad(date.getUTCSeconds())],
      ]);
      // Every `%` now starts a valid pair, so each key is in the map.
      const out = fmt.replaceAll(/%(.)/g, (_, key: string) => String(values.get(key)));
      b.charge(byteLength(out));
      return out;
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
          const value: unknown = yield template.render(ctx, out);
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
    if (forWithFilter.test(body) || forWithFilter.test(subject)) {
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
        if (
          (typeof key !== "string" && typeof key !== "number") ||
          (typeof key === "number" && !Number.isFinite(key)) ||
          (typeof key === "string" && dangerous.has(key))
        ) {
          throw new Error("Invalid lookup");
        }
        if (object instanceof Drop && (typeof key !== "string" || !loopProperties.has(key))) {
          throw new Error("Invalid loop property");
        }
        const value: unknown = read(object, key);
        return value;
      };
      // Only the range evaluator uses the built-in memory limiter in our supported subset.
      const use = ctx.memoryLimit.use.bind(ctx.memoryLimit);
      ctx.memoryLimit.use = (n: number) => {
        if (!Number.isInteger(n) || n < 0 || n > 1024) {
          throw new Error("Range limit");
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
