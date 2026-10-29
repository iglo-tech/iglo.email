// The sequence scheduler from docs/design/05-sequences.md (Scheduler, Template data) and
// 04-sending.md (Outbox, Unsubscribe, Frequency cap), observed through the events,
// sequences, enrollments, sends and unsubscribe HTTP APIs and the SMTP sink, with time
// advanced on the injected clock.
import { afterEach, expect, test } from "bun:test";
import {
  day,
  hour,
  minute,
  schedulerFixture,
  type SchedulerFixture,
} from "@/test/scheduler/fixture";

const fixtures: SchedulerFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await schedulerFixture();
  fixtures.push(f);
  return f;
}

function decoded(data: string) {
  const at = data.indexOf("\r\n\r\n");
  const headers = data.slice(0, at).replace(/\r\n[ \t]+/g, " ");
  const body = data
    .slice(at + 4)
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const header = (name: string) =>
    new RegExp(`^${name}: (.*)$`, "mi").exec(headers)?.[1]?.trim() ?? null;
  return { headers, body, header };
}
const tx = (template: number, extra: object = {}) => ({
  wait: "PT0S",
  kind: "transactional",
  template_id: template,
  ...extra,
});
const mk = (template: number, extra: object = {}) => ({
  wait: "PT0S",
  kind: "marketing",
  template_id: template,
  ...extra,
});
const iso = (f: SchedulerFixture, plus = 0) =>
  new Date(f.clock.now().getTime() + plus).toISOString();
async function sendsOf(f: SchedulerFixture, enrollment: number) {
  return (await f.sendLog()).filter((s) => s.enrollment_id === enrollment);
}
/** Wait until `count` messages arrived and the outbox journaled every outcome. */
async function delivered(f: SchedulerFixture, count: number) {
  await f.until(
    async () =>
      f.sink.messages.length >= count &&
      (await f.sendLog()).every((s) => s.status !== "queued" && s.status !== "sending"),
    `${count} messages`,
  );
}

test("a due-now enrollment is sent promptly with the template data, then advances and completes", async () => {
  const f = await open();
  const template = await f.template(
    "<p>{{ subscriber.name }}|{{ subscriber.email }}|{{ subscriber.external_id }}|" +
      "{{ subscriber.attribs.plan }}|{{ subscriber.uuid }}|{{ trigger.name }}|" +
      "{{ trigger.data.price }}|{{ trigger.occurred_at }}|{{ sequence.name }}|{{ sequence.id }}|" +
      "{{ step.id }}|[{{ unsubscribe_url }}]</p>",
    "Hi {{ subscriber.name }} from {{ sequence.name }}",
  );
  const seq = await f.sequence({
    steps: [tx(template), tx(template, { wait: "P3D" })],
  });
  const occurred = iso(f, -minute);
  const r = await f.event("ana@example.test", "order_paid", {
    subscriber: {
      email: "ana@example.test",
      name: "Ana",
      external_id: "u_1",
      attribs: { plan: "subscription" },
    },
    data: { price: 79 },
    occurred_at: occurred,
  });
  const id = r.enrollments.started[0]!.id;
  // No clock advance: the event wakes the scheduler.
  await delivered(f, 1);
  const uuid = (await f.json(`/api/subscribers/${r.subscriber_id}`)).body.data.uuid;
  const mail = decoded(f.sink.messages[0]!.data);
  expect(mail.header("Subject")).toBe("Hi Ana from Onboarding");
  expect(mail.body).toContain(
    `<p>Ana|ana@example.test|u_1|subscription|${uuid}|order_paid|79|${occurred}|Onboarding|${seq.id}|${seq.steps[0]!.id}|[]</p>`,
  );
  expect(mail.header("List-Unsubscribe")).toBeNull();
  expect(f.sink.messages[0]!.to).toEqual(["ana@example.test"]);

  const first = (await sendsOf(f, id))[0]!;
  expect(first).toMatchObject({
    source: "sequence",
    kind: "transactional",
    status: "sent",
    step_id: seq.steps[0]!.id,
    template_id: template,
    subscriber_id: r.subscriber_id,
  });
  expect(await f.enrollment(id)).toMatchObject({
    status: "active",
    step_id: seq.steps[1]!.id,
    due_at: iso(f, 3 * day),
  });

  // Not due yet: a pass a little early sends nothing.
  await f.pass(3 * day - minute);
  expect(f.sink.messages).toHaveLength(1);
  await f.pass(minute);
  await delivered(f, 2);
  expect(await f.enrollment(id)).toMatchObject({
    status: "completed",
    step_id: null,
    due_at: null,
    exit_reason: null,
  });
  expect((await sendsOf(f, id)).map((s) => [s.step_id, s.status])).toEqual([
    [seq.steps[0]!.id, "sent"],
    [seq.steps[1]!.id, "sent"],
  ]);
  expect(f.errors.filter((e) => e instanceof Error)).toEqual([]);
});

