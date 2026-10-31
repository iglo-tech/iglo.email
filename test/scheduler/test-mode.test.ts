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

test("the timeline shows the trigger, recorded decisions, the wait and the end, as data", async () => {
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
  // The skipped first step wrote nothing, so the timeline claims nothing about it.
  expect(running.slice(2).map((e) => [e.type, e.position, e.decision])).toEqual([
    ["step", undefined, expect.stringMatching(/queued|sending|sent/)],
    ["waiting", 2, undefined],
  ]);
  expect(running[2]!.step_id).toBe(sequence.steps[1]!.id);

  await f.event("line@example.test", "stop");
  expect((await entries(f, id)).at(-1)).toMatchObject({
    type: "ended",
    status: "exited",
    reason: "event:stop",
  });
  expect((await f.json("/api/enrollments/999999/timeline")).status).toBe(404);
});

test("a send keeps naming its own step after that step is replaced", async () => {
  const f = await open();
  const template = await f.template();
  const sequence = await f.sequence({ steps: [step(template, "PT0S")] });
  const done = (await f.event("replaced@example.test")).enrollments.started[0]!.id;
  await f.pass(0);
  await f.until(async () => (await f.enrollment(done)).status === "completed", "completion");
  const original = sequence.steps[0]!.id;
  const replaced = await f.json(`/api/sequences/${sequence.id}`, "PUT", {
    name: "Onboarding",
    status: "active",
    trigger: { event: "order_paid" },
    reentry: "always",
    steps: [step(template, "PT0S")],
  });
  expect(replaced.status).toBe(200);
  expect(replaced.body.data.steps[0].id).not.toBe(original);
  const entry = (await entries(f, done)).find((e) => e.type === "step");
  expect(entry).toMatchObject({ step_id: original, removed: true });
});

test("a timeline never reads history from the current definition", async () => {
  const f = await open();
  const template = await f.template();
  const steps = [step(template, "PT0S")];
  const sequence = await f.sequence({ steps });
  const done = (await f.event("done@example.test")).enrollments.started[0]!.id;
  await f.pass(0);
  await f.until(async () => (await f.enrollment(done)).status === "completed", "completion");

  // A step appended after the end was never reached by this enrollment.
  const kept = sequence.steps.map((s) => s.id);
  const put = (definition: object[]) =>
    f.json(`/api/sequences/${sequence.id}`, "PUT", {
      name: "Onboarding",
      status: "active",
      trigger: { event: "order_paid" },
      reentry: "always",
      steps: definition,
    });
  const appended = await put([{ ...steps[0], id: kept[0] }, step(template, "P1D")]);
  expect(appended.status).toBe(200);
  const ended = await entries(f, done);
  expect(ended.map((e) => e.type)).toEqual(["trigger", "enrolled", "step", "ended"]);
  expect(ended[2]).toMatchObject({
    step_id: kept[0],
    decision: expect.stringMatching(/queued|sending|sent/),
    removed: false,
  });
  expect(ended[2]).not.toHaveProperty("position");

  // Nor is a step inserted ahead of an active enrollment's current position.
  const waiting = (await f.event("waiting@example.test")).enrollments.started[0]!.id;
  await f.pass(0);
  await f.until(async () => (await entries(f, waiting)).at(-1)?.type === "waiting", "wait");
  const [first, second] = appended.body.data.steps.map((s: { id: number }) => s.id);
  const inserted = await put([
    { ...steps[0], id: first },
    step(template, "PT0S"),
    { ...step(template, "P1D"), id: second },
  ]);
  expect(inserted.status).toBe(200);
  const active = await entries(f, waiting);
  expect(active.map((e) => e.type)).toEqual(["trigger", "enrolled", "step", "waiting"]);
  expect(active.filter((e) => e.type === "step").map((e) => e.step_id)).toEqual([first]);
  expect(JSON.stringify(active)).not.toContain("passed");
});

/** The API users of a subscriber on list A and another only on list B, both enrolled. */
async function scoped(f: SchedulerFixture) {
  const template = await f.template();
  const listA = await f.list("A"),
    listB = await f.list("B");
  const sequence = await f.sequence({ steps: [step(template, "PT0S"), step(template, "P1D")] });
  const secret = { billing: { street: "1 Hidden Street" }, buyer: "hidden-buyer@example.test" };
  const person = async (email: string, list: number) => {
    const id = await f.subscriber(email, { lists: [list] });
    const started = await f.event(email, "order_paid", { data: secret });
    return { id, enrollment: started.enrollments.started[0]!.id };
  };
  const shown = await person("shown@example.test", listA);
  const hidden = await person("hidden@example.test", listB);
  await f.pass(0);
  await f.until(() => f.sink.messages.length === 2, "mail");
  const onA = [{ id: listA, permissions: ["list:get"] }];
  return { sequence, shown, hidden, onA };
}
/** Every read an enrollment reaches: the IDs, status and steps, and nothing of the person. */
async function expectAnonymous(
  read: Awaited<ReturnType<SchedulerFixture["apiUser"]>>,
  sequence: number,
  subject: { id: number; enrollment: number },
) {
  const list = await read(`/api/enrollments?sequence_id=${sequence}&per_page=100`);
  expect(list.status).toBe(200);
  const row = list.body.data.results.find((e: { id: number }) => e.id === subject.enrollment);
  const detail = await read(`/api/enrollments/${subject.enrollment}`);
  expect(detail.status).toBe(200);
  const timeline = await read(`/api/enrollments/${subject.enrollment}/timeline`);
  expect(timeline.status).toBe(200);
  for (const enrollment of [row, detail.body.data, timeline.body.data.enrollment]) {
    expect(enrollment).toMatchObject({
      id: subject.enrollment,
      subscriber_id: subject.id,
      status: "active",
    });
    expect(enrollment).not.toHaveProperty("subscriber_email");
  }
  const found = timeline.body.data.entries as Record<string, any>[];
  expect(found.map((e) => e.type)).toEqual(["enrolled", "step", "waiting"]);
  expect(found[1]).toMatchObject({ removed: false, kind: "transactional" });
  expect(found[1]).not.toHaveProperty("position");
  const text = JSON.stringify([row, detail.body, timeline.body]);
  for (const secret of ["example.test", "Hidden Street", "order_paid"])
    expect(text).not.toContain(secret);
}

