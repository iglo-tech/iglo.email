// Local Markdown rendering using marked 15.0.12. Its pinned patch reports the characters marked
// examines (scan), the strings it materializes (charge) and each token (step) through
// `igloBudget`, so the work counter follows the scanning and not the input's size alone.
import { Lexer, Parser, type MarkedOptions } from "marked";

const OUTPUT_LIMIT = 1024 * 1024;
const MAX_DEPTH = 32;
/**
 * The Markdown source after Liquid expansion, in UTF-8 bytes (D112, B105 r2). It is checked before marked
 * sees the source, so an expansion above it is refused at once.
 */
export const MARKDOWN_SOURCE_LIMIT = 128 * 1024;
/**
 * Work units approximate time, about 5 ns each. The patched marked charges what each scan consumed, after
 * the scan (a character 1, a block-level character 20, a line 400 more); a closer search 30 per character it
 * examines; a token 800 (a block token, or an inline token that starts with a special character) or 200
 * (plain text); each emphasis closer exec 1500; and a scan that can run past its token at its regex cost (a
 * lazy heading scan 64 per character, an emphasis opener 8, a failed link, code span or strikethrough 8, 8
 * and 40 per character, a blockquote window 16). Some scans are checked, not charged, before they run
 * (`check`): an emphasis closer search (30 per remaining character) and a blockquote attempt (16 per window
 * character), so a scan that the budget cannot cover is refused before it runs. See D112.
 */
const WORK_LIMIT = 36_000_000;
const TOKEN_UNITS = 800;

/** A Markdown source above MARKDOWN_SOURCE_LIMIT after template expansion (D112). */
export class MarkdownSourceError extends Error {
  constructor() {
    super("Markdown is larger than 128 KiB after template expansion");
  }
}
/** Upper bound on the tag bytes marked writes around each token, by type (marked 15 renderer). A table cell
 * (an object without a type) is `<th align="...">` plus its close. A task item's checkbox is TASK_CHECKBOX. */
const WRAP: Readonly<Record<string, number>> = {
  list_item: 16,
  paragraph: 8,
  heading: 12,
  hr: 8,
  br: 8,
  code: 56,
  codespan: 16,
  blockquote: 32,
  list: 48,
  table: 64,
  link: 32,
  image: 40,
  em: 16,
  strong: 20,
  del: 16,
  text: 0,
  escape: 0,
  html: 0,
  space: 0,
  def: 0,
};
const WRAP_OTHER = 64;
const WRAP_CELL = 32;
/** `<input checked="" disabled="" type="checkbox">` (46 bytes), its separating space and a margin. */
const TASK_CHECKBOX = 64;
const bytes = (value: string) => Buffer.byteLength(value, "utf8");

export interface MarkdownBudget {
  /** Charges bytes to the message's emission budget; throws when the budget is exhausted. */
  charge(bytes: number): void;
  step(units?: number): void;
  scan(units: number): void;
  /** Throws if `units` more work would exceed the limit; charges nothing. */
  check(units: number): void;
  depth: number;
}

/** A budget for one Markdown render. `charge` is the message's (or content conversion's) byte budget. */
export function createMarkdownBudget(charge: (bytes: number) => void): MarkdownBudget {
  let work = 0;
  const add = (units: number) => {
    if (!Number.isSafeInteger(units) || units < 0 || (work += units) > WORK_LIMIT)
      throw new Error("Work limit");
  };
  return {
    charge,
    step: (units = 1) => add(units),
    scan: add,
    check: (units: number) => {
      if (!Number.isSafeInteger(units) || units < 0 || work + units > WORK_LIMIT)
        throw new Error("Work limit");
    },
    depth: 0,
  };
}