test("a manual enroll due now is processed promptly", async () => {
  const f = await open();
  const template = await f.template();
  const seq = await f.sequence({ steps: [tx(template)] });
  const subscriber = await f.subscriber("manual@example.test");
  const created = await f.json("/api/enrollments", "POST", {
    sequence_id: seq.id,
    subscriber_id: subscriber,
  });
  expect(created.status).toBe(200);
  await delivered(f, 1);
  await f.until(
    async () => (await f.enrollment(created.body.data.id)).status === "completed",
    "completion",
  );
});

test("a paused sequence releases the claim and runs when resumed, subject to max_late", async () => {
  const f = await open();
  const template = await f.template();
  const seq = await f.sequence({
    steps: [tx(template, { wait: "PT1H" }), tx(template, { wait: "PT1H", max_late: "PT2H" })],
  });
  const id = (await f.event("p@example.test")).enrollments.started[0]!.id;
  expect(
    (await f.json(`/api/sequences/${seq.id}/status`, "PUT", { status: "paused" })).status,
  ).toBe(200);
  await f.pass(hour);
  await f.pass(10 * minute);
  expect(f.sink.messages).toHaveLength(0);
  expect(await sendsOf(f, id)).toEqual([]);
  expect(await f.enrollment(id)).toMatchObject({ status: "active", step_id: seq.steps[0]!.id });

  // Resumed: transactional steps have no default max_late, so the late step still sends.
  await f.json(`/api/sequences/${seq.id}/status`, "PUT", { status: "active" });
  await f.pass();
  await delivered(f, 1);
  expect(await f.enrollment(id)).toMatchObject({ step_id: seq.steps[1]!.id, due_at: iso(f, hour) });

  // Paused past the step's max_late: recorded as a late skip on resume, then completed.
  await f.json(`/api/sequences/${seq.id}/status`, "PUT", { status: "paused" });
  await f.pass(4 * hour);
  await f.json(`/api/sequences/${seq.id}/status`, "PUT", { status: "active" });
  await f.pass();
  expect((await sendsOf(f, id)).map((s) => [s.status, s.skip_reason])).toEqual([
    ["sent", null],
    ["skipped", "late"],
  ]);
  expect((await f.enrollment(id)).status).toBe("completed");
  expect(f.sink.messages).toHaveLength(1);
});

test("an archived sequence or a blocklisted subscriber found at run time cancels the enrollment", async () => {
  const f = await open();
  const template = await f.template();
  const seq = await f.sequence({ steps: [tx(template, { wait: "PT1H" })] });
  const other = await f.sequence({
    trigger: { event: "signup" },
    steps: [tx(template, { wait: "PT1H" })],
  });
  const archived = (await f.event("a@example.test")).enrollments.started[0]!.id;
  const blocked = (await f.event("b@example.test", "signup")).enrollments.started[0]!.id;
  // The archive and blocklist APIs end enrollments themselves; these states model a change
  // that raced the scheduler's claim (written below the API, without its effects).
  f.db.run("UPDATE sequences SET status = 'archived' WHERE id = ?", [seq.id]);
  f.db.run("UPDATE subscribers SET status = 'blocklisted' WHERE email = 'b@example.test'");
  await f.pass(hour);
  expect(await f.enrollment(archived)).toMatchObject({
    status: "canceled",
    exit_reason: "sequence_archived",
    step_id: null,
  });
  expect(await f.enrollment(blocked)).toMatchObject({
    status: "canceled",
    exit_reason: "blocklisted",
  });
  expect(await f.sendLog()).toEqual([]);
  expect(other.id).toBeGreaterThan(0);
});

