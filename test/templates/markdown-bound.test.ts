// B106 r1 (D113): the output bound is an upper bound on what `html()` writes. Every escaped field is charged
// with the length Bun's escaper can reach: `'` becomes `&#x27;`, `&` becomes `&amp;`, and a URL is charged
// 6 bytes per byte. Each hard break is counted before LF, CRLF and a lone CR. A NUL is written as U+FFFD.
// A source whose real output is over the 1 MiB limit is refused before `html()` runs.
import { expect, test } from "bun:test";
import { createMarkdownBudget, markdownOutputBound, renderMarkdown } from "@/templates/markdown";

const markdown = Bun.markdown as { html: typeof Bun.markdown.html };
const LIMIT = 1024 * 1024;
const bytes = (value: string) => Buffer.byteLength(value, "utf8");

/** The real `html()` output, with no limit. */
const realOutput = (source: string) => markdown.html(source);
/** The bound, with no limit. */
const bound = (source: string) => markdownOutputBound(source, Number.MAX_SAFE_INTEGER);

/** What renderMarkdown does with a source: its refusal message, if any, and how often `html()` ran. */
function rendering(source: string): { refusal: string | null; htmlCalls: number } {
  const html = markdown.html;
  let htmlCalls = 0;
  markdown.html = (...args: Parameters<typeof html>) => {
    htmlCalls++;
    return html(...args);
  };
  let refusal: string | null = null;
  try {
    renderMarkdown(
      source,
      createMarkdownBudget(() => {}),
    );
  } catch (error) {
    refusal = (error as Error).message;
  } finally {
    markdown.html = html;
  }
  return { refusal, htmlCalls };
}

test("a 100-apostrophe reference URL used 2,800 times is refused by the bound before html() runs", () => {
  const source = `[r]: ${"'".repeat(100)}\n\n${"![][r] ".repeat(2800)}`;
  expect(bytes(realOutput(source))).toBeGreaterThan(LIMIT);
  expect(bound(source)).toBeGreaterThanOrEqual(bytes(realOutput(source)));
  expect(rendering(source)).toEqual({ refusal: "Markdown output limit", htmlCalls: 0 });
});

// Its real output is 1,034,007 bytes, under the limit, but its bound is over it: the bound refuses it before
// html() runs, as the reviewer requested.
test("a 100-ampersand reference URL used 2,000 times is refused by the bound before html() runs", () => {
  const source = `[r]: ${"&".repeat(100)}\n\n${"[a][r] ".repeat(2000)}`;
  expect(bytes(realOutput(source))).toBeLessThan(LIMIT);
  expect(bound(source)).toBeGreaterThanOrEqual(bytes(realOutput(source)));
  expect(rendering(source)).toEqual({ refusal: "Markdown output limit", htmlCalls: 0 });
});

test("hard breaks before CRLF are charged", () => {
  const source = "a  \r\n".repeat(26_000);
  expect(bound(source)).toBeGreaterThanOrEqual(bytes(realOutput(source)));
});

test("hard breaks before a lone CR are charged", () => {
  const source = "a  \r".repeat(26_000);
  expect(bound(source)).toBeGreaterThanOrEqual(bytes(realOutput(source)));
});

test("NUL is charged at U+FFFD's length", () => {
  const source = "\u0000".repeat(128 * 1024);
  expect(bound(source)).toBeGreaterThanOrEqual(bytes(realOutput(source)));
});

