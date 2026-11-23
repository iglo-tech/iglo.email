// The Liquid edges left after B135 (B117e, D134 as amended there): a loop object that a template prints,
// filters or reaches through a property the renderer does not expose is refused at save; the date guard in 06
// holds for every value the date filter renders empty; blank text renders empty in arithmetic and a non-number
// still fails; a divisor written as quoted text with a decimal point divides as a float. Observed through
// POST /api/templates and POST /api/tx into the loopback SMTP sink.
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
  return f.json("/api/templates", "POST", { name: "edge", type: "tx", subject: "s", body });
}

/** Send `body` (in a paragraph) to a fresh address: the status, the message and the HTML part as read. */
async function send(f: TxFixture, body: string, data: JsonObject = {}) {
  const template = await f.template(`<p>${body}</p>`);
  const email = `e-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const response = await f.tx({ subscriber_emails: [email], template_id: template, data });
  const raw = f.mailTo(email)[0]?.data ?? "";
  return {
    http: response.status,
    message: asBody<string | undefined>(response.body?.message),
    html: htmlPart(raw) ?? "",
  };
}

test("a loop object printed or read by a filter, and a loop property the renderer does not expose, are refused at save", async () => {
  const f = await open();
  // Each loop runs over data, and the sample has no items, so the branch is never reached: the text decides.
  const cases: Array<[string, string]> = [
    [
      "{% for i in data.items %}{{ forloop | json }}{% endfor %}",
      "a loop object (forloop or tablerowloop) cannot be printed",
    ],
    [
      "{% for i in data.items %}{{ forloop | append: 'x' }}{% endfor %}",
      "a loop object (forloop or tablerowloop) cannot be printed",
    ],
    [
      "{% for i in data.items %}{% assign t = forloop | json %}{% endfor %}",
      "a loop object (forloop or tablerowloop) cannot be printed",
    ],
    [
      "{% for i in data.items %}{{ forloop.parentloop }}{% endfor %}",
      "forloop.parentloop: a loop property is not available",
    ],
    [
      "{% for i in data.items %}{% if forloop.parentloop %}x{% endif %}{% endfor %}",
      "forloop.parentloop: a loop property is not available",
    ],
    [
      '{% for i in data.items %}{{ forloop["size"] }}{% endfor %}',
      "forloop.size: a loop property is not available",
    ],
  ];
  for (const [body, cause] of cases) {
    const refused = await saveTx(f, body);
    expect(refused.status, body).toBe(400);
    expect(refused.body.message, body).toContain("it fails to render: ");
    expect(refused.body.message, body).toContain(cause);
  }
  // The loop properties the renderer exposes save and send.
  const exposed = await saveTx(
    f,
    "{% for i in data.items %}{{ forloop.index }}{{ forloop.first | json }}{% endfor %}",
  );
  expect(exposed.status).toBe(200);
});

test("a loop object stored with assign is not refused, and its properties still read in a send", async () => {
  const f = await open();
  const sent = await send(
    f,
    "{% for i in data.items %}{% assign f = forloop %}[{{ f.index }}{{ f.last | json }}]{% endfor %}",
    { items: ["a", "b"] },
  );
  expect(sent.http).toBe(200);
  expect(sent.html).toContain("[1false][2true]");
});

test("the date guard in 06 prints the date only when the date filter renders one", async () => {
  const f = await open();
  // The guard tests the formatted text: a nil, empty, non-date or impossible value renders empty, so the
  // text around it does not print without its date (B117e). A raw `{% if data.delivery_date %}` would not.
  const guard =
    '{% assign d = data.delivery_date | date: "%d %B" %}{% if d != blank %}[Delivery {{ d }}]{% endif %}';
  const dated = await send(f, guard, { delivery_date: "2026-03-05" });
  expect(dated.http).toBe(200);
  expect(dated.html).toContain("[Delivery 05 March]");
  for (const value of ["", "2026-02-30", "next week"]) {
    const none = await send(f, guard, { delivery_date: value });
    expect(none.http, value).toBe(200);
    expect(none.html, value).not.toContain("Delivery");
  }
  const missing = await send(f, guard, {});
  expect(missing.http).toBe(200);
  expect(missing.html).not.toContain("Delivery");
});

test("blank text is empty in arithmetic, as a nil is, and a text that is not a number still fails", async () => {
  const f = await open();
  const blank = await send(
    f,
    "[{{ data.a | plus: data.blank }}][{{ data.a | times: data.spaces }}]" +
      "[{{ data.spaces | plus: 1 }}][{{ data.spaces | round: 1 }}][{{ data.a | divided_by: data.gone }}]",
    { a: 3, blank: "", spaces: " ", gone: null },
  );
  expect(blank.http).toBe(200);
  expect(blank.html).toContain("[][][][][]");
  const word = await send(f, "[{{ data.word | plus: data.blank }}]", { word: "abc", blank: "" });
  expect(word.http).toBe(400);
  expect(word.message).toContain("plus needs a number, got text");
});

test("a divisor written as quoted text with a decimal point divides as a float, as a number literal does", async () => {
  const f = await open();
  const sent = await send(
    f,
    "[{{ 10 | divided_by: '4.0' }}][{{ 10 | divided_by: 4.0 }}][{{ 10 | divided_by: '4' }}]" +
      "[{{ data.a | divided_by: data.q }}][{{ data.a | divided_by: data.i }}]",
    { a: 10, q: "4.0", i: "4" },
  );
  expect(sent.http).toBe(200);
  expect(sent.html).toContain("[2.5][2.5][2][2.5][2]");
});
