// Test mode and the read endpoints of the sequence screens (docs/design/05-sequences.md#test-mode,
// 07-api-and-ui.md), through the HTTP API and the SMTP sink, with time on the injected clock.
import { afterEach, expect, test } from "bun:test";
import { day, minute, schedulerFixture, type SchedulerFixture } from "@/test/scheduler/fixture";

const fixtures: SchedulerFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await schedulerFixture();
  fixtures.push(f);
  return f;
}
const step = (template: number, wait: string, extra: object = {}) => ({
  wait,
  kind: "transactional",
  template_id: template,
  ...extra,
});
const testEnroll = (f: SchedulerFixture, sequence: number, subscriber: number) =>
  f.json("/api/enrollments", "POST", {
    sequence_id: sequence,
    subscriber_id: subscriber,
    test: true,
  });
const entries = async (f: SchedulerFixture, id: number) =>
  (await f.json(`/api/enrollments/${id}/timeline`)).body.data.entries as Record<string, any>[];

test("a test enrollment shortens every wait to a minute and sends labelled mail", async () => {
  const f = await open();
  const template = await f.template("<p>Hi</p>", "Welcome");
  const definition = {
    steps: [step(template, "P1D"), step(template, "PT0S"), step(template, "P3D")],
  };
  const sequence = await f.sequence(definition);
  const subscriber = await f.subscriber("test@example.test");

  const started = await testEnroll(f, sequence.id, subscriber);
  expect(started.status).toBe(200);
  const id = started.body.data.id as number;
  expect(started.body.data.test).toBe(true);
  const dueIn = (at: string) => Date.parse(at) - f.clock.now().getTime();
  expect(dueIn(started.body.data.due_at)).toBe(minute);

  // The clock moves only once a delivery has settled: it also times SMTP.
  const delivered = async (count: number) => {
    await f.until(() => f.sink.messages.length === count, `${count} messages`);
    await f.until(
      async () => (await f.sendLog()).every((send) => send.status === "sent"),
      "journaled sends",
    );
  };
  await f.pass(minute);
  await delivered(1);
  // The second step's zero wait stays zero: a test only ever shortens.
  await f.pass(0);
  await delivered(2);
  const third = await f.enrollment(id);
  expect(third.status).toBe("active");
  expect(dueIn(third.due_at)).toBe(minute);
  await f.pass(minute);
  await delivered(3);
  await f.until(async () => (await f.enrollment(id)).status === "completed", "completion");
  for (const message of f.sink.messages) expect(message.data).toContain("Subject: [Test] Welcome");

  // The definition is as it was.
  const after = (await f.json(`/api/sequences/${sequence.id}`)).body.data;
  expect(after.steps.map((s: { wait: string }) => s.wait)).toEqual(["P1D", "PT0S", "P3D"]);
  expect(after.updated_at).toBe(sequence.updated_at);

  const decisions = await entries(f, id);
  expect(decisions.map((e) => e.type)).toEqual(["enrolled", "step", "step", "step", "ended"]);
  expect(decisions.slice(1, 4).map((e) => e.decision)).toEqual(["sent", "sent", "sent"]);
  expect(decisions.at(-1)).toMatchObject({ status: "completed", reason: null });
});

test("a test leaves real enrollments, reentry and counts alone", async () => {
  const f = await open();
  const template = await f.template();
  const sequence = await f.sequence({ reentry: "never", steps: [step(template, "P3D")] });
  const started = await f.event("real@example.test");
  const real = started.enrollments.started[0]!.id;
  const before = await f.enrollment(real);

  const during = await testEnroll(f, sequence.id, started.subscriber_id);
  expect(during.status).toBe(200);
  expect(await f.enrollment(real)).toEqual(before);
  // One running test at a time for a person and a sequence.
  expect((await testEnroll(f, sequence.id, started.subscriber_id)).status).toBe(409);
  expect((await f.json(`/api/sequences/${sequence.id}`)).body.data.active_enrollments).toBe(1);
  const listed = await f.json(`/api/enrollments?sequence_id=${sequence.id}`);
  expect(listed.body.data.results.map((e: { test: boolean }) => e.test)).toEqual([true, false]);
  await f.json(`/api/enrollments/${during.body.data.id}`, "DELETE");

  // A test ignores history, and a later real trigger does not see it.
  const fresh = await f.subscriber("fresh@example.test");
  const trial = await testEnroll(f, sequence.id, fresh);
  await f.json(`/api/enrollments/${trial.body.data.id}`, "DELETE");
  const next = await f.event("fresh@example.test");
  expect(next.enrollments.started).toHaveLength(1);
  expect((await testEnroll(f, sequence.id, started.subscriber_id)).status).toBe(200);
});

