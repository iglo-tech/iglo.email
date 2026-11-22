// The save-time render (B135 item 4, D134): a template whose own text fails to render is refused at
// save with its cause, and a template that fails only for a value a message lacks saves and fails
// at send, as it did before. Observed through POST and PUT /api/templates and POST /api/tx.
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

async function saveTx(f: TxFixture, body: string) {
  return f.json("/api/templates", "POST", { name: "check", type: "tx", subject: "s", body });
}

test("a template whose text cannot render is refused at save, with its cause", async () => {
  const f = await open();
  const cases: Array<[string, string]> = [
    ["{{ 'x' | upcase: 'y' }}", "a filter has the wrong number of arguments"],
    ["{{ data.x | slice: 1, 2, 3 }}", "a filter has the wrong number of arguments"],
    ["{{ 'x' | date: '%q' }}", "a date format has the unsupported directive %q"],
    ["{{ data.when | date: '%q' }}", "a date format has the unsupported directive %q"],
    ["{% for i in (1..2000) %}x{% endfor %}", "a range or loop is out of bounds"],
  ];
  for (const [body, cause] of cases) {
    const refused = await saveTx(f, body);
    expect(refused.status, body).toBe(400);
    expect(refused.body.message, body).toContain("it fails to render: ");
    expect(refused.body.message, body).toContain(cause);
  }
});

test("a literal failure in the template's own text is refused at save, whatever data arrives", async () => {
  const f = await open();
  // Each expression reads no data, so the template's text alone makes it fail (D134).
  const literal: Array<[string, string]> = [
    ['{{ "abc" | truncate: "x" }}', "needs a whole-number argument, got text"],
    ['{{ "2026-02-30" | date: "%Y-%m-%d" }}', "needs a valid date"],
    [`{{ "${"a,".repeat(1100)}" | split: "," }}`, "split would make 1101 parts"],
  ];
  for (const [body, cause] of literal) {
    const refused = await saveTx(f, body);
    const label = body.slice(0, 40);
    expect(refused.status, label).toBe(400);
    expect(refused.body.message, label).toContain("it fails to render: ");
    expect(refused.body.message, label).toContain(cause);
  }
  // The same expression with a value from data is a value failure, so it saves.
  const saved = await saveTx(f, '{{ data.s | truncate: "x" }}');
  expect(saved.status).toBe(200);
});

test("a dynamic lookup whose key comes from data saves, and sends with the key's value", async () => {
  const f = await open();
  const saved = await saveTx(f, "<p>{{ data[data.which] }}</p>");
  expect(saved.status).toBe(200);
  const attribs = await saveTx(f, "<p>{{ subscriber.attribs[data.k] }}</p>");
  expect(attribs.status).toBe(200);
  const id = await f.template("<p>{{ data[data.which] }}</p>");
  const email = `k-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const sent = await f.tx({
    subscriber_emails: [email],
    template_id: id,
    data: { which: "order_id", order_id: "77" },
  });
  expect(sent.status).toBe(200);
});

test("a range whose bound comes from data saves; a bound that is too large fails at send", async () => {
  const f = await open();
  // The sample's order_id is text, and a range is not built from text: a value failure, so it saves.
  const id = await f.template("<p>{% for i in (1..data.order_id) %}x{% endfor %}</p>");
  expect(id).toBeGreaterThan(0);
  const email = `r-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const big = await f.tx({
    subscriber_emails: [email],
    template_id: id,
    data: { order_id: 1_000_000 },
  });
  expect(big.status).toBe(400);
  expect(big.body.message).toContain("data.order_id");
  expect(big.body.message).toContain("a range or loop is out of bounds");
});

test("a forbidden name written in the template is refused at save", async () => {
  const f = await open();
  const refused = await saveTx(f, '<p>{{ data["constructor"] }}</p>');
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain("a property name is not allowed");
});

test("a failure of a value names the expression and the kind of value at send", async () => {
  const f = await open();
  const id = await f.template("<p>{{ data.n | slice: data.k }}</p>");
  const email = `v-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const sent = await f.tx({
    subscriber_emails: [email],
    template_id: id,
    data: { n: "abc", k: "x" },
  });
  expect(sent.status).toBe(400);
  expect(sent.body.message).toContain(
    "data.n | slice: data.k: needs a whole-number argument, got text",
  );
  expect(sent.body.message).not.toContain("invalid template");
});

test("an update is checked the same way, and a template that saves keeps its id", async () => {
  const f = await open();
  const id = await f.template("<p>{{ data.order_id }}</p>");
  const refused = await f.json(`/api/templates/${id}`, "PUT", {
    name: "check",
    body: "<p>{{ 'x' | upcase: 'y' }}</p>",
  });
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain("it fails to render: a filter has the wrong number");
  const kept = await f.json(`/api/templates/${id}`, "GET");
  expect(kept.body.data.body).toBe("<p>{{ data.order_id }}</p>");
});

test("a campaign layout is checked for its own text, with its content slot", async () => {
  const f = await open();
  const refused = await f.json("/api/templates", "POST", {
    name: "layout",
    type: "campaign",
    subject: "",
    body: "<main>{{ content | raw }}</main>{{ 'x' | upcase: 'y' }}",
  });
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain("it fails to render: a filter has the wrong number");
});

test("a value the sample lacks is not refused at save: a message without it renders the date empty", async () => {
  const f = await open();
  // The preview's sample has no `when`: a date of nil is a value, so the save accepts the template.
  const id = await f.template('<p>[{{ data.when | date: "%Y" }}]</p>');
  expect(id).toBeGreaterThan(0);
  // A message that lacks `when` renders nothing for it, and one that carries it renders.
  const email = `c-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const without = await f.tx({ subscriber_emails: [email], template_id: id, data: {} });
  expect(without.status).toBe(200);
  const withValue = await f.tx({
    subscriber_emails: [`d-${email}`],
    template_id: id,
    data: { when: "2026-01-02" },
  });
  expect(withValue.status).toBe(200);
});

test("a date of a text the sample carries as a name is a value failure, so it saves", async () => {
  const f = await open();
  // The sample's subscriber name is "John Doe": no date, so the failure depends on the value.
  const saved = await saveTx(f, '<p>{{ subscriber.name | date: "%Y" }}</p>');
  expect(saved.status).toBe(200);
});
