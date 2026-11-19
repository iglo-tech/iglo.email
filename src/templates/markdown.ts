// Local Markdown rendering using marked 15.0.12. Its pinned patch reports the characters marked
// examines (scan), the strings it materializes (charge) and each token (step) through
// `igloBudget`, so the work counter follows the scanning and not the input's size alone.
import { Lexer, Parser, type MarkedOptions } from "marked";

const OUTPUT_LIMIT = 1024 * 1024;
const MAX_DEPTH = 32;
/**
 * Work units approximate time, about 5 ns each, so the limit is about 200 ms of worst-case work. The patched
 * marked charges each character it consumes 1, each token 800 (a block token, or an inline token that starts
 * with a special character) or 200 (plain text), each emphasis closer exec 600, and each scan that can run
 * past its own token at its regex cost: a lazy heading scan 64 per character, an emphasis opener 8, a failed
 * link, code span or strikethrough 8, 8 and 40 per character, a paragraph window 400 per line. See D112.
 */
const WORK_LIMIT = 40_000_000;
const TOKEN_UNITS = 800;
/** Upper bound on the tag bytes marked writes around each token, by type (marked 15 renderer). A list item
 * may carry a task checkbox; a table cell (an object without a type) is `<th align="...">` plus its close. */
const WRAP: Readonly<Record<string, number>> = {
  list_item: 56,
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
const bytes = (value: string) => Buffer.byteLength(value, "utf8");

export interface MarkdownBudget {
  /** Charges bytes to the message's emission budget; throws when the budget is exhausted. */
  charge(bytes: number): void;
  step(units?: number): void;
  scan(units: number): void;
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
    if (type === "html") {
      if (typeof token.text === "string") upper += bytes(token.text);
    } else {
      // A token with children emits them, not its own raw text; a leaf emits its text escaped.
      if (typeof token.text === "string" && !Array.isArray(token.tokens))
        upper += escaped(token.text);
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
