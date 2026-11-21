// B120 r1 (D118): the converter's cases from the review, one test each. Each input is the reviewer's
// exact markup; the expected text is what a reader of the text part sees.
import { expect, test } from "bun:test";
import { plainText } from "@/messaging/plain";
import { createMessageBudget } from "@/templates/renderer";

const text = (html: string) => plainText(html, createMessageBudget());

// B1: character references in an href decode once. `&amp;` is the HTML form of `&`, and the URL
// a reader follows has the parameter separator, not `amp;`.
test("an href's character references decode once: &amp; reads as &, and &amp;amp; stays a literal &amp;", async () => {
  expect(
    await text(
      '<a href="https://app.example.test/verify?token=abc&amp;email=ada%40example.test">Verify</a>',
    ),
  ).toBe("Verify <https://app.example.test/verify?token=abc&email=ada%40example.test>");
  expect(await text('<a href="https://e.test/?a=1&amp;amp;b=2">Go</a>')).toBe(
    "Go <https://e.test/?a=1&amp;b=2>",
  );
});

test("a style's character references decode once, so display&#58;none hides its element", async () => {
  expect(await text('<span style="display&#58;none">secret</span>after')).toBe("after");
});

// B2: text outside any element is kept, and inline boundaries keep their whitespace.
test("text outside any element is kept around an inline element", async () => {
  expect(await text("Hello Ada, your code is <b>1234</b>. Thanks!")).toBe(
    "Hello Ada, your code is 1234. Thanks!",
  );
});

test("inline boundaries keep their whitespace: <b>Hello</b> <i>World</i> reads Hello World", async () => {
  expect(await text("<b>Hello</b> <i>World</i>")).toBe("Hello World");
});

test("a link in a fragment keeps the text around it", async () => {
  expect(await text('Reset here: <a href="https://x/r?t=1">reset</a> within 1 hour.')).toBe(
    "Reset here: reset <https://x/r?t=1> within 1 hour.",
  );
});

test("a fragment with no tags at all is the text", async () => {
  expect(await text("Plain words only")).toBe("Plain words only");
});

// B3: nested links are linear. Each nesting shape finishes in a bounded real time; the bound is
// generous, since the review measured 41.6 s for this input before the fix.
test("70k nested links convert within a generous real-time bound", async () => {
  const html = '<a href="x">'.repeat(70_000) + "t" + "</a>".repeat(70_000);
  const started = performance.now();
  const result = await text(html);
  const elapsed = performance.now() - started;
  expect(result).toContain("t");
  expect(elapsed).toBeLessThan(5_000);
});

test("70k nested blocks convert within a generous real-time bound", async () => {
  const html = "<div>".repeat(70_000) + "t" + "</div>".repeat(70_000);
  const started = performance.now();
  expect(await text(html)).toBe("t");
  expect(performance.now() - started).toBeLessThan(5_000);
});

// S1: a self-closing element in SVG or MathML does not fault the conversion.
test("self-closing SVG and MathML elements do not throw", async () => {
  for (const html of [
    "<svg><title/></svg>",
    '<svg style="display:none"/>',
    '<svg><a href="x"/></svg>',
    '<math><a href="x"/></math>',
    "<svg><title/>visible</svg>",
  ]) {
    expect(typeof (await text(html))).toBe("string");
  }
  expect(await text("<svg><title/>visible</svg>")).toBe("visible");
});

// S2: a hidden element whose end tag is implied (td, li, p) hides only its own content.
test("a hidden td with no end tag hides only its content: the next cell and the rows after show", async () => {
  const out = await text(
    '<table><tr><td style="display:none">x<td>visible cell</table><p>after</p>',
  );
  expect(out).toContain("visible cell");
  expect(out).toContain("after");
  expect(out).not.toContain("x");
});

test("a hidden li with no end tag hides only itself: the following items show", async () => {
  const out = await text('<ul><li style="display:none">h<li>v1<li>v2</ul>');
  expect(out).toContain("v1");
  expect(out).toContain("v2");
  expect(out).not.toContain("h");
});

test("a hidden p with no end tag hides only itself: the block that closes it shows", async () => {
  const out = await text('<p style="display:none">h<div>visible</div>');
  expect(out).toBe("visible");
});

// S4 / item 6: every conversion charges its own message budget.
test("the text is charged to the budget it was given, once", async () => {
  const budget = createMessageBudget();
  const out = await plainText("<p>Hello <b>there</b></p>", budget);
  expect(budget.bytes).toBe(Buffer.byteLength(out));
  const again = await plainText("<p>More</p>", budget);
  expect(budget.bytes).toBe(Buffer.byteLength(out) + Buffer.byteLength(again));
});

// Adopter follow-up (a): consecutive links that share an href write the URL once, and a link whose
// text is only a symbol is decoration with no URL of its own.
test("the adopter's row pattern, text <URL> → <URL>, reads text <URL>", async () => {
  expect(
    await text(
      '<p>Read the guide <a href="https://e.test/g">https://e.test/g</a> <a href="https://e.test/g">→</a></p>',
    ),
  ).toBe("Read the guide <https://e.test/g>");
});

test("consecutive links that share an href write the URL once", async () => {
  expect(await text('<a href="https://e.test/u">one</a> <a href="https://e.test/u">two</a>')).toBe(
    "one <https://e.test/u> two",
  );
});

test("a symbol-only link with its own URL is decoration: nothing is written", async () => {
  expect(await text('<p>Next <a href="https://e.test/v">›</a></p>')).toBe("Next");
});

// S7: a URL cannot end the <…> early or carry a space into the text part.
test("a URL's > and whitespace are percent-encoded in the text part", async () => {
  expect(await text('<a href="https://evil.x/a> see <https://bank.x">Click</a>')).toBe(
    "Click <https://evil.x/a%3E%20see%20%3Chttps://bank.x>",
  );
});
