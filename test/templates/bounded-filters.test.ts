// The bounded filters added by B135 (lead item 6, D23, D54, D134): plus, minus, times, divided_by, round,
// first, last, newline_to_br and url_encode. Observed through POST /api/tx into the loopback SMTP sink and
// POST /api/templates, which is where a literal failure is refused.
import { afterEach, expect, test } from "bun:test";
import { htmlPart, textPart } from "@/test/messaging/mime";
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

/** Send `body` (in a paragraph) to a fresh address: the status, and the HTML and text parts as read. */
async function render(f: TxFixture, body: string, data: JsonObject = {}) {
  const template = await f.template(`<p>${body}</p>`);
  const email = `b-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const response = await f.tx({ subscriber_emails: [email], template_id: template, data });
  const row = response.body?.data?.sends?.[0];
  const raw = f.mailTo(email)[0]?.data ?? "";
  return {
    http: response.status,
    message: asBody<string | undefined>(response.body?.message),
    status: asBody<string | undefined>(row?.status),
    html: htmlPart(raw) ?? "",
    text: textPart(raw) ?? "",
  };
}

test("plus, minus, times and divided_by compute on numbers and on numeric text", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ 3 | plus: 4 }}] [{{ data.a | minus: 2 }}] [{{ data.a | times: 3 }}] " +
      "[{{ data.a | divided_by: 2 }}] [{{ data.f | divided_by: 2 }}]",
    { a: "7", f: 7.5 },
  );
  expect(sent.status).toBe("sent");
  expect(sent.html).toContain("[7] [5] [21] [3] [3.75]");
});

test("an arithmetic filter on a nil input renders empty, and on a number it does not read fails the send", async () => {
  const f = await open();
  const empty = await render(f, "[{{ data.missing | plus: 1 }}]", {});
  expect(empty.http).toBe(200);
  expect(empty.html).toContain("[]");
  const bad = await render(f, "[{{ data.word | plus: 1 }}]", { word: "abc" });
  expect(bad.http).toBe(400);
  expect(bad.message).toContain("data.word | plus: 1: plus needs a number, got text");
});

test("a division by zero from data fails the send, naming it; a literal one is refused at save", async () => {
  const f = await open();
  const sent = await render(f, "[{{ data.a | divided_by: data.z }}]", { a: 4, z: 0 });
  expect(sent.http).toBe(400);
  expect(sent.message).toContain("divided_by cannot divide by zero");
  const saved = await f.json("/api/templates", "POST", {
    name: "zero",
    type: "tx",
    subject: "s",
    body: "<p>{{ 10 | divided_by: 0 }}</p>",
  });
  expect(saved.status).toBe(400);
  expect(saved.body.message).toContain("divided_by: the first argument cannot be zero");
});

test("round keeps the digits asked for, rounding halves away from zero", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ 3.14159 | round: 2 }}] [{{ 2.5 | round }}] [{{ -2.5 | round }}] [{{ data.n | round: 1 }}]",
    { n: 1.25 },
  );
  expect(sent.status).toBe("sent");
  expect(sent.html).toContain("[3.14] [3] [-3] [1.3]");
});

test("first and last take an item of a list, or a whole character of a text", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ data.list | first }}] [{{ data.list | last }}] [{{ data.text | first }}] " +
      "[{{ data.text | last }}] [{{ data.none | first }}] [{{ data.empty | last }}]",
    { list: ["a", "b", 3], text: "😀x", empty: [] },
  );
  expect(sent.status).toBe("sent");
  expect(sent.html).toContain("[a] [3] [😀] [x] [] []");
});

test("newline_to_br escapes the text once in HTML and writes each line break as a break", async () => {
  const f = await open();
  const sent = await render(f, "{{ data.t | newline_to_br }}", { t: "a<b>\nc & d" });
  expect(sent.status).toBe("sent");
  expect(sent.html).toContain("a&lt;b&gt;<br />\nc &amp; d");
  expect(sent.html).not.toContain("&amp;lt;");
  // A plain-text template has nothing to escape: the text is written as it is, with the break.
  expect(sent.text).toContain("a<b>");
});

test("url_encode percent-encodes the text per RFC 3986: a space is %20, and !'()* are encoded", async () => {
  const f = await open();
  const sent = await render(f, "{{ 'a b&c/é' | url_encode }} {{ \"!'()*-_.~\" | url_encode }}");
  expect(sent.status).toBe("sent");
  expect(sent.html).toContain("a%20b%26c%2F%C3%A9 %21%27%28%29%2A-_.~");
});

test("url_encode counts its output before it builds it, so a long encoding is refused at the output limit", async () => {
  const f = await open();
  // Each 'é' is two bytes and encodes to six: 32,000 of them are 192 KB encoded, six uses are over 1 MB.
  const big = "é".repeat(32_000);
  const body = Array.from({ length: 6 }, () => "{{ data.big | url_encode }}").join("");
  const sent = await render(f, body, { big });
  expect(sent.http).toBe(400);
  expect(sent.message).toContain("data.big | url_encode: Output limit");
});

test("a literal that is not a number is refused at save, whatever the data", async () => {
  const f = await open();
  const literal = await f.json("/api/templates", "POST", {
    name: "literal",
    type: "tx",
    subject: "s",
    body: '<p>{{ "abc" | plus: 1 }}</p>',
  });
  expect(literal.status).toBe(400);
  expect(literal.body.message).toContain("plus needs a number, got text");
});
