// The Liquid edges left after B135 (B117e, D134 as amended there): a loop object that a template prints,
// filters or reaches through a property the renderer does not expose is refused at save; the date guard in 06
// holds for every value the date filter renders empty; blank text renders empty in arithmetic and a non-number
// still fails; a division is a decimal whatever its operands are (lead decision 1, see divided-by.test.ts).
// Observed through POST /api/templates and POST /api/tx into the loopback SMTP sink.
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

test("a loop object stored with assign is refused at save, and a loop property stored with assign still sends (B117f)", async () => {
  const f = await open();
  // The stored loop object is read later through a name the save cannot follow, so the store itself is refused.
  for (const body of [
    "{% for i in data.items %}{% assign f = forloop %}{{ f.index }}{% endfor %}",
    "{% for i in data.items %}{% assign f = forloop %}{{ f.parentloop }}{% endfor %}",
  ]) {
    const refused = await saveTx(f, body);
    expect(refused.status, body).toBe(400);
    expect(refused.body.message, body).toContain(
      "a loop object (forloop) cannot be stored with assign",
    );
  }
  const sent = await send(
    f,
    "{% for i in data.items %}{% assign n = forloop.index %}[{{ n }}{{ forloop.last | json }}]{% endfor %}",
    { items: ["a", "b"] },
  );
  expect(sent.http).toBe(200);
  expect(sent.html).toContain("[1false][2true]");
});

test("a bare forloop given to a for tag's limit or offset is refused at save, and a loop property is not (B117f)", async () => {
  const f = await open();
  for (const argument of ["limit: forloop", "offset: forloop"]) {
    const body = `{% for i in data.items %}{% for j in data.items ${argument} %}x{% endfor %}{% endfor %}`;
    const refused = await saveTx(f, body);
    expect(refused.status, body).toBe(400);
    expect(refused.body.message, body).toContain(
      "a loop object (forloop) cannot be a for tag's limit, offset or reversed argument",
    );
  }
  // The outer loop's index is a number, which the inner loop reads as its limit at send.
  const sent = await send(
    f,
    "{% for i in data.items %}{% for j in data.items limit: forloop.index %}{{ j }}{% endfor %}.{% endfor %}",
    { items: ["a", "b"] },
  );
  expect(sent.http).toBe(200);
  expect(sent.html).toContain("a.ab.");
});

