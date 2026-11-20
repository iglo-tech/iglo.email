// B106 (D113): every pathological family and reviewer shape (test/templates/measure-markdown.ts) at 128 KiB
// renders or is refused within a second, and the output bound is at least the real `html()` output, also
// for a source that is refused. The bound is what the 1 MiB output limit is checked against.
import { expect, test } from "bun:test";
import { createMarkdownBudget, markdownOutputBound, renderMarkdown } from "@/templates/markdown";
import { families, source } from "@/test/templates/measure-markdown";

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
      refused = (error as Error).message;
    }
    expect(performance.now() - started).toBeLessThan(1000);
    if (refused !== null) expect(refused).toBe("Markdown output limit");
    const actual = Buffer.byteLength(Bun.markdown.html(body));
    expect(markdownOutputBound(body, Number.MAX_SAFE_INTEGER)).toBeGreaterThanOrEqual(actual);
  },
);

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
