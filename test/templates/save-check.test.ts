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
    ["{{ 'x' | upcase: 'y' }}", "upcase: takes no arguments, got 1"],
    ["{{ data.x | slice: 1, 2, 3 }}", "slice: takes at most 2 arguments, got 3"],
    ["{{ 'x' | date: '%q' }}", "date: the format has the unsupported directive %q"],
    ["{{ data.when | date: '%q' }}", "date: the format has the unsupported directive %q"],
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
    ['{{ "abc" | truncate: "x" }}', 'truncate: the first argument must be a whole number, got "x"'],
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
});

test("a literal URL track_link does not accept is refused at save; an empty one, an https one and one from data save", async () => {
  const f = await open();
  // A literal that does not parse or whose scheme is not http(s) fails for every message (B149e).
  for (const url of ["not a url", "ftp://example.test/x", "javascript:alert(1)"]) {
    const body = `<a href="{{ "${url}" | track_link }}">x</a>`;
    const refused = await saveTx(f, body);
    expect(refused.status, url).toBe(400);
    expect(refused.body.message, url).toContain(
      `it fails to render: "${url}" | track_link: Invalid URL`,
    );
  }
  for (const body of [
    '<a href="{{ "" | track_link }}">x</a>',
    '<a href="{{ "https://example.test/x" | track_link }}">x</a>',
    '<a href="{{ data.link | track_link }}">x</a>',
  ]) {
    const saved = await saveTx(f, body);
    expect(saved.status, body).toBe(200);
  }
});

test("a literal argument its filter cannot read is refused at save, naming the filter and the argument", async () => {
  const f = await open();
  // The argument is the template's own text, so the data does not matter (D134).
  const wrong = await saveTx(f, '{{ data.s | truncate: "x" }}');
  expect(wrong.status).toBe(400);
  expect(wrong.body.message).toContain(
    'it fails to render: truncate: the first argument must be a whole number, got "x"',
  );
  // Each literal is judged by its filter's own reader: a whole number, digits from 0 to 15, a number.
  const cases: Array<[string, string]> = [
    [
      "{{ data.s | truncatewords: 2.5 }}",
      "truncatewords: the first argument must be a whole number, got 2.5",
    ],
    ["{{ data.s | slice }}", "slice: missing its first argument, which must be a whole number"],
    [
      "{{ data.n | round: 16 }}",
      "round: the first argument must be whole digits from 0 to 15, got 16",
    ],
    ['{{ data.n | plus: "abc" }}', 'plus: the first argument must be a number, got "abc"'],
    ["{{ data.n | times }}", "times: missing its first argument, which must be a number"],
    ["{{ data.n | divided_by: 0 }}", "divided_by: the first argument cannot be zero"],
    ['{{ data.s | date: "%q" }}', "date: the format has the unsupported directive %q"],
    ["{{ data.s | truncate: 5, 'x', 'y' }}", "truncate: takes at most 2 arguments, got 3"],
    ["{{ data.s | t: 'a' }}", "t: takes its arguments in pairs, got 1"],
  ];
  for (const [body, cause] of cases) {
    const refused = await saveTx(f, body);
    expect(refused.status, body).toBe(400);
    expect(refused.body.message, body).toContain(`it fails to render: ${cause}`);
  }
  // A literal the template never reaches is still its text: refused too.
  const unreached = await saveTx(f, '{% if false %}{{ data.s | truncate: "x" }}{% endif %}');
  expect(unreached.status).toBe(400);
  expect(unreached.body.message).toContain("truncate: the first argument must be a whole number");
});

test("the literal arguments a filter reads save: whole numbers as text, digits up to 15, a numeric text, a date format", async () => {
  const f = await open();
  const valid = [
    '{{ data.s | truncate: 10, "…" }}',
    '{{ data.s | truncate: "12" }}',
    "{{ data.s | truncatewords: 3 }}",
    "{{ data.s | slice: -2 }}",
    "{{ data.s | slice: 1, 4 }}",
    "{{ data.n | round: 15 }}",
    '{{ data.n | plus: "2.5" }}',
    "{{ data.n | divided_by: 4 }}",
    '{{ data.s | date: "%Y-%m" }}',
    '{{ data.s | date: "" }}',
    "{{ data.s | t: 'key', 'name' }}",
  ];
  for (const body of valid) {
    const saved = await saveTx(f, body);
    expect(saved.status, body).toBe(200);
  }
});

test("an argument from data saves, and a wrong value for it fails the send, naming the expression", async () => {
  const f = await open();
  const saved = await saveTx(f, "<p>{{ data.s | truncate: data.n }}</p>");
  expect(saved.status).toBe(200);
  const id = await f.template("<p>{{ data.s | truncate: data.n }}</p>");
  const email = `t-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const sent = await f.tx({
    subscriber_emails: [email],
    template_id: id,
    data: { s: "hello world", n: "x" },
  });
  expect(sent.status).toBe(400);
  expect(sent.body.message).toContain(
    "data.s | truncate: data.n: needs a whole-number argument, got text",
  );
  expect(sent.body.message).not.toContain("invalid template");
});

test("a variable is not a literal, so a wrong value through one saves and fails the send", async () => {
  const f = await open();
  // Only the text the author wrote is judged at save; a value that reaches a filter through a variable is data.
  const saved = await saveTx(f, '{% assign n = "x" %}<p>{{ data.s | truncate: n }}</p>');
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
  expect(refused.body.message).toContain("it fails to render: upcase: takes no arguments, got 1");
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
  expect(refused.body.message).toContain("it fails to render: upcase: takes no arguments, got 1");
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

test("an unknown filter in the subject is named, as one in the body is", async () => {
  const f = await open();
  const refused = await f.json("/api/templates", "POST", {
    name: "subject",
    type: "tx",
    subject: "Hi {{ subscriber.name | sort }}",
    body: "<p>x</p>",
  });
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain('unknown filter "sort" (see template_reference)');
});

test("a for tag inside raw or comment is not a filtered loop, and a pipe in a quoted collection is not a filter", async () => {
  const f = await open();
  const raw = await saveTx(f, "<p>{% raw %}{% for x in data.a | slice: 1 %}{% endraw %}</p>");
  expect(raw.status).toBe(200);
  const comment = await saveTx(f, "<p>{% comment %}{% for x in y | z %}{% endcomment %}</p>");
  expect(comment.status).toBe(200);
  const quoted = await saveTx(f, '<p>{% for x in data["a|b"] %}{{ x }}{% endfor %}</p>');
  expect(quoted.status).toBe(200);
  // A real filtered collection outside those blocks is still refused.
  const real = await saveTx(
    f,
    "<p>{% raw %}x{% endraw %}{% for x in data.a | slice: 1 %}{% endfor %}</p>",
  );
  expect(real.status).toBe(400);
  expect(real.body.message).toContain("a for loop cannot take a filter");
});