// The variants: each escaped character, repeated, as the URL, title and alt text of a link, an image and a
// reference definition, each used 1, 50 or 400 times. A title is single-quoted unless it is an apostrophe.
test("generated URL, title and alt variants built from the escaped characters stay under the bound", () => {
  const failures: Array<string> = [];
  let tested = 0;
  for (const c of ["'", '"', "&", "<", ">"]) {
    for (const n of [1, 2, 5, 20, 60]) {
      const run = c.repeat(n);
      const title = c === "'" ? `"${run}"` : `'${run}'`;
      const forms = [
        (i: number) => `[a${i}](${run})`,
        (i: number) => `[a${i}](${run} ${title})`,
        () => `![${run}](${run} ${title})`,
        () => `[${run}]`,
      ];
      const defined = `[r]: ${run} ${title}\n`;
      for (const uses of [1, 50, 400]) {
        for (const form of forms) {
          let source = "";
          for (let i = 0; i < uses; i++) {
            source += form(i) + "\n";
          }
          source += `\n${defined}`;
          for (let i = 0; i < uses; i++) {
            source += `![${run}][r] \n`;
          }
          if (bytes(source) > 128 * 1024) {
            continue;
          }
          tested++;
          const actual = bytes(realOutput(source));
          if (actual > bound(source)) {
            failures.push(`${c} n=${n} uses=${uses}: bound ${bound(source)} < actual ${actual}`);
          }
        }
      }
    }
  }
  expect(failures).toEqual([]);
  expect(tested).toBeGreaterThan(200);
});

test("a property test: generated URL, title and alt variants built from the escaped characters stay under the bound", () => {
  // Deterministic: the same documents every run (mulberry32).
  const seeded = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d_2b_79_f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  };
  const SPECIALS = ["'", '"', "&", "<", ">"];
  const ESCAPED = [...SPECIALS, "a", "&amp;", "&nGt;", "&#x27;", "\u0000", "ü", "😀"];
  const LINE_ENDINGS = ["\n", "  \n", "\\\n", "  \r\n", "  \r", "\r\n", "\r"];
  const failures: Array<string> = [];
  let tested = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const next = seeded(seed);
    const pick = (pool: Array<string>, n: number) => {
      let s = "";
      for (let i = 0; i < n; i++) {
        s += pool[Math.floor(next() * pool.length)]!;
      }
      return s;
    };
    const lines: Array<string> = [];
    const count = 2 + Math.floor(next() * 14);
    for (let i = 0; i < count; i++) {
      // Half the URLs are mostly the characters that expand (`'`, `&`, `"`, `<`, `>`), the expansion the bound must cover.
      const url =
        next() < 0.5
          ? pick(["'", "&"], 5 + Math.floor(next() * 35))
          : pick(ESCAPED, 1 + Math.floor(next() * 12));
      const title = pick(ESCAPED, 1 + Math.floor(next() * 6)).replaceAll('"', "'");
      const alt = pick(ESCAPED, 1 + Math.floor(next() * 6));
      const label = `r${i}`;
      switch (Math.floor(next() * 5)) {
        case 0:
          lines.push(`[${alt}](${url} "${title}")`);
          break;
        case 1:
          lines.push(`![${alt}](${url} '${title}')`);
          break;
        case 2:
          lines.push(`[${label}]: ${url} "${title}"`);
          break;
        case 3:
          lines.push(`![${alt}][${label}]`);
          break;
        default:
          lines.push(pick(ESCAPED, 1 + Math.floor(next() * 4)));
      }
    }
    // Each line is used many times: the reviewer's shapes are one definition used thousands of times, and a
    // per-use shortfall only shows then.
    let source = "";
    for (const line of lines) {
      const uses = 1 + Math.floor(next() * 400);
      for (let u = 0; u < uses; u++) {
        source += line + LINE_ENDINGS[Math.floor(next() * LINE_ENDINGS.length)]!;
      }
    }
    if (bytes(source) > 128 * 1024) {
      continue;
    }
    tested++;
    const actual = bytes(realOutput(source));
    if (actual > bound(source)) {
      failures.push(`seed ${seed}: bound ${bound(source)} < actual ${actual}`);
    }
  }
  expect(failures).toEqual([]);
  // Most documents are in range; a run that tested few could pass by accident.
  expect(tested).toBeGreaterThan(300);
});
