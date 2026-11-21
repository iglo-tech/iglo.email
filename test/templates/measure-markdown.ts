// Markdown measurement helper (B106; not a CI test). Times the Markdown renderer, checks its output bound,
// and compares its output with listmonk's goldmark (test/templates/goldmark, run by hand).
//   bun test/templates/measure-markdown.ts families <KiB>      every family and reviewer shape at <KiB>, one child per case
//   bun test/templates/measure-markdown.ts one <family> <KiB>  one case (the child of `families`)
//   bun test/templates/measure-markdown.ts corpus <out.json>   the comparison corpus, for goldmark's `listmonk` mode
//   bun test/templates/measure-markdown.ts compare <gm.json>   our output against goldmark's on that corpus
import { createMarkdownBudget, markdownOutputBound, renderMarkdown } from "@/templates/markdown";
import { markdownCorpus } from "@/test/templates/markdown-corpus";
import { newsletter } from "@/test/templates/markdown-newsletter";

/** Families [unit, prefix]: the prefix is written once, then the unit repeats to the requested size. */
export const families: Record<string, [string, string]> = {
  "link-empty": ["[](", ""],
  "link-open": ["[x](", ""],
  "link-href": ["[x](y", ""],
  "link-title": ['[x](y "', ""],
  "link-title-single": ["[x](y '", ""],
  "link-angle": ["[x](<", ""],
  "link-spaced": ["[x]( ", ""],
  "link-glued-quote": ['[x](y"', ""],
  "link-glued-paren": ["[x](y(", ""],
  "image-empty": ["![](", ""],
  "bracket-open": ["[", ""],
  "bracket-nested": ["[a [b ", ""],
  "bracket-close": ["](", ""],
  "reflink-open": ["[x][", ""],
  "reflink-empty": ["[x][]", ""],
  "reflink-defined": ["[x][r]", ""],
  "reflink-def": ["[r]: /u\n", ""],
  "emphasis-star": ["*", ""],
  "emphasis-under": ["_", ""],
  "emphasis-pairs": ["*a ", ""],
  "emphasis-under-pairs": ["_a ", ""],
  "strong-open": ["**a ", ""],
  backtick: ["`", ""],
  "backtick-run": ["`a ", ""],
  "autolink-open": ["<", ""],
  "autolink-tag": ["<a ", ""],
  "autolink-url": ["<http://x ", ""],
  "autolink-mail": ["<a@b ", ""],
  "html-comment": ["<!-- ", ""],
  "html-tag": ["<span ", ""],
  escape: [String.raw`\[`, ""],
  "paren-open": ["(", ""],
  "link-valid": ["[a](b) ", ""],
  "table-row": ["|a|\n", ""],
  blockquote: ["> [", ""],
  "list-link": ["- [x](", ""],
  "block-pipe": ["|\n-\n", ""],
  "block-pipe-space": [" |\n-\n", ""],
  "block-pipe-dashes": ["|\n--\n", ""],
  "block-pipes": ["||\n-\n", ""],
  "block-pipe-colon": ["|:\n-\n", ""],
  "block-angle": ["<\n-\n", ""],
  "block-backtick": ["`\n-\n", ""],
  "block-bracket": ["[\n-\n", ""],
  "block-underscore": ["_\n-\n", ""],
  "block-bang": ["!\n-\n", ""],
  "block-backslash": ["\\\n-\n", ""],
  "block-a-dashes": ["a\n--\n", ""],
  "block-dashes": ["--\n", ""],
  "block-newline-dashes": ["\n--", ""],
  "block-dash-dash": ["-\n-", ""],
  "block-rule-run": ["a\n***\n", ""],
  "reflink-escape": [String.raw`\[`, "[a]: /u\n\n"],
  "emphasis-run": ["__+", ""],
  "tilde-run": ["w ~", ""],
  "table-row-run": ["|a|\n", ""],
  // Reviewer shapes (B105 r2/r3): a paragraph followed by whitespace-only lines, and `~` runs.
  "ws-tail-tab": ["\t        \n", "x\n"],
  "ws-tail-two": ["  \n", "x\n"],
  "ws-tail-one": [" \n", "x\n"],
  "tilde-tail": ["~", "x\n"],
  "quote-tilde": ["~", "> x\n> "],
  "table-tilde": ["~", "| a |\n|---|\n"],
  "list-tilde": ["~", "- x\n"],
  "hr-run": ["* *\n", ""],
};

