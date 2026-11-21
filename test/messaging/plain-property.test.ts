// B120 (D118): the generated text part is never longer than its HTML. A seeded random corpus of
// markup, character references, invisible characters and malformed nesting checks the bound on every
// run, so a regression fails the same inputs each time.
import { expect, test } from "bun:test";
import { plainText } from "@/messaging/plain";
import { createMessageBudget } from "@/templates/renderer";

const PIECES = [
  "<li>x</li>",
  "<li>",
  "<td> </td>",
  "<td>",
  "<br>",
  "<p>",
  "</p>",
  "<div>",
  "</div>",
  "&#x1F600;",
  "&#8203;",
  "&nbsp;",
  "&amp;",
  "&eacute;",
  "&#0;",
  "&#xD800;",
  "&#99999999;",
  '<a href="https://e.x/a">https://e.x/a</a>',
  '<a href="x"></a>',
  '<a href="#">y</a>',
  '<a href="javascript:void(0)">z</a>',
  '<a href="https://very.long.example.test/path?q=1&amp;r=2">t</a>',
  '<span style="display:none">h</span>',
  '<img src="i">',
  " ",
  "\n",
  "  ",
  "͏​",
  "word",
  "é",
  "😀",
  "<title>t</title>",
  "<style>p{}</style>",
  "<!-- c -->",
  "<tr>",
  "<table>",
  "<h2>",
  "</h2>",
  "<ul>",
  "<ol>",
  "<a href=x>",
  "</a>",
  "&unknown;",
  "&;",
  "&#;",
  "&#x;",
];

/** A linear congruential generator with a fixed seed: the corpus is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
    return state / 0x80_00_00_00;
  };
}

test("the text part is never longer than its HTML, in bytes or code units, over a seeded corpus", async () => {
  const random = seeded(20_261_120);
  for (let trial = 0; trial < 500; trial++) {
    const count = 1 + Math.floor(random() * 300);
    let html = "";
    for (let i = 0; i < count; i++) {
      html += PIECES[Math.floor(random() * PIECES.length)];
    }
    const text = await plainText(html, createMessageBudget());
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(Buffer.byteLength(html));
    expect(text.length).toBeLessThanOrEqual(html.length);
  }
});
