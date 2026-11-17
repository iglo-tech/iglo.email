// Preview and test send of one sequence step with real or sample data (docs/design/05-sequences.md
// #preview-and-test-send, D105): through the HTTP API, the SMTP sink and the scheduler's own send,
// with time on the injected clock. Nothing is enrolled, journaled or counted by a preview.
import { afterEach, expect, test } from "bun:test";
import { day, hour, schedulerFixture, type SchedulerFixture } from "@/test/scheduler/fixture";

const fixtures: SchedulerFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await schedulerFixture();
  fixtures.push(f);
  return f;
}

/** One line, no `=` or long lines, so the SMTP body is compared as sent. */
const BODY =
  "<p>Hi {{ subscriber.name }}; items: {{ trigger.data.items }}; downloads: {{ aggregates.downloads | number | default: 0 }}</p>";
const ISO = (ms: number) => new Date(ms).toISOString();

/** Events first, then the sequence, so no event starts an enrollment by itself. */
async function setup(f: SchedulerFixture, options: { body?: string } = {}) {
  const template = await f.template(options.body ?? BODY, "Template subject");
  const sequence = await f.sequence({
    trigger: { event: "purchase" },
    steps: [
      {
        wait: "P1D",
        kind: "transactional",
        template_id: template,
        subject: "Order update",
        aggregates: { downloads: { event: "download", since: "trigger", fn: "count" } },
      },
    ],
  });
  return { sequence: sequence.id, step: sequence.steps[0]!.id, template };
}