export function source(family: string, bytes: number): string {
  const entry = families[family];
  if (!entry) {
    throw new Error(`unknown family ${family}`);
  }
  const [unit, prefix] = entry;
  const body = unit.repeat(Math.ceil((bytes - prefix.length) / unit.length));
  return (prefix + body).slice(0, bytes);
}

const utf8 = (value: string) => Buffer.byteLength(value, "utf8");

/**
 * One render: its time and outcome, the output bound with no limit, and the real `html()` size with no
 * limit. The bound must be at least the real size, also for a source that is refused.
 */
function timed(body: string) {
  const started = performance.now();
  let status = "ok";
  try {
    renderMarkdown(
      body,
      createMarkdownBudget(() => {}),
    );
  } catch (error) {
    status = `error: ${(error as Error).message}`;
  }
  const ms = performance.now() - started;
  return {
    ms,
    status,
    bound: markdownOutputBound(body, Number.MAX_SAFE_INTEGER),
    actual: utf8(Bun.markdown.html(body)),
  };
}

// Canonical form for comparing two renderers (goldmark's typographer, heading ids, self-closing tags,
// attribute order and checkbox markup folded away). Approximate, and applied to both sides of every comparison.
const TYPO: Array<[RegExp, string]> = [
  [/&amp;/g, "&"],
  [/&quot;/g, '"'],
  [/&#0*39;|&#x0*27;|&apos;|&rsquo;|&lsquo;|’|‘/gi, "'"],
  [/&ldquo;|&rdquo;|“|”/g, '"'],
  [/&ndash;|–/g, "--"],
  [/&mdash;|—/g, "---"],
  [/&hellip;|…/g, "..."],
  [/&copy;|©/g, "(c)"],
  [/&reg;|®/g, "(r)"],
  [/&trade;|™/g, "(tm)"],
  [/&laquo;|«/g, "<<"],
  [/&raquo;|»/g, ">>"],
  [/&plusmn;|±/g, "+-"],
  [/&frac12;|½/g, "1/2"],
];
const CHECKBOX = /<input\b[^>]*>/g;
const TAG =
  /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function normTag(_: string, name: string, attrs: string): string {
  const pairs: Array<string> = [];
  for (const m of attrs.matchAll(ATTR)) {
    pairs.push(`${m[1]!.toLowerCase()}="${m[2] ?? m[3] ?? m[4] ?? ""}"`);
  }
  pairs.sort();
  return `<${name.toLowerCase()}${pairs.length ? " " + pairs.join(" ") : ""}>`;
}

export function canon(html: string): string {
  let s = html;
  for (const [re, rep] of TYPO) {
    s = s.replace(re, rep);
  }
  s = s.replaceAll(/<h([1-6])\s+id="[^"]*"/g, "<h$1");
  s = s.replaceAll(/ class="task-list-item[^"]*"/g, "");
  s = s.replaceAll(/ style="text-align:(\w+)"/g, ' align="$1"');
  s = s.replaceAll(/<(\/?)(s|strike)>/g, "<$1del>");
  s = s.replaceAll(CHECKBOX, (tag) => (/\bchecked\b/.test(tag) ? "[x]" : "[ ]"));
  s = s.replaceAll(/\[( |x)\]\s*/g, "[$1]");
  s = s.replaceAll(TAG, normTag);
  s = s.replaceAll(/\s+/g, " ").replaceAll("> <", "><").trim();
  return s.replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

// The random corpus: seeded documents of up to 4 KiB, each joining 3 to 40 fragments.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const FRAGMENTS = [
  "# Title",
  "## Sub [x](https://e.test/a)",
  "Plain text here.",
  "**bold** and *em* and _u_ and __s__",
  "`code` and ``a`b``",
  "```\ncode\n```",
  "    indented",
  "- item",
  "* star",
  "1. one",
  "2) two",
  "> quote",
  ">- nested",
  "| a | b |",
  "|---|:-:|",
  "| 1 | 2 |",
  '[ref]: https://r.test "T"',
  "[ref][]",
  "[t](https://t.test 'x')",
  "![img](/i.png)",
  '<span class="x">h</span>',
  "<div>\nblock\n</div>",
  "<!-- c -->",
  "https://bare.test",
  "<https://auto.test>",
  "~~gone~~",
  "~tilde~",
  "~~~",
  "***",
  "---",
  "===",
  "- [ ] task",
  "- [x] done",
  String.raw`\*esc\*`,
  "a  \nb",
  "a\\\nb",
  "&amp; &copy; &#35;",
  "ünï 😀",
  "!",
  "[",
  "]",
  "(",
  ")",
  "~",
  "`",
  "*",
  "_",
  "|",
  "<",
  ">",
  "+ plus",
  "Hi {x}!",
  "100% sure...",
  'Don\'t "quote" -- dash',
  "1/2 +- ±",
  "(c) (r)",
  "",
  "  indented text",
  "# H1 #",
  "Setext\n===",
  "Sub\n---",
  "[a]: <x y>",
  "[b]: /z 'title'",
  "text [a] and [b]",
  "line ending with ~",
  "- x\n\n  para",
  "\t tab",
  '[x](u"a b")',
  '[x](<u>"t")',
  "```\n~~~",
  "1. a\n\n   b\n\n2. c",
];
const SEPARATORS = ["\n", "\n\n", "  \n", "\n\n\n"];
function randomDocument(seed: number): string {
  const next = rng(seed);
  const count = 3 + Math.floor(next() * 38);
  let s = "";
  for (let i = 0; i < count && s.length < 4096; i++) {
    s += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]!;
    s += SEPARATORS[Math.floor(next() * SEPARATORS.length)]!;
  }
  return s.slice(0, 4096);
}

