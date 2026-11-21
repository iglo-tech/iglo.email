// The `number` Liquid filter (docs/design/06-templates.md, D102), observed through POST /api/tx
// into the loopback SMTP sink, the template save and preview APIs.
import { afterEach, expect, test } from "bun:test";
import { txFixture } from "@/test/tx/fixture";
import type { TxFixture } from "@/test/tx/fixture";

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
async function render(f: TxFixture, body: string, data: object = {}) {
  const template = await f.template(`<p>${body}</p>`);
  const email = `n-${crypto.randomUUID().slice(0, 12)}@example.test`;
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
  return { http: response.status, status: row?.status as string | undefined, message };
}

test("integers are grouped and fractions round to three places, half away from zero", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ 1234567 | number }}] [{{ 1234.5678 | number }}] [{{ 1234.5675 | number }}] " +
      "[{{ 0.0005 | number }}] [{{ -0.0005 | number }}] [{{ 999 | number }}]",
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[1,234,567] [1,234.568] [1,234.568] [0.001] [-0.001] [999]");
});

test("negatives keep their sign, and zero and values that round to zero render 0", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ data.a | number }}] [{{ data.b | number }}] [{{ data.c | number }}] [{{ data.d | number }}] [{{ data.e | number }}]",
    { a: -1234, b: 0, c: -0.0001, d: -1234.5678, e: -1_000_000 },
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[-1,234] [0] [0] [-1,234.568] [-1,000,000]");
});

test("the largest safe integer and the largest finite number format in full", async () => {
  const f = await open();
  const sent = await render(f, "[{{ data.safe | number }}] [{{ data.huge | number }}]", {
    safe: Number.MAX_SAFE_INTEGER,
    huge: Number.MAX_VALUE,
  });
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[9,007,199,254,740,991]");
  // 309 integer digits: 179,769,… with 102 further groups of three.
  expect(sent.message).toMatch(/\[179(?:,\d{3}){102}\]/);
});

test("strings, booleans and nil render as they would without the filter", async () => {
  const f = await open();
  const plain = await render(
    f,
    "[{{ data.s }}] [{{ data.t }}] [{{ data.b }}] [{{ data.missing }}]",
    {
      s: "1234567",
      t: "abc",
      b: true,
    },
  );
  const filtered = await render(
    f,
    "[{{ data.s | number }}] [{{ data.t | number }}] [{{ data.b | number }}] [{{ data.missing | number }}]",
    { s: "1234567", t: "abc", b: true },
  );
  expect(plain.status).toBe("sent");
  expect(filtered.status).toBe("sent");
  expect(filtered.message).toContain("[1234567] [abc] [true] []");
  expect(plain.message).toContain("[1234567] [abc] [true] []");
});

test("objects and arrays fail exactly as they do without the filter", async () => {
  const f = await open();
  const data = { o: { a: 1 }, list: [1, 2] };
  const plain = await render(f, "[{{ data.o }}]", data);
  const filtered = await render(f, "[{{ data.o | number }}]", data);
  const plainList = await render(f, "[{{ data.list }}]", data);
  const filteredList = await render(f, "[{{ data.list | number }}]", data);
  expect(filtered).toEqual(plain);
  expect(filteredList).toEqual(plainList);
  expect(plain.status).not.toBe("sent");
});

test("the filter takes no argument: preview and a send refuse one", async () => {
  const f = await open();
  const sent = await render(f, "[{{ data.n | number: 2 }}]", { n: 5 });
  expect(sent.status).not.toBe("sent");
  expect(sent.message).not.toContain("[5]");
  const preview = await f.request("/api/templates/preview", {
    method: "POST",
    headers: {
      ...f.sessionHeaders,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ template_type: "tx", body: "[{{ 5 | number: 2 }}]" }),
  });
  expect(preview.status).toBe(400);
});

test("preview renders the filter", async () => {
  const f = await open();
  const preview = await f.request("/api/templates/preview", {
    method: "POST",
    headers: {
      ...f.sessionHeaders,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ template_type: "tx", body: "[{{ 1234567 | number }}]" }),
  });
  expect(preview.status).toBe(200);
  expect(await preview.text()).toContain("[1,234,567]");
});

test("number before default: a missing value is 0, and a present number formats", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ data.missing | number | default: 0 }}] [{{ data.n | number | default: 0 }}] " +
      "[{{ data.text | number | default: 0 }}]",
    { n: 1_234_567, text: "none" },
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[0] [1,234,567] [none]");
});

test("an assigned default: 0 compares and prints as it did before the number filter", async () => {
  const f = await open();
  const sent = await render(
    f,
    '{% assign missing = data.missing | default: 0 %}[{% if missing == "0" %}text-zero{% endif %}]' +
      "[{% if missing == 0 %}number-zero{% endif %}][{{ missing }}] " +
      '{% assign n = data.n | default: 0 %}[{% if n contains "1" %}has-one{% endif %}]' +
      '[{% if n == "0" %}zero{% endif %}][{{ n.size }}]',
    { n: 123 },
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[text-zero][][0] [has-one][][3]");
});

test("number in a subject formats the value the subject renders", async () => {
  const f = await open();
  const template = await f.template("<p>body</p>", "Total {{ data.n | number }} items");
  const email = `subject-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const response = await f.tx({
    subscriber_emails: [email],
    template_id: template,
    data: { n: 1_234_567 },
  });
  expect(response.body?.data?.sends?.[0]?.status).toBe("sent");
  expect(f.mailTo(email)[0]?.data).toContain("Subject: Total 1,234,567 items");
});

test("default output is unchanged for numbers without the filter", async () => {
  const f = await open();
  const sent = await render(f, "[{{ data.n | default: 0 }}] [{{ data.missing | default: 7 }}]", {
    n: 42,
  });
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[42] [7]");
});
