// Markdown rendering with Bun's built-in Markdown API (B106, D113). Output is `Bun.markdown.html` with
// listmonk's GFM options (goldmark's Table, Strikethrough and TaskList): tables, strikethrough and task
// lists on; bare-URL autolinks and heading ids off, as today; raw HTML passes through (listmonk's
// WithUnsafe). Bun's Markdown API is marked unstable in its documentation, so this output is tied to the
// pinned Bun version; a Bun upgrade must pass the Markdown pin suite (D113).
//
// The output bound (D112, reworked by B106) is computed before `html()` builds anything. A dry run through
// `Bun.markdown.render` calls back for every element with callbacks that return nothing, so it builds no
// output and charges an upper bound of the bytes `html()` writes for that element. Bun's `render` gives no
// callback for hard breaks (`<br />`), so those are bounded from the source, and inline raw HTML, which no
// callback sees, is bounded by the source's length.
const OUTPUT_LIMIT = 1024 * 1024;
/**
 * The Markdown source after Liquid expansion, in UTF-8 bytes (D112). It is checked before the parser
 * sees the source, so an expansion above it is refused at once.
 */
export const MARKDOWN_SOURCE_LIMIT = 128 * 1024;

const bytes = (value: string) => Buffer.byteLength(value, "utf8");

// Bytes an HTML escape can add, per special character: `&amp;`, `&lt;`, `&gt;`, `&quot;`, and `&#x27;` for an
// apostrophe (Bun writes it in attributes, and the bound charges it everywhere, to be safe).
const SPECIAL_EXTRA: Readonly<Record<string, number>> = { "&": 4, "<": 3, ">": 3, '"': 5, "'": 5 };
/** Upper bound on the bytes of `value` once written as escaped HTML text. */
function escapedBound(value: string): number {
  let total = bytes(value);
  for (let i = 0; i < value.length; i++) total += SPECIAL_EXTRA[value[i]!] ?? 0;
  return total;
}

/** Bytes a hard break writes before its newline (`<br />`). */
const HARD_BREAK_BOUND = 7;

/** A Markdown source above MARKDOWN_SOURCE_LIMIT after template expansion (D112). */
export class MarkdownSourceError extends Error {
  constructor() {
    super("Markdown is larger than 128 KiB after template expansion");
  }
}

/** A message's emission budget (D54); the renderer and content conversion pass their own. */
export interface MarkdownBudget {
  /** Charges bytes to the budget; throws when it is exhausted. */
  charge(bytes: number): void;
}

export function createMarkdownBudget(charge: (bytes: number) => void): MarkdownBudget {
  return { charge };
}

// listmonk's configuration (models/common.go at 6fcd95f), as Bun's options: GFM tables, strikethrough and
// task lists (Bun's defaults); autolinks, heading ids and every other extension off.
const OPTIONS: Bun.markdown.Options = {
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: false,
  headings: false,
  hardSoftBreaks: false,
  wikiLinks: false,
  underline: false,
  latexMath: false,
  collapseWhitespace: false,
  permissiveAtxHeaders: false,
  noIndentedCodeBlocks: false,
  noHtmlBlocks: false,
  noHtmlSpans: false,
  tagFilter: false,
};

/**
 * An upper bound, in bytes, on the output `html()` writes for `source`. It throws once the bound exceeds
 * `limit`, so a source whose output would be larger is refused before any output string is built.
 */
export function markdownOutputBound(source: string, limit: number = OUTPUT_LIMIT): number {
  let bound = 0;
  const add = (units: number) => {
    bound += units;
    if (!Number.isSafeInteger(bound) || bound > limit) throw new Error("Markdown output limit");
  };
  // Raw inline HTML is copied from the source, and no callback sees it.
  add(bytes(source));
  // A hard break is a line ending (LF, CRLF or a lone CR) after two spaces or a backslash; it writes `<br />`
  // before the line ending. A CRLF is one line ending, counted at its CR.
  let breaks = 0;
  for (let at = 0; at < source.length; at++) {
    const char = source[at];
    if (char !== "\n" && char !== "\r") continue;
    if (char === "\n" && at > 0 && source[at - 1] === "\r") continue;
    if (at > 0 && (source[at - 1] === " " || source[at - 1] === "\\")) breaks++;
  }
  add(HARD_BREAK_BOUND * breaks);
  // A NUL is one byte in the source and U+FFFD (three bytes) in the output.
  let nuls = 0;
  for (let at = source.indexOf("\u0000"); at !== -1; at = source.indexOf("\u0000", at + 1)) nuls++;
  add(2 * nuls);

  // The dry run: every callback returns nothing, so no output string is built.
  const callbacks: Bun.markdown.RenderCallbacks = {
    text: (children) => {
      add(escapedBound(children));
      return "";
    },
    paragraph: () => {
      add(16);
      return "";
    },
    heading: () => {
      add(16);
      return "";
    },
    blockquote: () => {
      add(32);
      return "";
    },
    code: (children, meta) => {
      add(64 + escapedBound(children) + (meta?.language ? 6 * bytes(meta.language) : 0));
      return "";
    },
    list: (_children, meta) => {
      add(meta.start === undefined ? 16 : 48);
      return "";
    },
    listItem: (_children, meta) => {
      // A task item writes its checkbox and class (about 104 bytes).
      add(meta.checked === undefined ? 16 : 144);
      return "";
    },
    hr: () => {
      add(8);
      return "";
    },
    table: () => {
      add(24);
      return "";
    },
    thead: () => {
      add(24);
      return "";
    },
    tbody: () => {
      add(24);
      return "";
    },
    tr: () => {
      add(16);
      return "";
    },
    th: () => {
      add(32);
      return "";
    },
    td: () => {
      add(32);
      return "";
    },
    html: (children) => {
      add(bytes(children));
      return "";
    },
    strong: () => {
      add(24);
      return "";
    },
    emphasis: () => {
      add(16);
      return "";
    },
    strikethrough: () => {
      add(16);
      return "";
    },
    link: (_children, meta) => {
      // An href is written at most 6 bytes per byte: `&#x27;` for an apostrophe, `&amp;` for an ampersand, and
      // `%XX` (3) for other bytes. Entities decode before the URL is encoded, so the decoded bytes bound it.
      add(
        24 + 6 * bytes(meta.href) + (meta.title === undefined ? 0 : 10 + escapedBound(meta.title)),
      );
      return "";
    },
    image: (children, meta) => {
      add(
        48 +
          6 * bytes(meta.src) +
          escapedBound(children) +
          (meta.title === undefined ? 0 : 10 + escapedBound(meta.title)),
      );
      return "";
    },
    codespan: (children) => {
      add(16 + escapedBound(children));
      return "";
    },
  };
  Bun.markdown.render(source, callbacks, OPTIONS);
  return bound;
}

/** Renders Markdown to HTML, charging `budget` with the output bound (D112) before the output is built. */
export function renderMarkdown(source: string, budget: MarkdownBudget): string {
  // Checked before the parser sees the source: an expansion above the cap is refused at once (D112).
  if (bytes(source) > MARKDOWN_SOURCE_LIMIT) throw new MarkdownSourceError();
  budget.charge(markdownOutputBound(source));
  const output = Bun.markdown.html(source, OPTIONS);
  // The bound above is an upper bound on this output; the check is a guard, not a second limit.
  if (bytes(output) > OUTPUT_LIMIT) throw new Error("Markdown output limit");
  return output;
}