/** A request as another caller: a separate API user with exactly these permissions. */
async function caller(f: SchedulerFixture, name: string, permissions: string[], lists?: object[]) {
  const role = await f.json("/api/roles/users", "POST", { name, permissions });
  if (role.status !== 200) throw new Error(JSON.stringify(role.body));
  const listRole = lists && (await f.json("/api/roles/lists", "POST", { name, lists }));
  const user = await f.json("/api/users", "POST", {
    username: name,
    type: "api",
    status: "enabled",
    user_role_id: role.body.data.id,
    ...(listRole ? { list_role_id: listRole.body.data.id } : {}),
  });
  if (user.status !== 200) throw new Error(JSON.stringify(user.body));
  return { authorization: `Basic ${btoa(`${name}:${user.body.data.password}`)}` };
}
async function as(
  f: SchedulerFixture,
  headers: Record<string, string>,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await f.request(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const preview = (f: SchedulerFixture, seq: number, step: number, body: unknown = {}) =>
  f.json(`/api/sequences/${seq}/steps/${step}/preview`, "POST", body);
const testSend = (f: SchedulerFixture, seq: number, step: number, body: unknown) =>
  f.json(`/api/sequences/${seq}/steps/${step}/test`, "POST", body);
/** Records an event for a subscriber and returns its ID. */
async function eventId(
  f: SchedulerFixture,
  email: string,
  name: string,
  occurredAt?: string,
  data?: object,
) {
  const r = await f.json("/api/subscriber-events", "POST", {
    subscriber: { email },
    name,
    ...(occurredAt === undefined ? {} : { occurred_at: occurredAt }),
    ...(data === undefined ? {} : { data }),
  });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body.data.event_id as number;
}
const enrollmentTotal = async (f: SchedulerFixture) =>
  (await f.json("/api/enrollments")).body.data.total as number;

test("preview without input renders the dummy subscriber, no trigger and zero aggregates", async () => {
  const f = await open();
  const { sequence, step } = await setup(f);
  const r = await preview(f, sequence, step);
  expect(r.status).toBe(200);
  expect(r.body.data.subject).toBe("Order update");
  expect(r.body.data.body).toBe("<p>Hi John Doe; items: ; downloads: 0</p>");
  expect(r.body.data.context).toMatchObject({
    subscriber: { id: 0, name: "John Doe", email: "dummy@example.invalid", attribs: {} },
    trigger: { name: "purchase", data: {}, occurred_at: ISO(f.clock.now().getTime()) },
    aggregates: { downloads: 0 },
    sequence: { id: sequence, name: "Onboarding" },
    step: { id: step, position: 0, kind: "transactional" },
    unsubscribe_url: "",
    manage_url: "",
  });
  // Nothing is written: no enrollment, no send, no mail.
  expect(await enrollmentTotal(f)).toBe(0);
  expect((await f.json("/api/sends")).body.data.total).toBe(0);
  expect(f.sink.messages).toHaveLength(0);
});

test("a real subscriber: the latest event under the trigger name and aggregates from it", async () => {
  const f = await open();
  const now = f.clock.now().getTime();
  const ada = await f.subscriber("ada@example.test", { name: "Ada" });
  await eventId(f, "ada@example.test", "purchase", ISO(now - 9 * day), { items: 1 });
  const latest = ISO(now - day);
  await eventId(f, "ada@example.test", "purchase", latest, { items: 3 });
  // Before the latest purchase: not counted. After it: counted.
  await eventId(f, "ada@example.test", "download", ISO(now - 2 * day));
  await eventId(f, "ada@example.test", "download", ISO(now - 12 * hour));
  await eventId(f, "ada@example.test", "download", ISO(now - hour));
  const { sequence, step } = await setup(f);

  const r = await preview(f, sequence, step, { subscriber_id: ada });
  expect(r.status).toBe(200);
  expect(r.body.data.body).toBe("<p>Hi Ada; items: 3; downloads: 2</p>");
  expect(r.body.data.context).toMatchObject({
    subscriber: { id: ada, name: "Ada", email: "ada@example.test" },
    trigger: { name: "purchase", data: { items: 3 }, occurred_at: latest },
    aggregates: { downloads: 2 },
  });
});

test("trigger_event_id must be the subscriber's own event under the trigger name, else 400", async () => {
  const f = await open();
  const now = f.clock.now().getTime();
  const ada = await f.subscriber("ada@example.test", { name: "Ada" });
  await f.subscriber("bob@example.test", { name: "Bob" });
  const bobsPurchase = await eventId(f, "bob@example.test", "purchase");
  const adasFeedback = await eventId(f, "ada@example.test", "feedback_given", ISO(now));
  const { sequence, step } = await setup(f);
  const refusal = { status: 400, message: "Invalid fields: trigger_event_id" };
  const cases: [string, object][] = [
    ["another subscriber's event", { subscriber_id: ada, trigger_event_id: bobsPurchase }],
    ["an event under another name", { subscriber_id: ada, trigger_event_id: adasFeedback }],
    ["an unknown ID", { subscriber_id: ada, trigger_event_id: 999_999 }],
    ["no subscriber", { trigger_event_id: bobsPurchase }],
  ];
  for (const [label, body] of cases) {
    const r = await preview(f, sequence, step, body);
    expect([label, r.status, r.body?.message]).toEqual([label, refusal.status, refusal.message]);
  }
});

test("an unreadable subscriber is 404 exactly as an absent one", async () => {
  const f = await open();
  const a = (await f.json("/api/lists", "POST", { name: "a", type: "public", optin: "single" }))
    .body.data.id as number;
  const b = (await f.json("/api/lists", "POST", { name: "b", type: "public", optin: "single" }))
    .body.data.id as number;
  const hidden = await f.subscriber("hidden@example.test", { lists: [b] });
  const { sequence, step } = await setup(f);
  const scoped = await caller(
    f,
    "scoped-preview",
    ["sequences:get", "subscribers:get"],
    [{ id: a, permissions: ["list:get"] }],
  );
  const absent = await as(f, scoped, "POST", `/api/sequences/${sequence}/steps/${step}/preview`, {
    subscriber_id: 999_999,
  });
  const unreadable = await as(
    f,
    scoped,
    "POST",
    `/api/sequences/${sequence}/steps/${step}/preview`,
    {
      subscriber_id: hidden,
    },
  );
  expect(absent.status).toBe(404);
  expect(unreadable).toEqual(absent);
});

test("sample values replace each part of the context and are rendered", async () => {
  const f = await open();
  const { sequence, step } = await setup(f);
  const r = await preview(f, sequence, step, {
    sample: {
      subscriber: {
        name: "Grace",
        email: "grace@example.test",
        external_id: "u_9",
        attribs: { plan: "team" },
      },
      trigger: { name: "purchase", data: { items: 7 }, occurred_at: "2026-11-01T10:00:00Z" },
      aggregates: { downloads: 1234567 },
    },
  });
  expect(r.status).toBe(200);
  expect(r.body.data.body).toBe("<p>Hi Grace; items: 7; downloads: 1,234,567</p>");
  expect(r.body.data.context).toMatchObject({
    subscriber: {
      id: 0,
      name: "Grace",
      email: "grace@example.test",
      external_id: "u_9",
      attribs: { plan: "team" },
    },
    trigger: { name: "purchase", data: { items: 7 }, occurred_at: "2026-11-01T10:00:00Z" },
    aggregates: { downloads: 1234567 },
  });
});

test("a sample on a real subscriber replaces only the fields it names", async () => {
  const f = await open();
  const ada = await f.subscriber("ada@example.test", { name: "Ada" });
  const { sequence, step } = await setup(f);
  const r = await preview(f, sequence, step, {
    subscriber_id: ada,
    sample: { subscriber: { name: "Grace" } },
  });
  expect(r.body.data.context.subscriber).toMatchObject({
    id: ada,
    name: "Grace",
    email: "ada@example.test",
  });
});

test("an invalid sample is refused with nothing rendered", async () => {
  const f = await open();
  const { sequence, step } = await setup(f);
  const refusals: [object, string][] = [
    [{ sample: { aggregates: { nope: 1 } } }, "Invalid fields: sample.aggregates.nope"],
    [{ sample: { aggregates: { downloads: "5" } } }, "Invalid fields: sample.aggregates.downloads"],
    [{ sample: { subscriber: { id: 5 } } }, "Invalid fields: sample.subscriber.id"],
    [{ sample: { data: { x: 1 } } }, "Invalid fields: sample.data"],
    [{ sample: "text" }, "Invalid fields: sample"],
    [
      { sample: { trigger: { occurred_at: "not a date" } } },
      "Invalid fields: sample.trigger.occurred_at",
    ],
    [
      { sample: { subscriber: { attribs: { big: "x".repeat(300 * 1024) } } } },
      "Invalid fields: sample",
    ],
    [{ subscriber: 5 }, "Invalid fields: subscriber"],
  ];
  for (const [body, message] of refusals) {
    const r = await preview(f, sequence, step, body);
    expect([body, r.status, r.body?.message]).toEqual([body, 400, message]);
  }
  expect(f.sink.messages).toHaveLength(0);
});

test("an unknown sequence or step is 404", async () => {
  const f = await open();
  const { sequence, step } = await setup(f);
  expect((await preview(f, 999_999, step)).status).toBe(404);
  expect((await preview(f, sequence, 999_999)).status).toBe(404);
});

test("the preview's body is the body the scheduler sends for the same subscriber and event", async () => {
  const f = await open();
  const now = f.clock.now().getTime();
  const ada = await f.subscriber("ada@example.test", { name: "Ada" });
  const purchaseId = await eventId(f, "ada@example.test", "purchase", ISO(now - day), { items: 3 });
  await eventId(f, "ada@example.test", "download", ISO(now - hour));
  const { sequence, step } = await setup(f);

  const shown = await preview(f, sequence, step, {
    subscriber_id: ada,
    trigger_event_id: purchaseId,
  });
  expect(shown.status).toBe(200);
  const enrolled = await f.json("/api/enrollments", "POST", {
    sequence_id: sequence,
    subscriber_id: ada,
    trigger_event_id: purchaseId,
  });
  expect(enrolled.status).toBe(200);
  await f.pass(day);
  await f.until(() => f.sink.messages.length === 1, "the scheduled message");
  const sent = f.sink.messages[0]!.data;
  expect(sent).toContain("Subject: Order update");
  expect(sent).toContain(shown.body.data.body);
});

test("a test send reaches each address labelled, with untracked links and no journal, enrollment or statistic", async () => {
  const f = await open();
  const template = await f.template(
    `${BODY}<a href="{{ 'https://example.test/offer' | track_link }}">offer</a>`,
    "Template subject",
  );
  const sequence = await f.sequence({
    trigger: { event: "purchase" },
    steps: [{ wait: "P1D", kind: "transactional", template_id: template, subject: "Order update" }],
  });
  const step = sequence.steps[0]!.id;
  const r = await testSend(f, sequence.id, step, { emails: ["owner@example.test"] });
  expect(r.status).toBe(200);
  expect(r.body.data).toBe(true);
  await f.until(() => f.sink.messages.length === 1, "the test message");
  // The SMTP body is quoted-printable: decode it before reading the links.
  const sent = f.sink.messages[0]!.data;
  const decoded = sent
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  expect(sent).toContain("To: owner@example.test");
  expect(sent).toContain("Subject: [Test] Order update");
  expect(decoded).toContain('href="https://example.test/offer"');
  expect(decoded).not.toContain("/link/");
  expect(await enrollmentTotal(f)).toBe(0);
  expect((await f.json("/api/sends")).body.data.total).toBe(0);
});

test("a test send refuses bad address lists before anything is sent", async () => {
  const f = await open();
  const { sequence, step } = await setup(f);
  const six = ["1", "2", "3", "4", "5", "6"].map((n) => `u${n}@example.test`);
  for (const body of [
    { emails: six },
    { emails: ["same@example.test", "SAME@example.test"] },
    { emails: [] },
    { emails: ["not-an-address"] },
    {},
  ]) {
    const r = await testSend(f, sequence, step, body);
    expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
  }
  expect(f.sink.messages).toHaveLength(0);
});

test("a test send needs tx:send as well as sequences:manage", async () => {
  const f = await open();
  const { sequence, step } = await setup(f);
  const manageOnly = await caller(f, "manage-only", ["sequences:manage"]);
  const sendOnly = await caller(f, "send-only", ["tx:send"]);
  for (const headers of [manageOnly, sendOnly]) {
    const r = await as(f, headers, "POST", `/api/sequences/${sequence}/steps/${step}/test`, {
      emails: ["owner@example.test"],
    });
    expect(r.status).toBe(403);
  }
  expect(f.sink.messages).toHaveLength(0);
});

test("a blocklisted address is skipped, and a test with only blocklisted addresses is 400", async () => {
  const f = await open();
  const { sequence, step } = await setup(f);
  await f.subscriber("blocked@example.test", { status: "blocklisted" });
  const only = await testSend(f, sequence, step, { emails: ["blocked@example.test"] });
  expect(only.status).toBe(400);
  const mixed = await testSend(f, sequence, step, {
    emails: ["blocked@example.test", "owner@example.test"],
  });
  expect(mixed.status).toBe(200);
  await f.until(() => f.sink.messages.length === 1, "one message");
  expect(f.sink.messages[0]!.data).toContain("To: owner@example.test");
});
