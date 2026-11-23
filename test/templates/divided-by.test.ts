// Decimal division (B117f lead decisions 1 and 2, D134 as amended there): `divided_by` divides as a decimal, as
// LiquidJS does, wherever its operands came from; a whole-number result rounds down only when the template passes
// `true` as the second argument (LiquidJS's own integer argument). Observed through POST /api/templates and
// POST /api/tx into the loopback SMTP sink.
import { afterEach, expect, test } from "bun:test";
import { htmlPart } from "@/test/messaging/mime";
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

async function saveTx(f: TxFixture, body: string) {
  return f.json("/api/templates", "POST", { name: "divide", type: "tx", subject: "s", body });
}

/** Send `body` (in a paragraph) to a fresh address: the status, the message and the HTML part as read. */
async function send(f: TxFixture, body: string, data: JsonObject = {}) {
  const template = await f.template(`<p>${body}</p>`);
  const email = `d-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const response = await f.tx({ subscriber_emails: [email], template_id: template, data });
  const raw = f.mailTo(email)[0]?.data ?? "";
  return {
    http: response.status,
    message: asBody<string | undefined>(response.body?.message),
    html: htmlPart(raw) ?? "",
  };
}

test("divided_by divides as a decimal: 10 | divided_by: 4 is 2.5, from a literal or from data", async () => {
  const f = await open();
  const sent = await send(
    f,
    "[{{ 10 | divided_by: 4 }}][{{ data.n | divided_by: 4 }}][{{ 20 | divided_by: 7 }}]",
    { n: 10 },
  );
  expect(sent.http).toBe(200);
  expect(sent.html).toContain("[2.5][2.5][2.857142857142857]");
});

test("divided_by: 4, true gives the whole number, rounded down as LiquidJS's integer argument does", async () => {
  const f = await open();
  const sent = await send(
    f,
    "[{{ 10 | divided_by: 4, true }}][{{ data.n | divided_by: 4, true }}][{{ -10 | divided_by: 4, true }}]" +
      "[{{ 10 | divided_by: 4, false }}]",
    { n: 10 },
  );
  expect(sent.http).toBe(200);
  expect(sent.html).toContain("[2][2][-3][2.5]");
});

test("a decimal the template assigns keeps the division a decimal (Shopify's times: 1.0, stored with assign)", async () => {
  const f = await open();
  // Shopify's documented idiom stores the decimal in a variable first; the division reads the variable.
  const sent = await send(
    f,
    "{% assign my_integer = 7 %}{% assign my_float = my_integer | times: 1.0 %}[{{ 20 | divided_by: my_float }}]" +
      "{% assign t = data.n | times: 1.0 %}[{{ t | divided_by: 4 }}]{% assign u = 10.0 %}[{{ u | divided_by: 4 }}]",
    { n: 10 },
  );
  expect(sent.http).toBe(200);
  expect(sent.html).toContain("[2.857142857142857][2.5][2.5]");
});

test("round gives an integer and the division after it is still decimal; a whole result needs the flag", async () => {
  const f = await open();
  // round with no digits gives 11 for 10.5 (halves away from zero), and size counts the three characters of '1.5'.
  const sent = await send(
    f,
    "[{{ 10.5 | round | divided_by: 4 }}][{{ 10.5 | round | divided_by: 4, true }}]" +
      "[{{ data.n | times: 1.0 | round | divided_by: 4 }}][{{ '1.5' | size | divided_by: 2 }}]" +
      "[{{ '1.5' | size | divided_by: 2, true }}]",
    { n: 10 },
  );
  expect(sent.http).toBe(200);
  expect(sent.html).toContain("[2.75][2][2.5][1.5][1]");
});

test("a blank dividend or divisor renders empty, with or without the flag (B135 safety)", async () => {
  const f = await open();
  const sent = await send(
    f,
    "[{{ data.blank | divided_by: 4 }}][{{ data.blank | divided_by: 4, true }}]" +
      "[{{ data.n | divided_by: data.gone }}][{{ data.n | divided_by: data.gone, true }}]",
    { blank: "", n: 10, gone: null },
  );
  expect(sent.http).toBe(200);
  expect(sent.html).toContain("[][][][]");
});

test("the flag must be the literal true or false, and a third argument is refused at save", async () => {
  const f = await open();
  const cases: Array<[string, string]> = [
    [
      "{{ data.n | divided_by: 4, 'yes' }}",
      "divided_by: the second argument must be true or false, got 'yes'",
    ],
    [
      "{{ data.n | divided_by: 4, 1 }}",
      "divided_by: the second argument must be true or false, got 1",
    ],
    ["{{ data.n | divided_by: 4, true, 5 }}", "divided_by: takes at most 2 arguments, got 3"],
  ];
  for (const [body, cause] of cases) {
    const refused = await saveTx(f, body);
    expect(refused.status, body).toBe(400);
    expect(refused.body.message, body).toContain(`it fails to render: ${cause}`);
  }
  // There is no floor filter: a whole number is `divided_by: n, true`, and `floor` is refused as an unknown filter.
  const floor = await saveTx(f, "{{ data.n | divided_by: 4 | floor }}");
  expect(floor.status).toBe(400);
  expect(floor.body.message).toContain("floor");
});

test("a named argument to divided_by is refused at save, not ignored (lead decision 2)", async () => {
  const f = await open();
  // `integer: true` is a keyword argument, which LiquidJS passes on but the whole-number flag never reads: a save that
  // accepted it would divide as a decimal while the author expects a whole number.
  for (const body of [
    "{{ data.n | divided_by: 4, integer: true }}",
    "{{ data.n | divided_by: 4, integer: false }}",
  ]) {
    const refused = await saveTx(f, body);
    expect(refused.status, body).toBe(400);
    expect(refused.body.message, body).toContain(
      "it fails to render: divided_by: takes no named arguments, got integer",
    );
  }
});

test("a flag from data is whole only when it is the JSON boolean true; the text 'true' and a number 1 divide as a decimal", async () => {
  const f = await open();
  // LiquidJS reads its flag as a number, so there a data 1 or "1" would round down; here only the JSON true does.
  const sent = await send(
    f,
    "[{{ data.n | divided_by: 4, data.whole }}][{{ data.n | divided_by: 4, data.text }}]" +
      "[{{ data.n | divided_by: 4, data.one }}][{{ data.n | divided_by: 4, data.digit }}]",
    { n: 10, whole: true, text: "true", one: 1, digit: "1" },
  );
  expect(sent.http).toBe(200);
  expect(sent.html).toContain("[2][2.5][2.5][2.5]");
});