test("a test reaches no one a normal enrollment could not", async () => {
  const f = await open();
  const template = await f.template();
  const list = await f.list("double", "double");
  const sequence = await f.sequence({
    list_id: list,
    steps: [step(template, "PT0S", { kind: "marketing" })],
  });
  const refused = async (id: number, text: string) => {
    const response = await testEnroll(f, sequence.id, id);
    expect(response.status).toBe(409);
    expect(response.body.message).toContain(text);
  };
  await refused(await f.subscriber("none@example.test"), "not_subscribed");
  await refused(await f.subscriber("pending@example.test", { lists: [list] }), "unconfirmed");
  const blocked = await f.subscriber("blocked@example.test", {
    lists: [list],
    status: "blocklisted",
  });
  await refused(blocked, "blocklisted");
  expect(f.sink.messages).toHaveLength(0);
  expect((await f.json(`/api/enrollments?sequence_id=${sequence.id}`)).body.data.total).toBe(0);

  const paused = await f.sequence({ status: "paused", steps: [step(template, "PT0S")] });
  expect((await testEnroll(f, paused.id, blocked)).status).toBe(409);
  const bad = await f.json("/api/enrollments", "POST", {
    sequence_id: sequence.id,
    subscriber_id: blocked,
    test: true,
    force: true,
  });
  expect(bad.status).toBe(400);
});

test("consent lost during a test ends it like any other enrollment", async () => {
  const f = await open();
  const template = await f.template();
  const list = await f.list("single");
  const sequence = await f.sequence({
    list_id: list,
    steps: [step(template, "P1D", { kind: "marketing" })],
  });
  const id = await f.subscriber("gone@example.test", { lists: [list] });
  const started = await testEnroll(f, sequence.id, id);
  expect(started.status).toBe(200);
  const removed = await f.json(`/api/subscribers/lists`, "PUT", {
    ids: [id],
    action: "unsubscribe",
    target_list_ids: [list],
  });
  expect(removed.status).toBe(200);
  await f.pass(minute);
  const ended = await f.enrollment(started.body.data.id);
  expect(ended).toMatchObject({ status: "exited", exit_reason: "unsubscribed", test: true });
  expect(f.sink.messages).toHaveLength(0);
});

test("the timeline shows the trigger, decisions, the wait and the end, as data", async () => {
  const f = await open();
  const template = await f.template();
  const sequence = await f.sequence({
    exit_on: ["stop"],
    steps: [
      step(template, "PT0S", {
        condition: { attr: "plan", op: "eq", value: "none" },
        on_false: "skip",
      }),
      step(template, "PT0S"),
      step(template, "P1D"),
    ],
  });
  const hostile = '<img src=x onerror="window.pwned=1">';
  const started = await f.event("line@example.test", "order_paid", { data: { note: hostile } });
  const id = started.enrollments.started[0]!.id;
  await f.pass(0);
  await f.until(async () => (await entries(f, id)).at(-1)?.position === 2, "third step");
  const running = await entries(f, id);
  expect(running[0]).toMatchObject({
    type: "trigger",
    name: "order_paid",
    data: { note: hostile },
  });
  expect(running.slice(2).map((e) => [e.type, e.position, e.decision])).toEqual([
    ["step", 0, "passed"],
    ["step", 1, expect.stringMatching(/queued|sending|sent/)],
    ["waiting", 2, undefined],
  ]);
  // The timeline is not the send log: no address reaches a sequences:get reader.
  expect(JSON.stringify(running)).not.toContain("line@example.test");

  await f.event("line@example.test", "stop");
  expect((await entries(f, id)).at(-1)).toMatchObject({
    type: "ended",
    status: "exited",
    reason: "event:stop",
  });
  expect((await f.json("/api/enrollments/999999/timeline")).status).toBe(404);
});

test("subscriber records follow the subscriber's list scope and their own permission", async () => {
  const f = await open();
  const template = await f.template();
  await f.sequence({ steps: [step(template, "PT0S")] });
  const started = await f.event("tabs@example.test", "order_paid", { data: { n: 1 } });
  const id = started.subscriber_id;
  await f.pass(0);
  await f.until(() => f.sink.messages.length === 1, "mail");

  const events = await f.json(`/api/subscribers/${id}/subscriber-events`);
  expect(events.body.data).toMatchObject({ total: 1, page: 1, per_page: 20 });
  expect(events.body.data.results[0]).toMatchObject({ name: "order_paid", data: { n: 1 } });
  const enrollments = await f.json(`/api/subscribers/${id}/enrollments`);
  expect(enrollments.body.data.results[0].subscriber_id).toBe(id);
  expect(enrollments.body.data.results[0].sequence_name).toBe("Onboarding");
  const sends = await f.json(`/api/subscribers/${id}/sends`);
  expect(sends.body.data.results[0].to_email).toBe("tabs@example.test");
  expect((await f.json(`/api/subscribers/${id}/sends?per_page=101`)).status).toBe(400);
  expect((await f.json("/api/subscribers/999999/subscriber-events")).status).toBe(400);
});

test("a day-long wait for a real enrollment is untouched by test mode", async () => {
  const f = await open();
  const template = await f.template();
  await f.sequence({ steps: [step(template, "P1D")] });
  const started = await f.event("real-wait@example.test");
  const row = await f.enrollment(started.enrollments.started[0]!.id);
  expect(row.test).toBe(false);
  expect(Date.parse(row.due_at) - f.clock.now().getTime()).toBe(day);
});