test("a deleted step advances to the next active step without waiting again", async () => {
  const f = await open();
  const template = await f.template();
  const definition = (steps: object[]) => ({
    name: "Onboarding",
    status: "active",
    trigger: { event: "order_paid" },
    reentry: "always",
    steps,
  });
  const seq = await f.sequence({
    steps: [tx(template), tx(template, { wait: "P1D" }), tx(template, { wait: "P5D" })],
  });
  const id = (await f.event("d@example.test")).enrollments.started[0]!.id;
  await delivered(f, 1);
  expect((await f.enrollment(id)).step_id).toBe(seq.steps[1]!.id);
  // Remove the step the enrollment waits for; keep the others by ID.
  const [one, , three] = seq.steps as { id: number }[];
  const edited = await f.json(
    `/api/sequences/${seq.id}`,
    "PUT",
    definition([tx(template, { id: one!.id }), tx(template, { id: three!.id, wait: "P5D" })]),
  );
  expect(edited.status).toBe(200);
  await f.pass(day);
  await delivered(f, 2);
  const sends = await sendsOf(f, id);
  expect(sends.map((s) => s.step_id)).toEqual([one!.id, three!.id]);
  expect((await f.enrollment(id)).status).toBe("completed");
});

test("a step later than max_late is a late skip; marketing defaults to P2D", async () => {
  const f = await open();
  const template = await f.template();
  const news = await f.list("news");
  await f.subscriber("late@example.test", { lists: [news] });
  const seq = await f.sequence({
    list_id: news,
    steps: [
      tx(template, { wait: "PT1H", max_late: "PT30M" }),
      mk(template, { wait: "PT1H" }),
      tx(template, { wait: "PT1H" }),
    ],
  });
  const id = (await f.event("late@example.test")).enrollments.started[0]!.id;
  // Exactly at due + max_late is still on time; the server was down far longer.
  await f.pass(hour + 31 * minute);
  expect((await sendsOf(f, id)).map((s) => [s.step_id, s.status, s.skip_reason])).toEqual([
    [seq.steps[0]!.id, "skipped", "late"],
  ]);
  expect(await f.enrollment(id)).toMatchObject({
    step_id: seq.steps[1]!.id,
    due_at: iso(f, hour),
  });
  // The marketing step defaults to P2D; transactional has no default limit.
  await f.pass(hour + 2 * day + minute);
  await f.pass(hour + 30 * day);
  await delivered(f, 1);
  expect((await sendsOf(f, id)).map((s) => [s.status, s.skip_reason])).toEqual([
    ["skipped", "late"],
    ["skipped", "late"],
    ["sent", null],
  ]);
  expect(f.sink.messages).toHaveLength(1);
});

