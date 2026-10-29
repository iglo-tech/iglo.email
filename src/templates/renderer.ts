// Liquid rendering context and composition adapted from listmonk models/campaigns.go,
// models/messages.go and internal/manager/message.go at 6fcd95f.
import {
  Context,
  Drop,
  Liquid,
  Output,
  defaultOperators,
  toValueSync,
  type Emitter,
  type Template,
} from "liquidjs";
import type { Clock } from "@/clock";
import type { Translation } from "@/i18n/i18n";
import { parseTemplateData, type TemplateData } from "@/templates/data";
import { renderMarkdown } from "@/templates/markdown";

const SOURCE_LIMIT = 64 * 1024;
const OUTPUT_LIMIT = 1024 * 1024;
const SUBJECT_LIMIT = 2048;
const TOTAL_LIMIT = 4 * 1024 * 1024;
const MAX_WORK = 10_000;
const MAX_DEPTH = 32;
const dangerous = new Set(["__proto__", "prototype", "constructor"]);
const loopProperties = new Set(["index", "index0", "rindex", "rindex0", "first", "last", "length"]);
const filterArguments: Readonly<Record<string, number>> = {
  raw: 0,
  default: 1,
  upcase: 0,
  strip: 0,
  t: 8,
  date: 1,
  track_link: 0,
};
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

export class TemplateSourceError extends Error {
  constructor(readonly field: "body" | "subject" | "slot") {
    super(field);
  }
}
export class RenderCapacityError extends Error {
  constructor() {
    super("Render capacity");
  }
}

