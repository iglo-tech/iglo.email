// B120 r1 (D118): the converter's cases from the review, one test each. Each input is the reviewer's
// exact markup; the expected text is what a reader of the text part sees.
import { expect, test } from "bun:test";
import { plainText } from "@/messaging/plain";
import { createMessageBudget } from "@/templates/renderer";

const time = async (n: number) => {
  const html = nested.b(n);
  const samples: Array<number> = [];
  for (let run = 0; run < 3; run++) {
    const started = performance.now();
    await text(html);
    samples.push(performance.now() - started);
  }
  return samples.sort((a, b) => a - b)[1]!;
};

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
  // Past the 1024 cap on open elements (D118 r4), the message has no text part.
  expect(result).toBe("");
  expect(elapsed).toBeLessThan(5000);
});

test("70k nested blocks convert within a generous real-time bound", async () => {
  const html = "<div>".repeat(70_000) + "t" + "</div>".repeat(70_000);
  const started = performance.now();
  expect(await text(html)).toBe("");
  expect(performance.now() - started).toBeLessThan(5000);
});

// r4: every open element counts toward the cap, so nesting within it keeps its text.
test("nesting within the cap keeps its text: 200 nested <b> round-trip to t", async () => {
  expect(await text("<b>".repeat(200) + "t" + "</b>".repeat(200))).toBe("t");
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

// r2 B2: a symbol-only link is empty text. Its URL is written unless a same-href neighbour already
// wrote it, so a reader can still act on a link whose only text is a symbol.
test("a symbol-only link keeps its URL: See the new pricing → reads with its URL", async () => {
  expect(await text('<p>See the new pricing <a href="https://x/pricing">→</a></p>')).toBe(
    "See the new pricing <https://x/pricing>",
  );
});

test("symbol-only feedback links with different hrefs keep both URLs", async () => {
  expect(
    await text(
      '<p>Was this helpful? <a href="https://x/fb?v=up">👍</a> <a href="https://x/fb?v=down">👎</a></p>',
    ),
  ).toBe("Was this helpful? <https://x/fb?v=up> <https://x/fb?v=down>");
});

test("symbol-only rating links keep their URLs", async () => {
  expect(
    await text('<p>Rate: <a href="https://x/r?s=1">★</a><a href="https://x/r?s=2">★★</a></p>'),
  ).toBe("Rate: <https://x/r?s=1> <https://x/r?s=2>");
});

// r2 S1: an attribute reference without `;` is a legacy name, and a browser leaves it literal when
// `=` or a letter or digit follows it. A name that is not legacy stays literal.
test("a legacy name without ; followed by = stays literal in an href", async () => {
  expect(await text('<a href="https://x.example/?id=1&sect=news">news</a>')).toBe(
    "news <https://x.example/?id=1&sect=news>",
  );
  expect(await text('<a href="https://x.example/?id=1&reg=eu&copy=2">eu</a>')).toBe(
    "eu <https://x.example/?id=1&reg=eu&copy=2>",
  );
  expect(await text('<a href="https://x.example/?a=1&region=eu">eu</a>')).toBe(
    "eu <https://x.example/?a=1&region=eu>",
  );
});

// r2 nits: text decodes as a browser does. A legacy name without `;` decodes, a longer name that is
// not legacy does not, and a C1 numeric reference maps to Windows-1252.
test("text references decode as a browser does: &copy2026 is ©2026, &bull x stays literal", async () => {
  expect(await text("<p>Copyright &copy2026</p>")).toBe("Copyright ©2026");
  expect(await text("<p>a &bull x</p>")).toBe("a &bull x");
  expect(await text("<p>a&#150;b</p>")).toBe("a–b");
});

// r2 S3: center is a block.
test("center is a block: two centred lines are two lines, and same-href links keep their URLs", async () => {
  expect(await text("<center>One</center><center>Two</center>")).toBe("One\n\nTwo");
  expect(
    await text(
      '<center><a href="https://x/p">One</a></center><center><a href="https://x/p">Two</a></center>',
    ),
  ).toBe("One <https://x/p>\n\nTwo <https://x/p>");
});

// r2 S2: a head with no end tag ends at the body, so the body still converts.
test("an open head with no </head> ends at the body, and the body converts", async () => {
  expect(await text('<html><head><meta charset="utf-8"><title>T</title><body><p>Hello</p>')).toBe(
    "Hello",
  );
});

// r2 S4 and item 6: a link to a non-navigable scheme keeps its text and writes no URL.
test("data:, vbscript: and javascript: links keep their text and write no URL, however they are encoded", async () => {
  expect(await text('<a href="data:text/html,%3Cscript%3E">Open</a>')).toBe("Open");
  expect(await text('<a href="vbscript:msgbox">Run</a>')).toBe("Run");
  expect(await text('<a href="java&#9;script:alert(1)">Go</a>')).toBe("Go");
  expect(await text('<a href="&#1;javascript:alert(1)">Go</a>')).toBe("Go");
});

// r2 B1: nesting of each kind converts within a tight real-time bound, and its cost grows with the
// input, not with its square. The cap on pending end-tag handlers is what bounds it (D118).
const MIB = 1024 * 1024;
const nested = {
  b: (n: number) => "<b>".repeat(n) + "t" + "</b>".repeat(n),
  div: (n: number) => "<div>".repeat(n) + "t" + "</div>".repeat(n),
  a: (n: number) => '<a href="x">'.repeat(n) + "t" + "</a>".repeat(n),
  li: (n: number) => "<ul><li>".repeat(n) + "t" + "</li></ul>".repeat(n),
  td: (n: number) => "<table><tr><td>".repeat(n) + "t" + "</td></tr></table>".repeat(n),
};
const bytesPerLevel: Record<keyof typeof nested, number> = {
  b: 7,
  div: 11,
  a: 16,
  li: 18,
  td: 34,
};
for (const kind of Object.keys(nested) as Array<keyof typeof nested>) {
  test(`1 MiB of nested ${kind} is under 1 s, and past the 1024 cap it has no text part`, async () => {
    const html = nested[kind](Math.floor(MIB / bytesPerLevel[kind]));
    const started = performance.now();
    expect(await text(html)).toBe("");
    expect(performance.now() - started).toBeLessThan(1000);
  });
}

test("quadrupling nested <b> input costs at most about 6x: the cost is not the square", async () => {
  const small = await time(Math.floor(MIB / 4 / 7));
  const large = await time(Math.floor(MIB / 7));
  expect(large / Math.max(small, 1)).toBeLessThan(6);
});

// S7: a URL cannot end the <…> early or carry a space into the text part.
test("a URL's > and whitespace are percent-encoded in the text part", async () => {
  expect(await text('<a href="https://evil.x/a> see <https://bank.x">Click</a>')).toBe(
    "Click <https://evil.x/a%3E%20see%20%3Chttps://bank.x>",
  );
});

// r3 B1: implied end tags leave the rewriter's end-tag handlers pending, so the cost grows with the
// number of implied ends, not with the stack. Each shape repeats a unit with an omitted end tag. The
// conversion gives up once it holds more handlers than its cap (D118), so the bound is on time, and
// past the cap the message has no text part.
const implied: Record<string, { unit: string; bytes: number }> = {
  "unclosed p": { unit: "<p>x<b>y</b>", bytes: 12 },
  "unclosed li": { unit: "<li>x<b>y</b>", bytes: 13 },
  "unclosed td": { unit: "<td>x<b>y</b>", bytes: 13 },
  "unclosed tr cell": { unit: "<tr><td>x<b>y</b>", bytes: 17 },
  "unclosed dd": { unit: "<dd>x<b>y</b>", bytes: 13 },
  "unclosed option": { unit: "<option>x<b>y</b>", bytes: 17 },
  // r4 (the stray end tag): each </q> searches every open element, so open spans and a stack of divs
  // closed by a stray end tag are timed the same way as the implied ends above.
  "unclosed span with stray end tags": { unit: "<span>x</q>", bytes: 11 },
  "div stack then stray end tags": { unit: "<p>x</q>", bytes: 8 },
};
const prefix: Record<string, string> = {
  "unclosed p": "",
  "unclosed li": "<ul>",
  "unclosed td": "<table><tr>",
  "unclosed tr cell": "<table>",
  "unclosed dd": "<dl>",
  "unclosed option": "<select>",
  "unclosed span with stray end tags": "",
  "div stack then stray end tags": "<div>".repeat(256),
};
for (const kind of Object.keys(implied)) {
  test(`${kind} at 256 KiB and 1 MiB: 4x the input costs at most 5x the time, and 1 MiB is under 1 s`, async () => {
    const { unit, bytes } = implied[kind]!;
    const build = (size: number) => prefix[kind]! + unit.repeat(Math.floor(size / bytes));
    const time = async (size: number) => {
      const samples: Array<number> = [];
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        await text(build(size));
        samples.push(performance.now() - started);
      }
      return samples.sort((a, b) => a - b)[1]!;
    };
    const small = await time(256 * 1024);
    const large = await time(MIB);
    expect(large / Math.max(small, 5)).toBeLessThanOrEqual(5);
    expect(large).toBeLessThan(1000);
  });
}

// r4: the worst case the cap still allows: 1023 open elements, then stray end tags, each of which
// searches the open elements. It was one absolute sample under 1 s, which failed at 1006-1181 ms on a
// loaded host (B137). It is now a ratio within the run, the median of three at 64 KiB and at 1 MiB.
// Linear work gives about 16x for 16x the input (measured 14-18x on macOS and 14-15x in the Linux
// container); quadratic work gives 256x. The bound of 32x sits between the two.
const worstStrayEnds = (size: number) =>
  "<span>".repeat(1023) + "x</q>".repeat(Math.floor(size / 5));
const worstStrayEndsTime = async (size: number) => {
  const samples: Array<number> = [];
  for (let run = 0; run < 3; run++) {
    const started = performance.now();
    await text(worstStrayEnds(size));
    samples.push(performance.now() - started);
  }
  return samples.sort((a, b) => a - b)[1]!;
};
test("the worst linear case, 1023 open spans then stray end tags, costs at most 32x for 16x the input", async () => {
  const small = await worstStrayEndsTime(64 * 1024);
  const large = await worstStrayEndsTime(1024 * 1024);
  expect(large / Math.max(small, 5)).toBeLessThanOrEqual(32);
});

test("a message past the implied-end cap gives no text part, and its HTML is still converted by the caller", async () => {
  expect(await text("<p>x".repeat(4000))).toBe("");
});

// r3 leftovers: an entity-encoded scheme separator is a scheme separator (the rewriter returns the
// attribute as written, so the decoder must know the name), and a select keeps its options apart.
test("an entity-encoded scheme separator is dropped like javascript:", async () => {
  expect(await text('<a href="javascript&colon;alert(1)">Go</a>')).toBe("Go");
  expect(await text('<a href="javascript&Tab;:alert(1)">Go</a>')).toBe("Go");
});

test("an option list stays apart from the text after it: a, b and after are separate words", async () => {
  const out = await text("<select><option>a<option>b</select>after");
  expect(out).toMatch(/a\s+b\s+after/);
  expect(out).not.toContain("abafter");
});