// Characters encodeURI leaves as they are; every other UTF-8 byte becomes %XX.
const URI_SAFE = /[A-Za-z0-9;,/?:@&=+$\-_.!~*'()#]/;
/** Bytes of `href` after marked's cleanUrl (encodeURI), an upper bound: one byte when safe, else %XX per byte. */
function encoded(href: string): number {
  let total = 0;
  for (const char of href) total += URI_SAFE.test(char) ? 1 : 3 * bytes(char);
  return total;
}
const SPECIAL_EXTRA: Readonly<Record<string, number>> = { "&": 4, "<": 3, ">": 3, '"': 5, "'": 4 };
/** Bytes of `value` after escaping, an upper bound: each special character expands to its entity. */
function escaped(value: string): number {
  let total = bytes(value);
  for (let i = 0; i < value.length; i++) total += SPECIAL_EXTRA[value[i]!] ?? 0;
  return total;
}

/** The raw bytes of every text string in a token subtree. */
function leafBytes(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce((total: number, item) => total + leafBytes(item), 0);
  if (!value || typeof value !== "object") return 0;
  const token = value as Record<string, unknown>;
  let total = typeof token.text === "string" ? bytes(token.text) : 0;
  for (const key of ["tokens", "items", "header", "rows"]) total += leafBytes(token[key]);
  return total;
}

/**
 * Upper bound on the bytes marked emits, computed once per token (no prefix sums). Text and titles
 * are escaped (at most `&amp;`/`&quot;`-sized expansion per special character), hrefs are
 * percent-encoded (at most 3 bytes per byte), raw HTML is copied, and each tag wrapper has a fixed
 * allowance. Parents count only their own fields; children are counted once, through `tokens`,
 * `items`, `header` and `rows`.
 */
function reserve(tokens: unknown[], budget: MarkdownBudget): void {
  const visit = (value: unknown, depth: number): number => {
    if (depth > MAX_DEPTH) throw new Error("Nesting limit");
    if (Array.isArray(value)) {
      let total = 0;
      for (const item of value) total += visit(item, depth);
      if (!Number.isSafeInteger(total)) throw new Error("Markdown limit");
      return total;
    }
    if (!value || typeof value !== "object") throw new Error("Invalid Markdown token");
    budget.step(100);
    const token = value as Record<string, unknown>;
    const type = token.type;
    let upper =
      typeof type === "string" ? (Object.hasOwn(WRAP, type) ? WRAP[type]! : WRAP_OTHER) : WRAP_CELL;
    // A task item's checkbox is written into its first child after this reserve (the renderer mutates
    // the tokens), so each task item reserves its checkbox here.
    if (token.task === true) upper += TASK_CHECKBOX;
    if (type === "html") {
      if (typeof token.text === "string") upper += bytes(token.text);
    } else {
      // A token with children emits them, not its own raw text; a leaf emits its text escaped.
      if (typeof token.text === "string" && !Array.isArray(token.tokens))
        upper += escaped(token.text);
      // A block text token in a loose list item is written as a paragraph.
      if (type === "text" && Array.isArray(token.tokens)) upper += WRAP.paragraph!;
      // Image alternative text is the plain text of its children, written through the text renderer,
      // whose escapes can print more than the raw text they came from. Bound it by six bytes per byte.
      if (type === "image" && Array.isArray(token.tokens)) upper += 6 * leafBytes(token.tokens);
      if (typeof token.href === "string") upper += encoded(token.href);
      for (const key of ["title", "lang", "align"]) {
        const item = token[key];
        if (typeof item === "string") upper += escaped(item);
      }
    }
    for (const key of ["tokens", "items", "header", "rows"]) {
      const child = token[key];
      if (Array.isArray(child)) upper += visit(child, depth + 1);
    }
    if (!Number.isSafeInteger(upper)) throw new Error("Markdown limit");
    return upper;
  };
  const upper = visit(tokens, 0);
  if (upper > OUTPUT_LIMIT) throw new Error("Markdown output limit");
  budget.charge(upper);
}

export function renderMarkdown(source: string, budget: MarkdownBudget): string {
  // Checked before marked sees the source: an expansion above the cap is refused at once (D112).
  if (bytes(source) > MARKDOWN_SOURCE_LIMIT) throw new MarkdownSourceError();
  const options = {
    gfm: true,
    igloBudget: {
      enter(text: string) {
        budget.step(TOKEN_UNITS);
        if (++budget.depth > MAX_DEPTH) throw new Error("Nesting limit");
        budget.charge(bytes(text));
      },
      leave() {
        budget.depth--;
      },
      step(count = 1) {
        budget.step(count);
      },
      scan(count: number) {
        budget.scan(count);
      },
      check(count: number) {
        budget.check(count);
      },
      copy(text: string) {
        budget.charge(bytes(text));
      },
      table(headers: number, rows: number) {
        budget.step(headers * (rows + 1));
      },
    },
  } as MarkedOptions;
  const tokens = Lexer.lex(source, options);
  reserve(tokens, budget);
  const output = Parser.parse(tokens, options);
  if (bytes(output) > OUTPUT_LIMIT) throw new Error("Markdown output limit");
  return output;
}
