// The bounded Liquid filters of B135 (docs/design/06-templates.md, D23, D54, D134), observed through
// POST /api/tx into the loopback SMTP sink.
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
  const email = `f-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const response = await f.tx({ subscriber_emails: [email], template_id: template, data });
  const row = response.body?.data?.sends?.[0];
  const raw = f.mailTo(email)[0]?.data ?? "";
  const at = raw.indexOf("\r\n\r\n");
  const message = raw
    .slice(at + 4)
    .replaceAll("=\r\n", "")
    .replaceAll(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
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

test("size keeps the work budget: a loop that sizes a large object is refused", async () => {
  const f = await open();
  const big = Object.fromEntries(Array.from({ length: 200 }, (_, n) => [`k${n}`, n]));
  const sent = await render(f, "{% for i in (1..100) %}{{ data.o | size }}{% endfor %}", {
    o: big,
  });
  // 100 sizes of 200 keys is 20,000 steps, over the 10,000-step work budget (D54).
  expect(sent.http).toBe(400);
});