test("marketing without permission on list_id ends the enrollment before the condition runs", async () => {
  const f = await open();
  const template = await f.template();
  const news = await f.list("news");
  const double = await f.list("double", "double");
  const seq = await f.sequence({
    list_id: news,
    steps: [mk(template, { condition: { attr: "plan", op: "eq", value: "never" } })],
  });
  const strangers = (await f.event("stranger@example.test")).enrollments.started[0]!.id;
  const left = await f.subscriber("left@example.test", { lists: [news] });
  await f.json("/api/subscribers/lists", "PUT", {
    ids: [left],
    action: "unsubscribe",
    target_list_ids: [news],
  });
  const leftEnrollment = (await f.event("left@example.test")).enrollments.started[0]!.id;
  const doubleSeq = await f.sequence({
    trigger: { event: "signup" },
    list_id: double,
    steps: [mk(template)],
  });
  await f.subscriber("pending@example.test", { lists: [double] });
  const pending = (await f.event("pending@example.test", "signup")).enrollments.started[0]!.id;
  await f.pass();
  for (const id of [strangers, leftEnrollment, pending])
    expect(await f.enrollment(id)).toMatchObject({
      status: "exited",
      exit_reason: "unsubscribed",
    });
  expect(await f.sendLog()).toEqual([]);
  expect(seq.id).not.toBe(doubleSeq.id);
});

test("a false condition follows on_false; a true one sends", async () => {
  const f = await open();
  const template = await f.template();
  const seq = await f.sequence({
    steps: [
      tx(template, {
        wait: "PT1M",
        condition: { not: { event: "download_finished", since: "trigger" } },
        on_false: "skip",
      }),
      tx(template, {
        wait: "P1D",
        condition: { attr: "plan", op: "eq", value: "subscription" },
      }),
      tx(template, { wait: "P1D" }),
    ],
  });
  // The download after the trigger makes step 1 false (skip); the plan makes step 2 true.
  const first = await f.json("/api/subscriber-events", "POST", {
    subscriber: { email: "c@example.test", attribs: { plan: "subscription" } },
    name: "order_paid",
  });
  const id = first.body.data.enrollments.started[0].id;
  f.clock.advance(1000);
  await f.event("c@example.test", "download_finished");
  await f.pass(minute - 1000);
  expect(await sendsOf(f, id)).toEqual([]);
  expect(await f.enrollment(id)).toMatchObject({
    step_id: seq.steps[1]!.id,
    due_at: iso(f, day),
  });
  await f.pass(day);
  await delivered(f, 1);
  expect((await sendsOf(f, id)).map((s) => s.step_id)).toEqual([seq.steps[1]!.id]);

  // Another subscriber without the plan: step 2 is false with the default on_false (exit).
  const other = (await f.event("o@example.test")).enrollments.started[0]!.id;
  await f.pass(minute);
  expect((await f.enrollment(other)).step_id).toBe(seq.steps[1]!.id);
  await f.pass(day);
  expect(await f.enrollment(other)).toMatchObject({
    status: "exited",
    exit_reason: "condition",
  });
  expect((await sendsOf(f, other)).map((s) => s.step_id)).toEqual([seq.steps[0]!.id]);
});

test("a condition error releases the claim with a bounded backoff, logs, and never sends", async () => {
  const f = await open();
  const template = await f.template();
  const seq = await f.sequence({
    steps: [tx(template, { condition: { sql: "abs(-9223372036854775807 - subscribers.id) > 0" } })],
  });
  const id = (await f.event("err@example.test")).enrollments.started[0]!.id;
  await f.until(() => f.errors.length > 0, "logged condition error");
  expect(String(f.errors[0])).toContain(`enrollment ${id}`);
  expect(String(f.errors[0])).not.toContain("err@example.test");
  const logged = f.errors.length;
  // Within the backoff nothing is retried.
  await f.pass();
  expect(f.errors.length).toBe(logged);
  // After it, the condition runs again and fails again.
  await f.pass(minute);
  await f.until(() => f.errors.length > logged, "retried condition");
  expect(await sendsOf(f, id)).toEqual([]);
  expect(await f.enrollment(id)).toMatchObject({ status: "active", step_id: seq.steps[0]!.id });
  expect(f.sink.messages).toHaveLength(0);
});

