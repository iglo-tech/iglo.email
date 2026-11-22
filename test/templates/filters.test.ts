// The bounded Liquid filters of B135 (docs/design/06-templates.md, D23, D54, D134), observed through
// POST /api/tx into the loopback SMTP sink.
import { afterEach, expect, test } from "bun:test";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";
import { createRenderer } from "@/templates/renderer";
import { txFixture } from "@/test/tx/fixture";
import type { JsonObject } from "@/test/json-object";
import type { TxFixture } from "@/test/tx/fixture";
import { asBody } from "@/test/read-body";

const fixtures: Array<TxFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open() {
  const f = await txFixture();
  fixtures.push(f);
  return f;
}

/** Send `body` to a fresh address; the message text is decoded from quoted-printable. */
async function render(f: TxFixture, body: string, data: JsonObject = {}) {
  const template = await f.template(`<p>${body}</p>`);
  const email = `f-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const response = await f.tx({ subscriber_emails: [email], template_id: template, data });
  const row = response.body?.data?.sends?.[0];
  const raw = f.mailTo(email)[0]?.data ?? "";
  const at = raw.indexOf("\r\n\r\n");
  // The quoted-printable bytes are UTF-8: decode them as bytes, then as text.
  const bytes = raw
    .slice(at + 4)
    .replaceAll("=\r\n", "")
    .replaceAll(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  const message = Buffer.from(bytes, "latin1").toString("utf-8");
  return { http: response.status, status: asBody<string | undefined>(row?.status), message };
}

test("size counts a string's characters, an array's items and a plain object's keys", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ data.s | size }}] [{{ data.e | size }}] [{{ data.a | size }}] [{{ data.n | size }}] " +
      "[{{ data.o | size }}] [{{ data.none | size }}] [{{ data.num | size }}] [{{ data.t | size }}]",
    {
      s: "héllo",
      e: "",
      a: [1, "x", null],
      n: [],
      o: { a: 1, b: { c: 2 }, d: [] },
      num: 12_345,
      t: true,
    },
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[5] [0] [3] [0] [3] [0] [0] [0]");
});

test("size of an astral character is two, as JavaScript counts a string's length", async () => {
  const f = await open();
  const sent = await render(f, "[{{ data.s | size }}] [{{ '😀' | size }}]", { s: "😀a" });
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[3] [2]");
});

test("size of a loop's pair counts its two items, and size nests inside a loop", async () => {
  const f = await open();
  const sent = await render(
    f,
    "{% for row in data.rows %}[{{ row | size }}:{{ row[0] | size }}]{% endfor %}",
    { rows: [["ab", "c"]] },
  );
  // The row is an array of two items; its first item is a string of two characters.
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[2:2]");
});

test("a number above 2^53 prints as the nearest double, and a string prints exactly", () => {
  // The raw JSON text is the input: a JavaScript number has already rounded before a fixture sends it.
  const renderer = createRenderer(createRealClock(), createTranslation());
  const out = renderer.renderSync({
    body: "[{{ data.n }}] [{{ data.s }}]",
    mode: "plain",
    data: '{"data":{"n":9007199254740993,"s":"9007199254740993"}}',
  });
  expect(out.body).toBe("[9007199254740992] [9007199254740993]");
});

test("json escapes its quotes in HTML unless piped through raw", async () => {
  const f = await open();
  const sent = await render(f, "[{{ data.obj | json }}] [{{ data.obj | json | raw }}]", {
    obj: { a: 1, b: [true, null, "x<y"] },
  });
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain(
    '[{&#34;a&#34;:1,&#34;b&#34;:[true,null,&#34;x&lt;y&#34;]}] [{"a":1,"b":[true,null,"x<y"]}]',
  );
});

test("json of nil, numbers, escaped strings and empty values is their JSON text", async () => {
  const f = await open();
  const text = 'a"b\\c\nd\u0001e😀';
  const sent = await render(
    f,
    "[{{ data.missing | json }}] [{{ data.n | json | raw }}] [{{ data.s | json | raw }}] " +
      "[{{ data.e | json | raw }}] [{{ data.x | json | raw }}] [{{ data.f | json | raw }}]",
    { n: 1.5, s: text, e: {}, x: [], f: false },
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain(`[null] [1.5] [${JSON.stringify(text)}] [{}] [[]] [false]`);
});

test("json prints a loop's pair as its JSON array", async () => {
  const f = await open();
  const sent = await render(f, "{% for kv in data.obj %}{{ kv | json | raw }};{% endfor %}", {
    obj: { a: 1, b: "x" },
  });
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain('["a",1];["b","x"];');
});

test("json charges the emission budget before it builds the text", async () => {
  const f = await open();
  // 80 texts of 60 KB are 4.8 MB, over the 4 MiB emission budget (D54). `assign` keeps them out of
  // the output, so the budget, not the 1 MiB output limit, is what refuses the 70th.
  const sent = await render(
    f,
    "{% for i in (1..80) %}{% assign t = data.big | json %}{% endfor %}ok",
    { big: "x".repeat(60_000) },
  );
  expect(sent.http).toBe(400);
});

test("json walks its value within the work budget", async () => {
  const f = await open();
  const obj = Object.fromEntries(Array.from({ length: 1000 }, (_, n) => [`k${n}`, n]));
  const sent = await render(f, "{% for i in (1..20) %}{{ data.obj | json | size }}{% endfor %}", {
    obj,
  });
  // 20 walks of 1,001 nodes are 20,020 steps, over the 10,000-step work budget (D54).
  expect(sent.http).toBe(400);
});

test("downcase and capitalize change case as LiquidJS does, and nil is empty", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ data.s | downcase }}] [{{ data.t | capitalize }}] [{{ data.n | downcase }}] " +
      "[{{ data.missing | capitalize }}] [{{ data.e | capitalize }}] [{{ 'élan' | capitalize }}]",
    { s: "ÀB Ω", t: "hELLO wORLD", n: 12 },
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[àb ω] [Hello world] [12] [] [] [Élan]");
});

test("prepend and append join a literal string, and a nil argument adds nothing", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ 'b' | prepend: 'a' }}] [{{ 'a' | append: 'b' }}] [{{ 'x' | append: data.missing }}] " +
      "[{{ data.missing | prepend: 'y' }}]",
    {},
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[ab] [ab] [x] [y]");
});

test("replace and replace_first are literal: no regular expression, no $ patterns", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ 'a.b.c' | replace: '.', '$&/' }}] [{{ 'a.b.a' | replace_first: 'a', 'X' }}] " +
      "[{{ 'xyz' | replace: 'q', 'r' }}] [{{ 'xyz' | replace_first: 'q', 'r' }}] " +
      "[{{ 'a(b)' | replace: '(b)', '$1' }}] [{{ data.missing | replace: 'a', 'b' }}]",
    {},
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[a$&/b$&/c] [X.b.a] [xyz] [xyz] [a$1] []");
});

test("replace of an empty pattern goes between the characters, as split and join do", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ 'abc' | replace: '', '-' }}] [{{ '' | replace: '', '-' }}]",
    {},
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[a-b-c] []");
});

test("the text a replacement puts in is escaped in HTML, as any value is", async () => {
  const f = await open();
  const sent = await render(f, "{{ 'a<b' | replace: '<', '&lt;' }}", {});
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("a&amp;lt;b");
});

test("replace charges its output to the emission budget before it builds the text", async () => {
  const f = await open();
  // A 60 KB text with one X and a 60 KB replacement makes about 120 KB per call. `assign` stores
  // the text without emitting it, so only the budget (4 MiB, D54) stops 36 calls.
  const sent = await render(
    f,
    "{% for i in (1..36) %}{% assign t = data.text | replace: 'X', data.rep %}{% endfor %}ok",
    { text: `X${"a".repeat(59_999)}`, rep: "b".repeat(60_000) },
  );
  expect(sent.http).toBe(400);
});

test("split drops trailing empty parts and its parts loop; nil splits to nothing", async () => {
  const f = await open();
  const sent = await render(
    f,
    "{% assign parts = 'a,b,,c,' | split: ',' %}{% for p in parts %}[{{ p }}]{% endfor %} " +
      "{% assign none = data.missing | split: ',' %}{% for p in none %}[{{ p }}]{% endfor %}|" +
      "{% assign words = 'x y' | split: ' ' %}{% for p in words %}<{{ p }}>{% endfor %}",
    {},
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[a][b][][c] |<x><y>");
});

test("join prints an array's items with a separator, a space by default, and nil as empty", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ data.list | join: ', ' }}] [{{ data.words | join }}] [{{ data.missing | join: ',' }}] " +
      "[{{ 'xy' | join: '-' }}]",
    { list: ["a", 1, true, null], words: ["p", "q"] },
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[a, 1, true, ] [p q] [] [xy]");
});

test("join prints a nested list's items as text, joined with its separator", async () => {
  const f = await open();
  const sent = await render(f, "{{ data.nested | join: ',' }}", { nested: [[1, 2], "x"] });
  expect(sent.http).toBe(200);
  expect(sent.message).toContain("12,x");
});

test("slice takes characters with a negative start, or items of an array, and nil is empty", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ 'hello' | slice: 1, 3 }}] [{{ 'hello' | slice: -3 }}] [{{ 'hello' | slice: -3, 2 }}] " +
      "[{{ 'hi' | slice: 5 }}] [{{ data.missing | slice: 0 }}] " +
      "{% assign picked = data.arr | slice: 1, 2 %}{% for x in picked %}<{{ x }}>{% endfor %}",
    { arr: [1, 2, 3, 4] },
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[ell] [l] [ll] [] [] <2><3>");
});

test("slice refuses an argument that is not an integer, when a message supplies it", async () => {
  const f = await open();
  const sent = await render(f, "{{ 'hello' | slice: data.at }}", { at: 1.5 });
  expect(sent.http).toBe(400);
});

test("truncate cuts a longer text to its limit with an ellipsis, and keeps a shorter one", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ 'abcdefghij' | truncate: 5 }}] [{{ 'abc' | truncate: 5 }}] " +
      "[{{ 'abcdefghij' | truncate: 6, '~' }}] [{{ data.long | truncate }}]",
    { long: "x".repeat(60) },
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain(`[ab...] [abc] [abcde~] [${"x".repeat(47)}...]`);
});

test("truncatewords keeps the first words and adds the ellipsis only when words are left out", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ 'one two three four' | truncatewords: 2 }}] [{{ 'one two' | truncatewords: 2 }}] " +
      "[{{ '  lead  space   words  ' | truncatewords: 2, '~' }}] [{{ 'a b' | truncatewords: 0 }}] " +
      "[{{ data.words | truncatewords }}]",
    { words: Array.from({ length: 20 }, () => "w").join(" ") },
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain(
    `[one two...] [one two] [lead space~] [a...] [${Array.from({ length: 15 }, () => "w").join(" ")}...]`,
  );
});

test("strip_html removes tags, comments, script and style, and an unclosed block", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ '<p>Hi <b>there</b></p><!-- c --><script>x</script>!' | strip_html }}] " +
      "[{{ 'a<script>b' | strip_html }}] [{{ '1 < 2' | strip_html }}] " +
      "[{{ '<i>x</i> & y' | strip_html }}]",
    {},
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[Hi there!] [ab] [1 &lt; 2] [x &amp; y]");
});

test("strip_html charges its input to the emission budget before it scans", async () => {
  const f = await open();
  // Each call charges its 64 KB input, so 66 calls are over the 4 MiB budget (D54).
  const sent = await render(
    f,
    "{% for i in (1..70) %}{% assign t = data.big | strip_html %}{% endfor %}ok",
    { big: "<b>a</b>".repeat(8000) },
  );
  expect(sent.http).toBe(400);
});

/** Save a transactional template and return the API's answer. */
async function save(f: TxFixture, body: string) {
  return f.json("/api/templates", "POST", { name: "saved", type: "tx", subject: "s", body });
}

test("a save names an unknown filter and points to template_reference", async () => {
  const f = await open();
  const refused = await save(f, "{{ data.list | first }}");
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain('unknown filter "first" (see template_reference)');
});

test("a save refuses a for loop whose collection has a filter, which would be dropped", async () => {
  const f = await open();
  const refused = await save(f, "{% for x in data.arr | slice: 1 %}{{ x }}{% endfor %}");
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain("a for loop cannot take a filter");
  const kept = await save(
    f,
    "{% assign picked = data.arr | slice: 1 %}{% for x in picked %}{{ x }}{% endfor %}",
  );
  expect(kept.status).toBe(200);
});

test("size keeps the work budget: a loop that sizes a large object is refused", async () => {
  const f = await open();
  const big = Object.fromEntries(Array.from({ length: 200 }, (_, n) => [`k${n}`, n]));
  const sent = await render(f, "{% for i in (1..100) %}{{ data.o | size }}{% endfor %}", {
    o: big,
  });
  // 100 sizes of 200 keys is 20,000 steps, over the 10,000-step work budget (D54).
  expect(sent.http).toBe(400);
});
