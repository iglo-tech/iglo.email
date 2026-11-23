// `{% for kv in data.obj %}` over a plain object (B135 item 4, D23, D54), observed through POST
// /api/tx into the loopback SMTP sink. Each item is a [key, value] pair; `forloop` is intact.
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
  const email = `o-${crypto.randomUUID().slice(0, 12)}@example.test`;
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

test("a loop over an object yields each key and value as a pair, in order", async () => {
  const f = await open();
  const sent = await render(f, "{% for kv in data.obj %}{{ kv[0] }}={{ kv[1] }};{% endfor %}", {
    obj: { a: 1, b: "x", c: true, d: null },
  });
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("a=1;b=x;c=true;d=;");
});

test("a value that is itself an object can be read inside the loop", async () => {
  const f = await open();
  const sent = await render(f, "{% for kv in data.obj %}{{ kv[0] }}:{{ kv[1].x }}{% endfor %}", {
    obj: { first: { x: 3 }, second: { x: 4 } },
  });
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("first:3second:4");
});

test("an empty object runs the else branch, and forloop counts its pairs", async () => {
  const f = await open();
  const sent = await render(
    f,
    "{% for kv in data.empty %}X{% else %}none{% endfor %}|" +
      "{% for kv in data.obj %}{{ forloop.index }}{% if forloop.first %}F{% endif %}" +
      "{% if forloop.last %}L{% endif %}{{ forloop.length }};{% endfor %}",
    { empty: {}, obj: { a: 1, b: 2 } },
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("none|1F2;2L2;");
});

test("a loop over an object of a realistic size renders, and a larger one is refused by the work budget", async () => {
  const f = await open();
  const small = Object.fromEntries(Array.from({ length: 100 }, (_, n) => [`k${n}`, n]));
  const large = Object.fromEntries(Array.from({ length: 1000 }, (_, n) => [`k${n}`, n]));
  const body = "{% for kv in data.obj %}{{ kv[0] }}={{ kv[1] }};{% endfor %}";
  const ok = await render(f, body, { obj: small });
  expect(ok.status).toBe("sent");
  expect(ok.message).toContain("k99=99;");
  // Each pair costs three collection steps and about four more to render: 1,000 pairs are over the
  // 10,000-step work budget (D54), so this send is refused, as a 1,000-item array would be.
  const refused = await render(f, body, { obj: large });
  expect(refused.http).toBe(400);
});