test("the frequency cap defers to the earliest allowed time, or records a skip", async () => {
  const f = await open();
  f.marketing.minInterval = "P7D";
  const template = await f.template();
  const news = await f.list("news");
  await f.subscriber("cap@example.test", { lists: [news] });
  const seq = await f.sequence({
    list_id: news,
    steps: [
      mk(template),
      mk(template, { wait: "P1D" }),
      mk(template, { wait: "PT1H", cap_policy: "skip" }),
    ],
  });
  const sentAt = f.clock.now().getTime();
  const id = (await f.event("cap@example.test")).enrollments.started[0]!.id;
  await delivered(f, 1);
  const first = (await sendsOf(f, id))[0]!;
  expect(first.status).toBe("sent");
  await f.pass(day);
  // defer: due_at moves to the first instant the 7-day window allows.
  expect(await f.enrollment(id)).toMatchObject({
    step_id: seq.steps[1]!.id,
    due_at: new Date(Date.parse(first.sent_at) + 7 * day).toISOString(),
  });
  expect(await sendsOf(f, id)).toHaveLength(1);
  expect(Date.parse(first.sent_at)).toBe(sentAt);
  await f.pass(6 * day - minute);
  expect(f.sink.messages).toHaveLength(1);
  await f.pass(minute);
  await delivered(f, 2);
  // skip: the next marketing step inside the window is a recorded skip.
  await f.pass(hour);
  expect((await sendsOf(f, id)).map((s) => [s.status, s.skip_reason])).toEqual([
    ["sent", null],
    ["sent", null],
    ["skipped", "frequency_cap"],
  ]);
  expect((await f.enrollment(id)).status).toBe("completed");
});

test("a step whose template was deleted records a skipped send, logs once, and advances", async () => {
  const f = await open();
  const keep = await f.template();
  const gone = await f.template("<p>gone</p>");
  const seq = await f.sequence({
    steps: [tx(gone, { wait: "PT1H" }), tx(keep, { wait: "PT1H" })],
  });
  const id = (await f.event("t@example.test")).enrollments.started[0]!.id;
  expect((await f.json(`/api/templates/${gone}`, "DELETE")).status).toBe(200);
  await f.pass(hour);
  expect(await sendsOf(f, id)).toMatchObject([
    {
      step_id: seq.steps[0]!.id,
      status: "skipped",
      skip_reason: "template_unavailable",
      template_id: null,
    },
  ]);
  expect(f.errors).toHaveLength(1);
  expect(String(f.errors[0])).toContain("template");
  await f.pass(hour);
  await delivered(f, 1);
  expect((await f.enrollment(id)).status).toBe("completed");
  expect(f.errors).toHaveLength(1);
});

test("a rendering failure is a recorded skipped send, not a crash", async () => {
  const f = await open();
  const bad = await f.template("{% for i in (1..100000000) %}xxxxxxxxxx{% endfor %}");
  const good = await f.template();
  const seq = await f.sequence({ steps: [tx(bad), tx(good, { wait: "PT1H" })] });
  const id = (await f.event("r@example.test")).enrollments.started[0]!.id;
  await f.pass();
  expect(await sendsOf(f, id)).toMatchObject([
    { step_id: seq.steps[0]!.id, status: "skipped", skip_reason: "render_failed" },
  ]);
  expect(f.errors).toHaveLength(1);
  await f.pass(hour);
  await delivered(f, 1);
  expect((await f.enrollment(id)).status).toBe("completed");
});

test("an existing send for the step is only advanced past, never sent twice", async () => {
  const f = await open();
  const template = await f.template();
  const seq = await f.sequence({
    steps: [tx(template, { wait: "PT1H" }), tx(template, { wait: "PT1H" })],
  });
  const r = await f.event("crash@example.test");
  const id = r.enrollments.started[0]!.id;
  // The state a crash between the send insert and the advance would leave behind.
  f.db.run(
    `INSERT INTO sends(uuid, source, kind, subscriber_id, to_email, template_id, enrollment_id, step_id, status, payload, created_at)
     VALUES (?, 'sequence', 'transactional', ?, 'crash@example.test', ?, ?, ?, 'sent', NULL, ?)`,
    [crypto.randomUUID(), r.subscriber_id, template, id, seq.steps[0]!.id, iso(f)],
  );
  await f.pass(hour);
  expect(f.sink.messages).toHaveLength(0);
  expect((await sendsOf(f, id)).map((s) => s.step_id)).toEqual([seq.steps[0]!.id]);
  expect(await f.enrollment(id)).toMatchObject({
    step_id: seq.steps[1]!.id,
    due_at: iso(f, hour),
  });
});