test("sequences:get alone shows an enrollment without its person", async () => {
  const f = await open();
  const { sequence, hidden } = await scoped(f);
  const read = await f.apiUser("sequences-only", ["sequences:get"]);
  await expectAnonymous(read, sequence.id, hidden);
  for (const path of ["", "/subscriber-events", "/enrollments", "/sends"])
    expect((await read(`/api/subscribers/${hidden.id}${path}`)).status).toBe(403);
});

test("a list role decides each enrollment row, whatever the subscriber permission", async () => {
  const f = await open();
  const { sequence, shown, hidden, onA } = await scoped(f);
  for (const [name, permission] of [
    ["get-all-on-a", "subscribers:get_all"],
    ["get-on-a", "subscribers:get"],
  ] as const) {
    const read = await f.apiUser(name, ["sequences:get", "sends:get", permission], onA);
    await expectAnonymous(read, sequence.id, hidden);

    // The same page still addresses the subscriber the role can read.
    const page = await read(`/api/enrollments?sequence_id=${sequence.id}`);
    const addressed = page.body.data.results.filter(
      (e: Record<string, unknown>) => "subscriber_email" in e,
    );
    expect(addressed.map((e: { id: number }) => e.id)).toEqual([shown.enrollment]);
    expect(addressed[0].subscriber_email).toBe("shown@example.test");
    const detail = await read(`/api/enrollments/${shown.enrollment}`);
    expect(detail.body.data.subscriber_email).toBe("shown@example.test");
    const timeline = await read(`/api/enrollments/${shown.enrollment}/timeline`);
    expect(timeline.body.data.enrollment.subscriber_email).toBe("shown@example.test");
    expect(timeline.body.data.entries[0]).toMatchObject({
      type: "trigger",
      name: "order_paid",
      data: { billing: { street: "1 Hidden Street" } },
    });
  }
});

test("a global list grant reads every enrollment's person", async () => {
  const f = await open();
  const { sequence, hidden } = await scoped(f);
  const read = await f.apiUser("all-lists", ["sequences:get", "subscribers:get", "lists:get_all"]);
  const page = await read(`/api/enrollments?sequence_id=${sequence.id}`);
  expect(
    page.body.data.results.map((e: { subscriber_email: string }) => e.subscriber_email),
  ).toEqual(["hidden@example.test", "shown@example.test"]);
  const timeline = await read(`/api/enrollments/${hidden.enrollment}/timeline`);
  expect(timeline.body.data.entries[0]).toMatchObject({ type: "trigger", name: "order_paid" });
});

test("a deleted subscriber takes the enrollment's address with it", async () => {
  const f = await open();
  const { sequence, hidden } = await scoped(f);
  expect((await f.enrollment(hidden.enrollment)).subscriber_email).toBe("hidden@example.test");
  expect((await f.json(`/api/subscribers/${hidden.id}`, "DELETE")).status).toBe(200);
  expect((await f.json(`/api/enrollments/${hidden.enrollment}/timeline`)).status).toBe(404);
  const page = await f.json(`/api/enrollments?sequence_id=${sequence.id}`);
  expect(JSON.stringify(page.body)).not.toContain("hidden@example.test");
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

test("each subscriber tab refuses a reader outside the list or without its permission", async () => {
  const f = await open();
  const { shown, hidden, onA } = await scoped(f);
  const tab = (id: number, path: string) => `/api/subscribers/${id}/${path}`;
  const everything = await f.apiUser(
    "tabs-on-a",
    ["subscribers:get", "sequences:get", "sends:get"],
    onA,
  );
  for (const path of ["subscriber-events", "enrollments", "sends"]) {
    const own = await everything(tab(shown.id, path));
    expect(own.status).toBe(200);
    expect(own.body.data.total).toBeGreaterThan(0);
    const other = await everything(tab(hidden.id, path));
    expect(other.status).toBe(403);
    expect(JSON.stringify(other.body)).not.toContain("hidden@example.test");
  }

  const subscribersOnly = await f.apiUser("subscribers-on-a", ["subscribers:get"], onA);
  expect((await subscribersOnly(tab(shown.id, "subscriber-events"))).status).toBe(200);
  expect((await subscribersOnly(tab(shown.id, "enrollments"))).status).toBe(403);
  expect((await subscribersOnly(tab(shown.id, "sends"))).status).toBe(403);

  // The record's own permission without the subscriber's is not enough, even with every list.
  const recordsOnly = await f.apiUser("records-all-lists", [
    "sequences:get",
    "sends:get",
    "lists:get_all",
  ]);
  for (const path of ["subscriber-events", "enrollments", "sends"])
    expect((await recordsOnly(tab(shown.id, path))).status).toBe(403);
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
