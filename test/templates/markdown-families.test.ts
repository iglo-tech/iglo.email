// B106 (D113): every pathological family and reviewer shape (test/templates/measure-markdown.ts) at 128 KiB
// renders or is refused within a second, and the output bound is at least the real `html()` output, also
// for a source that is refused. The bound is what the 1 MiB output limit is checked against.
import { expect, test } from "bun:test";
import { createMarkdownBudget, markdownOutputBound, renderMarkdown } from "@/templates/markdown";
import { families, source } from "@/test/templates/measure-markdown";
import { asBody } from "@/test/read-body";

test.each(Object.keys(families))(
  "the %s family at 128 KiB renders or is refused within a second",
  (family) => {
    const body = source(family, 128 * 1024);
    const started = performance.now();
    let refused: string | null = null;
    try {
      renderMarkdown(
        body,
        createMarkdownBudget(() => {}),
      );
    } catch (error) {
      refused = asBody<Error>(error).message;
    }
    expect(performance.now() - started).toBeLessThan(1000);
    if (refused !== null) {
      expect(refused).toBe("Markdown output limit");
    }
    const actual = Buffer.byteLength(Bun.markdown.html(body));
    expect(markdownOutputBound(body, Number.MAX_SAFE_INTEGER)).toBeGreaterThanOrEqual(actual);
  },
);

// B106 r1 (D113): the shapes the bound undercounted (the reviewer's apostrophe and ampersand reference URLs,
// CRLF and lone-CR hard breaks, NUL). The bound must be at least the real output for each.
const reviewerShapes: Record<string, string> = {
  "apostrophe reference URL used 2,800 times": `[r]: ${"'".repeat(100)}\n\n${"![][r] ".repeat(2800)}`,
  "ampersand reference URL used 2,000 times": `[r]: ${"&".repeat(100)}\n\n${"[a][r] ".repeat(2000)}`,
  "CRLF hard breaks": "a  \r\n".repeat(26_000),
  "lone CR hard breaks": "a  \r".repeat(26_000),
  NUL: "\u0000".repeat(128 * 1024),
};
test.each(Object.keys(reviewerShapes))("the bound holds for the %s shape", (shape) => {
  const body = reviewerShapes[shape]!;
  const actual = Buffer.byteLength(Bun.markdown.html(body));
  expect(markdownOutputBound(body, Number.MAX_SAFE_INTEGER)).toBeGreaterThanOrEqual(actual);
});

test("the output of the hr-run family is refused before the output is built", () => {
  // Its HTML is 1,048,587 bytes, over the 1 MiB limit; the bound is charged first and stops the render.
  const body = source("hr-run", 128 * 1024);
  expect(() =>
    renderMarkdown(
      body,
      createMarkdownBudget(() => {}),
    ),
  ).toThrow("Markdown output limit");
});