test("a live lease is not claimed again; an expired lease is", async () => {
  const f = await open();
  const template = await f.template();
  await f.sequence({ steps: [tx(template, { wait: "PT1H" })] });
  const id = (await f.event("lease@example.test")).enrollments.started[0]!.id;
  // Another scheduler instance holds the lease for five minutes from the due time.
  f.db.run("UPDATE enrollments SET claimed_until = ? WHERE id = ?", [
    iso(f, hour + 5 * minute),
    id,
  ]);
  await f.pass(hour);
  await f.pass(4 * minute);
  expect(await f.sendLog()).toEqual([]);
  await f.pass(2 * minute);
  await delivered(f, 1);
  expect((await f.enrollment(id)).status).toBe("completed");
  expect(await f.sendLog()).toHaveLength(1);
});

test("end to end: a transactional then a marketing step, with a working unsubscribe", async () => {
  const f = await open();
  const news = await f.list("news");
  const welcome = await f.template("<p>Welcome {{ subscriber.name }}</p>", "Welcome");
  const nudge = await f.template(
    '<p>Need a hand? <a href="{{ unsubscribe_url }}">unsubscribe</a> <a href="{{ \'https://example.test/help\' | track_link }}">help</a>{{ track_view }}</p>',
    "Need a hand?",
  );
  const subscriber = await f.subscriber("e2e@example.test", { lists: [news] });
  const seq = await f.sequence({
    list_id: news,
    steps: [tx(welcome), mk(nudge, { wait: "PT10M" })],
  });
  const id = (await f.event("e2e@example.test")).enrollments.started[0]!.id;
  await delivered(f, 1);
  expect(decoded(f.sink.messages[0]!.data).body).toContain("Welcome Ana");
  await f.pass(10 * minute);
  await delivered(f, 2);
  const marketing = (await sendsOf(f, id))[1]!;
  expect(marketing).toMatchObject({ kind: "marketing", list_id: news, status: "sent" });
  const uuid = (await f.json(`/api/subscribers/${subscriber}`)).body.data.uuid;
  const url = `http://fixture.test/m/${marketing.uuid}/unsubscribe/${uuid}`;
  const mail = decoded(f.sink.messages[1]!.data);
  expect(mail.body).toContain(`<a href="${url}">unsubscribe</a>`);
  expect(mail.body).toContain(`http://fixture.test/m/${marketing.uuid}/link/`);
  expect(mail.body).toContain(`http://fixture.test/m/${marketing.uuid}/px.png`);
  expect(mail.header("List-Unsubscribe")).toBe(`<${url}>`);
  expect(mail.header("List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
  expect((await f.enrollment(id)).status).toBe("completed");
  expect(seq.steps).toHaveLength(2);

  // RFC 8058 one-click unsubscribe from the received link.
  const response = await f.request(new URL(url).pathname, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  expect(response.status).toBe(200);
  const lists = (await f.json(`/api/subscribers/${subscriber}`)).body.data.lists;
  expect(lists).toMatchObject([{ id: news, subscription_status: "unsubscribed" }]);
});

test("a scheduler loop failure surfaces instead of leaving a dead loop", async () => {
  const f = await open();
  await f.pass();
  f.db.run("ALTER TABLE enrollments RENAME TO enrollments_unavailable");
  f.scheduler.wake();
  await expect(f.scheduler.done).rejects.toThrow();
  expect(f.errors.length).toBeGreaterThan(0);
  f.db.run("ALTER TABLE enrollments_unavailable RENAME TO enrollments");
});
