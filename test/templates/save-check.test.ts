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
    ["{{ 'x' | date: '%q' }}", "a date format has an unsupported directive"],
    ["{% for i in (1..2000) %}x{% endfor %}", "a range or loop is out of bounds"],
  ];
  for (const [body, cause] of cases) {
    const refused = await saveTx(f, body);
    expect(refused.status, body).toBe(400);
    expect(refused.body.message, body).toContain(`it fails to render: ${cause}`);
  }
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

test("a value failure is not refused at save: the template saves and the message without the value fails at send", async () => {
  const f = await open();
  // The preview's sample has no `when`: a date of nil is a value failure, so the save accepts it.
  const id = await f.template('<p>{{ data.when | date: "%Y" }}</p>');
  expect(id).toBeGreaterThan(0);
  // A message that lacks `when` fails at send, and one that carries it renders.
  const email = `c-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const without = await f.tx({ subscriber_emails: [email], template_id: id, data: {} });
  expect(without.status).toBe(400);
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