class Budget {
  bytes = 0;
  work = 0;
  depth = 0;
  charge(n: number) {
    if (!Number.isSafeInteger(n) || n < 0 || this.bytes + n > TOTAL_LIMIT)
      throw new Error("Render limit");
    this.bytes += n;
  }
  step(count = 1) {
    if (!Number.isSafeInteger(count) || count < 0 || this.work + count > MAX_WORK)
      throw new Error("Work limit");
    this.work += count;
  }
}
class BoundedEmitter implements Emitter {
  buffer = "";
  bytes = 0;
  constructor(
    private readonly budget: Budget,
    private readonly limit: number,
  ) {}
  write(value: unknown) {
    const string = scalar(value);
    const n = byteLength(string);
    if (this.bytes + n > this.limit) throw new Error("Output limit");
    this.budget.charge(n);
    this.bytes += n;
    this.buffer += string;
  }
}
function scalar(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
    return String(value);
  throw new Error("Invalid value");
}
function url(value: unknown): string {
  const text = scalar(value);
  if (!text) return "";
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Invalid URL");
    return text;
  } catch {
    throw new Error("Invalid URL");
  }
}
function checkSource(value: string, limit: number) {
  if (typeof value !== "string" || byteLength(value) > limit || value.includes("\0"))
    throw new Error("Invalid source");
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
const attribute = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Instance-owned renderer. Includes, render and layout tags are deliberately unavailable. */
export function createRenderer(clock: Clock, translation: Translation) {
  const budgets = new WeakMap<Context, Budget>();
  const trackers = new WeakMap<Context, RenderTracking>();
  const budget = (ctx: Context) => {
    const result = budgets.get(ctx);
    if (!result) throw new Error("Missing budget");
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
        if (value.length > 1024) throw new Error("Array limit");
        for (let i = 0; i < value.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (descriptor && !("value" in descriptor)) throw new Error("Invalid value");
          cost += chargeComparison(descriptor?.value, b);
        }
      }
      return cost;
    };
    // JavaScript's relational operators join arrays into one string before
    // comparing. Reserve a conservative size for that string first.
    const joinedBytes = (value: unknown): number => {
      if (typeof value === "string") return byteLength(value);
      if (Array.isArray(value)) {
        let bytes = Math.max(0, value.length - 1);
        for (const item of value) bytes += joinedBytes(item);
        return bytes;
      }
      return value == null ? 0 : 32;
    };
    for (const name of ["==", "!=", ">", "<", ">=", "<=", "contains"] as const) {
      const original = operators[name] as (left: unknown, right: unknown, ctx: Context) => unknown;
      operators[name] = function* (left: unknown, right: unknown, ctx: Context) {
        const b = budget(ctx);
        chargeComparison(left, b);
        const rightCost = chargeComparison(right, b);
        if (name !== "==" && name !== "!=" && name !== "contains")
          for (const operand of [left, right])
            if (Array.isArray(operand)) b.charge(joinedBytes(operand));
        if (name === "contains" && Array.isArray(left) && left.length > 1)
          b.step((left.length - 1) * rightCost);
        return yield original(left, right, ctx);
      };
    }
    const liquid = new Liquid({
      operators,
      templates: Object.create(null),
      strictFilters: true,
      ownPropertyOnly: true,
      parseLimit: SOURCE_LIMIT,
      renderLimit: 1000,
      memoryLimit: TOTAL_LIMIT,
      globals: Object.create(null),
      locale: "en-US",
      ...(html
        ? {
            outputEscape: function (this: { context: Context }, value: unknown) {
              const input = scalar(value);
              let size = 0;
              for (const c of input)
                size +=
                  c === "&"
                    ? 5
                    : c === "<" || c === ">"
                      ? 4
                      : c === '"' || c === "'"
                        ? 5
                        : byteLength(c);
              budget(this.context).charge(size);
              return input.replace(
                /[&<>"']/g,
                (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" })[c]!,
              );
            },
          }
        : {}),
    });
    for (const tag of Object.keys(liquid.tags))
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
      )
        delete liquid.tags[tag];
    for (const filter of Object.keys(liquid.filters)) liquid.unregisterFilter(filter);
    liquid.registerFilter("raw", {
      raw: true,
      handler(value) {
        budget(this.context).step();
        return scalar(value);
      },
    });
    liquid.registerFilter("default", function (value, fallback) {
      const b = budget(this.context);
      b.step();
      const out =
        value == null || value === false || value === "" ? scalar(fallback) : scalar(value);
      b.charge(byteLength(out));
      return out;
    });
    liquid.registerFilter("strip", function (value) {
      const b = budget(this.context);
      b.step();
      const input = scalar(value);
      b.charge(byteLength(input));
      return input.trim();
    });
    liquid.registerFilter("upcase", function (value) {
      const b = budget(this.context);
      b.step();
      const input = scalar(value);
      let size = 0;
      for (const c of input) {
        size += byteLength(c.toUpperCase());
        if (b.bytes + size > TOTAL_LIMIT) throw new Error("Render limit");
      }
      b.charge(size);
      return input.toUpperCase();
    });
    liquid.registerFilter("t", function (value, ...args) {
      const b = budget(this.context);
      b.step();
      const key = scalar(value);
      if (byteLength(key) > 256 || args.length > 8 || args.length % 2)
        throw new Error("Invalid translation");
      let out = translation.T(key);
      b.charge(byteLength(out));
      for (let i = 0; i < args.length; i += 2) {
        const name = scalar(args[i]);
        const value = scalar(args[i + 1]);
        if (!/^[a-z0-9_.-]{1,128}$/i.test(name) || byteLength(value) > 1024)
          throw new Error("Invalid translation");
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
      let out = url(value);
      // listmonk trackLink: unescape &amp; and register the URL for this message.
      const link = trackers.get(this.context)?.link;
      if (out && link) out = link(out.replaceAll("&amp;", "&"));
      b.charge(byteLength(out));
      return out;
    });
    liquid.registerFilter("date", function (value, format) {
      const b = budget(this.context);
      b.step();
      const text = scalar(value);
      const fmt = scalar(format);
      if (byteLength(fmt) > 256 || /%(?![%YmdHMS])/.test(fmt))
        throw new Error("Invalid date format");
      if (
        text !== "now" &&
        text !== "today" &&
        !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(text)
      )
        throw new Error("Invalid date");
      const date = text === "now" || text === "today" ? clock.now() : new Date(text);
      if (!Number.isFinite(date.getTime())) throw new Error("Invalid date");
      const pad = (n: number) => String(n).padStart(2, "0");
      const values: Record<string, string> = {
        "%": "%",
        Y: String(date.getUTCFullYear()),
        m: pad(date.getUTCMonth() + 1),
        d: pad(date.getUTCDate()),
        H: pad(date.getUTCHours()),
        M: pad(date.getUTCMinutes()),
        S: pad(date.getUTCSeconds()),
      };
      const out = fmt.replace(/%(.)/g, (_, key: string) => values[key]!);
      b.charge(byteLength(out));
      return out;
    });
    // Every nested render, including capture, receives a bounded emitter and the same context budget.
    liquid.renderer.renderTemplates = function* (
      templates: Template[],
      ctx: Context,
      emitter?: Emitter,
    ): IterableIterator<unknown> {
      const b = budget(ctx);
      b.step();
      if (++b.depth > MAX_DEPTH) throw new Error("Nesting limit");
      const out = emitter ?? new BoundedEmitter(b, OUTPUT_LIMIT);
      try {
        for (const template of templates) {
          b.step();
          ctx.renderLimit.check(performance.now());
          const value: unknown = yield template.render(ctx, out);
          if (value) out.write(value);
          if (ctx.breakCalled || ctx.continueCalled) break;
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
  function hasContent(templates: Template[]): boolean {
    for (const tpl of templates) {
      if (tpl instanceof Output && /^{{-?\s*content\s*\|\s*raw\s*-?}}$/.test(tpl.token.getText()))
        return true;
      // A content reference captured into a variable is not itself a layout output.
      if ("name" in tpl && tpl.name === "capture") continue;
      if (
        "children" in tpl &&
        tpl.children &&
        hasContent(toValueSync(tpl.children(false, true)) as Template[])
      )
        return true;
    }
    return false;
  }
  function validate(body: string, subject: string, campaign: boolean) {
    let compiled: Template[];
    try {
      compiled = parse(body, true);
    } catch {
      throw new TemplateSourceError("body");
    }
    try {
      parse(subject, false, SUBJECT_LIMIT);
    } catch {
      throw new TemplateSourceError("subject");
    }
    if (campaign && !hasContent(compiled)) throw new TemplateSourceError("slot");
  }
  function refersToUnsubscribe(body: string, subject: string): boolean {
    return (
      htmlEngine.globalVariablesSync(parse(body, true)).includes("unsubscribe_url") ||
      plainEngine
        .globalVariablesSync(parse(subject, false, SUBJECT_LIMIT))
        .includes("unsubscribe_url")
    );
  }
  let active = 0;
  type Compiled = { body: Template[]; subject: Template[]; layout?: Template[] };
  function runMessage(
    request: RenderRequest,
    data: { [key: string]: TemplateData },
    compiled?: Compiled,
    tracking?: RenderTracking,
  ): { body: string; subject: string } {
    if (request.mode !== "html" && request.mode !== "plain" && request.mode !== "markdown")
      throw new Error("Invalid render mode");
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
      if (data[key] != null) data[key] = url(data[key]);
    }
    if (request.transactional) data.unsubscribe_url = "";
    // A per-render random marker survives escaping and Markdown; the trusted pixel
    // markup replaces it after the whole message is rendered.
    const viewMarker = tracking?.view ? `igloview${crypto.randomUUID().replaceAll("-", "")}` : "";
    data.track_view = viewMarker;
    const b = new Budget();
    const run = (source: string, html: boolean, limit: number, ready?: Template[]): string => {
      const e = html ? htmlEngine : plainEngine;
      const parsed =
        ready ?? parse(source, html, limit === SUBJECT_LIMIT ? SUBJECT_LIMIT : SOURCE_LIMIT);
      const ctx = new Context(data, e.options, { sync: true }, { liquid: e });
      budgets.set(ctx, b);
      if (tracking) trackers.set(ctx, tracking);
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
        ctx.renderLimit.check(performance.now());
      };
      bounded.igloBudgetRange = (size) => b.step(size);
      bounded.igloBudgetFilter = (name, count) => {
        // Liquid also creates a zero-argument filter for the trusted HTML escaper.
        if (name === "[object Function]" && count === 0) return;
        if (
          !Object.hasOwn(filterArguments, name) ||
          count > filterArguments[name]! ||
          (name === "t" && count % 2 !== 0)
        )
          throw new Error("Invalid filter arguments");
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
          )
            throw new Error("Invalid for arguments");
        }
        b.step(1 + count * 2);
      };
      bounded.igloBudgetForValues = (args) => {
        for (const key in args) {
          const value = args[key];
          if (typeof value === "string") {
            b.step(Math.ceil(byteLength(value) / 1024));
            // Store numeric slice bounds so offset:continue adds, not concatenates.
            if (key === "offset" || key === "limit") args[key] = Number(value) || 0;
          } else if (
            value != null &&
            typeof value !== "boolean" &&
            !(typeof value === "number" && Number.isFinite(value))
          )
            throw new Error("Invalid for argument value");
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
          if (value.length > 1024) throw new Error("Array limit");
          b.step(value.length);
          return;
        }
        if (value && typeof value === "object") {
          if (Object.getPrototypeOf(value) !== null) throw new Error("Invalid collection");
          let count = 0;
          for (const _key in value) {
            if (++count > 1024) throw new Error("Array limit");
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
        )
          throw new Error("Invalid lookup");
        if (object instanceof Drop && (typeof key !== "string" || !loopProperties.has(key)))
          throw new Error("Invalid loop property");
        return read(object, key);
      };
      // Only the range evaluator uses the built-in memory limiter in our supported subset.
      const use = ctx.memoryLimit.use.bind(ctx.memoryLimit);
      ctx.memoryLimit.use = (n: number) => {
        if (!Number.isInteger(n) || n < 0 || n > 1024) throw new Error("Range limit");
        use(n);
      };
      const out = new BoundedEmitter(b, limit);
      toValueSync(e.renderer.renderTemplates(parsed, ctx, out));
      budgets.delete(ctx);
      return out.buffer;
    };
    let subject = run(request.subject ?? "", false, SUBJECT_LIMIT, compiled?.subject);
    let body = run(request.body, request.mode !== "plain", OUTPUT_LIMIT, compiled?.body);
    if (request.mode === "markdown") body = renderMarkdown(body, b);
    if (request.layout !== undefined) {
      data.content = body;
      body = run(request.layout, request.mode !== "plain", OUTPUT_LIMIT, compiled?.layout);
    }
    if (viewMarker) {
      const pixel =
        request.mode === "plain"
          ? ""
          : `<img src="${attribute(tracking!.view!)}" width="1" height="1" style="display:none;max-height:0;max-width:0;opacity:0" alt="">`;
      const count = body.split(viewMarker).length - 1;
      const size = byteLength(body) + count * (byteLength(pixel) - byteLength(viewMarker));
      if (size > OUTPUT_LIMIT) throw new Error("Output limit");
      b.charge(Math.max(0, size - byteLength(body)));
      body = body.replaceAll(viewMarker, () => pixel);
      subject = subject.replaceAll(viewMarker, "");
    }
    return { body, subject };
  }

  function renderSync(request: RenderRequest): { body: string; subject: string } {
    if (active >= 4) throw new RenderCapacityError();
    active++;
    try {
      return runMessage(request, parseTemplateData(request.data));
    } finally {
      active--;
    }
  }
  async function render(request: RenderRequest): Promise<{ body: string; subject: string }> {
    if (active >= 4) throw new RenderCapacityError();
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
    if (input.mode !== "html" && input.mode !== "plain" && input.mode !== "markdown")
      throw new Error("Invalid render mode");
    // Strings and mode are captured once; neither a caller mutation nor a same-clock
    // database update can change this snapshot. There is no instance-wide cache.
    const snapshot = {
      body: input.body,
      mode: input.mode,
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      ...(input.layout === undefined ? {} : { layout: input.layout }),
      ...(input.transactional === undefined ? {} : { transactional: input.transactional }),
    };
    const compiled: Compiled = {
      body: parse(snapshot.body, snapshot.mode !== "plain"),
      subject: parse(snapshot.subject ?? "", false, SUBJECT_LIMIT),
      ...(snapshot.layout === undefined
        ? {}
        : { layout: parse(snapshot.layout, snapshot.mode !== "plain") }),
    };
    return Object.freeze({
      renderSync(data: string, tracking?: RenderTracking) {
        if (active >= 4) throw new RenderCapacityError();
        active++;
        try {
          return runMessage({ ...snapshot, data }, parseTemplateData(data), compiled, tracking);
        } finally {
          active--;
        }
      },
      async render(data: string) {
        if (active >= 4) throw new RenderCapacityError();
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
  return { validate, refersToUnsubscribe, compile, render, renderSync };
}
export type TemplateRenderer = ReturnType<typeof createRenderer>;