test("a division is decimal whatever its operands were written as, as LiquidJS is (B117f, lead decision 1)", async () => {
  const f = await open();
  // Every division is a float: the operands' spelling does not matter, and only `, true` rounds down.
  const sent = await send(
    f,
    "[{{ 10.0 | divided_by: 4 }}][{{ 10 | times: 1.0 | divided_by: 4 }}][{{ data.n | times: 1.0 | divided_by: 4 }}]" +
      "[{{ 7.0 | times: 1 | divided_by: 2 }}][{{ 10.0 | divided_by: 4.0 }}]" +
      "[{{ 10 | divided_by: 4 }}][{{ 10 | times: 2 | divided_by: 4 }}][{{ 10.0 | times: 1 | divided_by: 4 }}]",
    { n: 10 },
  );
  expect(sent.http).toBe(200);
  expect(sent.html).toContain("[2.5][2.5][2.5][3.5][2.5][2.5][5][2.5]");
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

test("a divisor or dividend written as quoted or data text divides as a decimal too (B117e, lead decision 1)", async () => {
  const f = await open();
  const sent = await send(
    f,
    "[{{ 10 | divided_by: '4.0' }}][{{ 10 | divided_by: 4.0 }}][{{ 10 | divided_by: '4' }}]" +
      "[{{ data.a | divided_by: data.q }}][{{ data.a | divided_by: data.i }}]",
    { a: 10, q: "4.0", i: "4" },
  );
  expect(sent.http).toBe(200);
  expect(sent.html).toContain("[2.5][2.5][2.5][2.5][2.5]");
});

test("a dividend written as decimal text, or as a data text, divides as a decimal (B117e, lead decision 1)", async () => {
  const f = await open();
  // The division is a decimal for every operand, so the text of data and of a literal gives the same quotient.
  const sent = await send(
    f,
    "[{{ data.t | divided_by: 4 }}][{{ '10.0' | divided_by: 4 }}][{{ data.i | divided_by: 4 }}][{{ 10 | divided_by: 4 }}]",
    { t: "10.0", i: "10" },
  );
  expect(sent.http).toBe(200);
  expect(sent.html).toContain("[2.5][2.5][2.5][2.5]");
});

test("round renders empty for a blank or missing digits argument from data, and still fails a text that is not a number (B117e)", async () => {
  const f = await open();
  const blank = await send(
    f,
    "[{{ data.a | round: data.spaces }}][{{ data.a | round: data.empty }}][{{ data.a | round: data.gone }}]" +
      "[{{ data.a | round }}][{{ data.a | round: data.two }}]",
    { a: 7.6789, spaces: " ", empty: "", two: "2" },
  );
  expect(blank.http).toBe(200);
  expect(blank.html).toContain("[][][][8][7.68]");
  const word = await send(f, "[{{ data.word | round: data.spaces }}]", {
    word: "abc",
    spaces: " ",
  });
  expect(word.http).toBe(400);
  expect(word.message).toContain("round needs a number, got text");
});

test("the loop reads the round-1 review reproduced are refused at save, where the send would fail (B117e)", async () => {
  const f = await open();
  // Each runs over data with items, so the send fails for every message that has one (before B117e: 200 at save).
  const cases: Array<[string, string]> = [
    [
      '{% for i in data.items %}{% for j in i %}{{ forloop.index | prepend: "." | prepend: forloop.parentloop.index }}{% endfor %}{% endfor %}',
      "forloop.parentloop: a loop property is not available",
    ],
    [
      "{% for i in data.items %}{{ forloop.index | plus: forloop.parentloop.index }}{% endfor %}",
      "forloop.parentloop: a loop property is not available",
    ],
    [
      "{% for i in data.items %}{{ 'x' | append: forloop }}{% endfor %}",
      "a loop object (forloop or tablerowloop) cannot be printed",
    ],
    [
      "{% for i in data.items %}{% for j in forloop.parentloop %}x{% endfor %}{% endfor %}",
      "forloop.parentloop: a loop property is not available",
    ],
    [
      "{% for i in data.items %}[{{ data.m[forloop.parentloop] }}]{% endfor %}",
      "forloop.parentloop: a loop property is not available",
    ],
    [
      "{% for i in data.items %}{% for j in data.items offset: forloop.parentloop.index %}x{% endfor %}{% endfor %}",
      "forloop.parentloop: a loop property is not available",
    ],
    [
      "{% for i in data.items %}[{{ data.m[forloop.index0] | default: forloop.parentloop }}]{% endfor %}",
      "forloop.parentloop: a loop property is not available",
    ],
    [
      "{% for i in data.items %}{% for j in forloop %}x{% endfor %}{% endfor %}",
      "cannot be a for tag's list or a range bound",
    ],
    [
      "{% for i in data.items %}{% for j in (1..forloop) %}x{% endfor %}{% endfor %}",
      "cannot be a for tag's list or a range bound",
    ],
  ];
  for (const [body, cause] of cases) {
    const refused = await saveTx(f, body);
    expect(refused.status, body).toBe(400);
    expect(refused.body.message, body).toContain("it fails to render: ");
    expect(refused.body.message, body).toContain(cause);
  }
  // A nested loop that reads only the loop properties the renderer exposes saves and sends.
  const exposed = await send(
    f,
    "{% for i in data.items %}{% for j in i %}[{{ forloop.index | prepend: '.' }}{{ forloop.index }}]{% endfor %}{% endfor %}",
    { items: [["a", "b"]] },
  );
  expect(exposed.http).toBe(200);
  expect(exposed.html).toContain("[.11][.22]");
});

test("a loop object read by a filter outside any loop is refused at save as well (06, B117e)", async () => {
  const f = await open();
  const refused = await saveTx(f, "{{ forloop | default: 'x' }}");
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain(
    "a loop object (forloop or tablerowloop) cannot be printed",
  );
});
