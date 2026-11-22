// A list or object in a message prints as text (B135 review blocker 1, D134): a list as LiquidJS
// prints it, its items' text joined with nothing, and an object as its `json` text. Observed through
// POST /api/tx into the loopback SMTP sink, so a send that used to fail with 400 "invalid template"
// now sends with the defined text.
import { afterEach, expect, test } from "bun:test";
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
  const email = `p-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const response = await f.tx({ subscriber_emails: [email], template_id: template, data });
  const row = response.body?.data?.sends?.[0];
  const raw = f.mailTo(email)[0]?.data ?? "";
  const at = raw.indexOf("\r\n\r\n");
  const bytes = raw
    .slice(at + 4)
    .replaceAll("=\r\n", "")
    .replaceAll(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  const message = Buffer.from(bytes, "latin1").toString("utf-8");
  return { http: response.status, status: asBody<string | undefined>(row?.status), message };
}

test("the adopter's template sends: a list prints its items, an object its pairs", async () => {
  const f = await open();
  const data = {
    a: { b: [1, "two", null, true, { x: 2.5 }] },
    n: 10,
    obj: { k: "v" },
    s: "Łódź ź 😀",
    h: "<b>&amp;</b>",
  };
  const sent = await render(
    f,
    "{% for x in data.a.b %}[{{ x }}]{% endfor %}{% for kv in data.obj %}<{{ kv[0] }}={{ kv[1] }}>{% endfor %}",
    data,
  );
  expect(sent.http).toBe(200);
  expect(sent.status).toBe("sent");
  // The object item prints its JSON, escaped as any HTML output is; null is empty.
  expect(sent.message).toContain("[1][two][][true][{&#34;x&#34;:2.5}]<k=v>");
});

test("an object prints as its JSON text", async () => {
  const f = await open();
  const sent = await render(f, "{{ data.obj }}", { obj: { k: "v", n: [1, null] } });
  expect(sent.http).toBe(200);
  expect(sent.message).toContain("{&#34;k&#34;:&#34;v&#34;,&#34;n&#34;:[1,null]}");
});

test("a list prints its items' text joined, with nothing between them", async () => {
  const f = await open();
  const sent = await render(f, "{{ data.arr }}|{{ data.nested }}", {
    arr: [1, 2, 3],
    nested: [["a", "b"], ["c"]],
  });
  expect(sent.http).toBe(200);
  expect(sent.message).toContain("123|abc");
});

test("a loop variable that is a pair prints the key and the value joined", async () => {
  const f = await open();
  const sent = await render(f, "{% for kv in data.obj %}{{ kv }};{% endfor %}", {
    obj: { a: 1, b: "x" },
  });
  expect(sent.http).toBe(200);
  expect(sent.message).toContain("a1;bx;");
});

test("a nested object value prints its JSON in full", async () => {
  const f = await open();
  const sent = await render(f, "{{ data.n }}", { n: { deep: { x: [1, { y: null }] } } });
  expect(sent.http).toBe(200);
  expect(sent.message).toContain("{&#34;deep&#34;:{&#34;x&#34;:[1,{&#34;y&#34;:null}]}}");
});

test("a list or object printed through raw is not escaped", async () => {
  const f = await open();
  const sent = await render(f, "{{ data.obj | raw }}", { obj: { q: "a<b" } });
  expect(sent.http).toBe(200);
  expect(sent.message).toContain('{"q":"a<b"}');
});