// Ordinary line lists (the r3 reviewer's 7-20 KiB shapes, rebuilt from the review text).
const lineLists: Record<string, (i: number) => string> = {
  "big-news": (i) => `Big news for member ${i}! Don't miss it!\n`,
  routes: (i) => `Route ${i}: ~6 min drive, ~2 km from the station  \n`,
  panels: (i) => `[Panel ${i}] Read the update about item ${i} [more]\n`,
  backtick: (i) => `Step ${i} ends with a backtick \`\n`,
  "tilde-lines": (i) => `Offer ${i} ends with ~\n`,
  "hi-lines": (i) => `Hi member ${i}! \n`,
};
function lines(make: (i: number) => string, bytes: number): string {
  let s = "";
  for (let i = 1; s.length < bytes; i++) {
    s += make(i);
  }
  return s.slice(0, bytes);
}

if (Bun.argv[2] === "one") {
  console.log(JSON.stringify(timed(source(Bun.argv[3]!, Number(Bun.argv[4]) * 1024))));
} else if (Bun.argv[2] === "families") {
  const kib = Number(Bun.argv[3] ?? 128);
  let slowest = 0;
  let over100 = 0;
  let timeouts = 0;
  let refused = 0;
  let violations = 0;
  for (const family of Object.keys(families)) {
    const child = Bun.spawn([process.execPath, import.meta.path, "one", family, String(kib)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    const out = await new Response(child.stdout).text();
    await child.exited;
    clearTimeout(timer);
    if (child.signalCode !== null) {
      timeouts++;
      console.log(`${family.padEnd(22)} TIMEOUT > 10000 ms`);
      continue;
    }
    const r = JSON.parse(out.trim()) as {
      ms: number;
      status: string;
      bound: number;
      actual: number;
    };
    slowest = Math.max(slowest, r.ms);
    if (r.ms > 100) {
      over100++;
    }
    if (r.status !== "ok") {
      refused++;
    }
    if (r.actual > r.bound) {
      violations++;
    }
    console.log(
      `${family.padEnd(22)} ${r.ms.toFixed(1).padStart(8)} ms  bound ${String(r.bound).padStart(8)} B  html ${String(r.actual).padStart(8)} B  ${r.status}`,
    );
  }
  console.log(
    `SUMMARY ${kib} KiB: slowest ${slowest.toFixed(1)} ms, over 100 ms ${over100}, timeouts ${timeouts}, refused ${refused}, bound violations ${violations}`,
  );
} else if (Bun.argv[2] === "corpus") {
  // Pins, newsletters, ordinary line lists, families at 1 KiB and 2000 random documents.
  const docs: Array<{ id: string; src: string }> = [];
  markdownCorpus.forEach((src, i) => docs.push({ id: `pin-${i + 1}`, src }));
  for (const kib of [4, 16, 64]) {
    docs.push({ id: `nl-${kib}`, src: newsletter(kib).source });
  }
  for (const [name, make] of Object.entries(lineLists)) {
    for (const kib of [7, 13, 20]) {
      docs.push({ id: `list-${name}-${kib}`, src: lines(make, kib * 1024) });
    }
  }
  for (const name of Object.keys(families)) {
    docs.push({ id: `fam-${name}`, src: source(name, 1024) });
  }
  for (let seed = 1; seed <= 2000; seed++) {
    docs.push({ id: `rand-${seed}`, src: randomDocument(seed) });
  }
  await Bun.write(Bun.argv[3]!, JSON.stringify(docs));
  console.log(`wrote ${docs.length} documents`);
} else if (Bun.argv[2] === "compare") {
  const gm = new Map<string, string>(
    (JSON.parse(await Bun.file(Bun.argv[3]!).text()) as Array<{ id: string; html: string }>).map(
      (r) => [r.id, r.html],
    ),
  );
  const corpus: Array<{ id: string; src: string }> = [];
  markdownCorpus.forEach((src, i) => corpus.push({ id: `pin-${i + 1}`, src }));
  for (const kib of [4, 16, 64]) {
    corpus.push({ id: `nl-${kib}`, src: newsletter(kib).source });
  }
  for (const [name, make] of Object.entries(lineLists)) {
    for (const kib of [7, 13, 20]) {
      corpus.push({ id: `list-${name}-${kib}`, src: lines(make, kib * 1024) });
    }
  }
  for (const name of Object.keys(families)) {
    corpus.push({ id: `fam-${name}`, src: source(name, 1024) });
  }
  for (let seed = 1; seed <= 2000; seed++) {
    corpus.push({ id: `rand-${seed}`, src: randomDocument(seed) });
  }
  const groups: Record<
    string,
    { docs: number; refused: number; differs: number; boundViolations: number }
  > = {};
  for (const doc of corpus) {
    const group = doc.id.split("-")[0]!;
    groups[group] ??= { docs: 0, refused: 0, differs: 0, boundViolations: 0 };
    const g = groups[group];
    g.docs++;
    const r = timed(doc.src);
    if (r.status !== "ok") {
      g.refused++;
    }
    if (r.actual > r.bound) {
      g.boundViolations++;
    }
    const reference = gm.get(doc.id);
    // The helper's output is Bun's html() with its defaults, which are listmonk's options (renderer).
    if (
      r.status === "ok" &&
      reference !== undefined &&
      canon(Bun.markdown.html(doc.src)) !== canon(reference)
    ) {
      g.differs++;
      if (g.differs <= 3) {
        console.log(`differs ${doc.id}: ${JSON.stringify(doc.src.slice(0, 120))}`);
      }
    }
  }
  console.log(JSON.stringify(groups, null, 1));
} else if (import.meta.main && Bun.argv[2] === undefined) {
  console.log("usage: families <KiB> | one <family> <KiB> | corpus <out.json> | compare <gm.json>");
}
