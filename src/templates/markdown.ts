// Local Markdown rendering using marked 15.0.12. Its pinned patch forwards the
// message budget to the lexer before repeated string and token allocations.
import { Lexer, Parser, type MarkedOptions } from "marked";

const OUTPUT_LIMIT = 1024 * 1024;
const MAX_DEPTH = 32;
const bytes = (value: string) => Buffer.byteLength(value, "utf8");

interface MessageBudget {
  charge(value: number): void;
  step(value?: number): void;
  depth: number;
}

/** Reserve a conservative upper bound for marked's token and renderer output.
 * Reference hrefs are counted once per use, including URL encoding and HTML
 * escaping. Parents are counted again for their nested parser intermediates. */
function reserve(tokens: unknown[], budget: MessageBudget) {
  let intermediate = 0;
  function visit(value: unknown, depth: number): number {
    if (depth > MAX_DEPTH) throw new Error("Nesting limit");
    if (Array.isArray(value)) {
      let total = 0;
      for (const item of value) {
        total += visit(item, depth);
        // Marked concatenates each token/item/cell into its enclosing string.
        // Reserve every prefix before the parser performs those concatenations.
        intermediate += total;
        if (!Number.isSafeInteger(intermediate)) throw new Error("Markdown limit");
      }
      return total;
    }
    if (!value || typeof value !== "object") throw new Error("Invalid Markdown token");
    budget.step();
    const token = value as Record<string, unknown>;
    let upper = token.type === "html" ? 0 : 192;
    for (const key of ["text", "href", "title", "lang", "align"]) {
      const item = token[key];
      if (typeof item === "string") upper += bytes(item) * (token.type === "html" ? 1 : 6);
    }
    for (const key of ["tokens", "items", "header", "rows"]) {
      const child = token[key];
      if (Array.isArray(child)) upper += visit(child, depth + 1);
    }
    if (!Number.isSafeInteger(upper) || upper > OUTPUT_LIMIT)
      throw new Error("Markdown output limit");
    if (token.type !== "html") intermediate += upper;
    if (!Number.isSafeInteger(intermediate)) throw new Error("Markdown limit");
    return upper;
  }
  const upper = visit(tokens, 0);
  if (upper > OUTPUT_LIMIT) throw new Error("Markdown output limit");
  budget.charge(intermediate);
}

export function renderMarkdown(source: string, budget: MessageBudget): string {
  const options = {
    gfm: true,
    igloBudget: {
      enter(text: string) {
        budget.step();
        if (++budget.depth > MAX_DEPTH) throw new Error("Nesting limit");
        budget.charge(bytes(text));
      },
      leave() {
        budget.depth--;
      },
      step(count = 1) {
        budget.step(count);
      },
      copy(text: string) {
        budget.step();
        budget.charge(bytes(text));
      },
      lineInput(text: string, pipes: boolean) {
        let units = Math.ceil(text.length / 1024);
        for (const c of text) {
          if (c === "\n" || (pipes && c === "|")) {
            if (++units > 10_000) throw new Error("Work limit");
          }
        }
        budget.step(units);
      },
      table(headers: number, rows: number) {
        const cells = headers * (rows + 1);
        budget.step(cells);
        budget.charge(cells * 64);
      },
    },
  } as MarkedOptions;
  const tokens = Lexer.lex(source, options);
  reserve(tokens, budget);
  const output = Parser.parse(tokens, options);
  if (bytes(output) > OUTPUT_LIMIT) throw new Error("Markdown output limit");
  return output;
}
