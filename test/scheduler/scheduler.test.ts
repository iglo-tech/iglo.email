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
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
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
      (await f.sendLog()).every(
        (s) => s.status !== "queued" && s.status !== "sending",
      ),
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
  const uuid = (await f.json(`/api/subscribers/${r.subscriber_id}`)).body.data
    .uuid;
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
    async () =>
      (await f.enrollment(created.body.data.id)).status === "completed",
    "completion",
  );
});

test("a paused sequence releases the claim and runs when resumed, subject to max_late", async () => {
  const f = await open();
  const template = await f.template();
  const seq = await f.sequence({
    steps: [
      tx(template, { wait: "PT1H" }),
      tx(template, { wait: "PT1H", max_late: "PT2H" }),
    ],
  });
  const id = (await f.event("p@example.test")).enrollments.started[0]!.id;
  expect(
    (
      await f.json(`/api/sequences/${seq.id}/status`, "PUT", {
        status: "paused",
      })
    ).status,
  ).toBe(200);
  await f.pass(hour);
  await f.pass(10 * minute);
  expect(f.sink.messages).toHaveLength(0);
  expect(await sendsOf(f, id)).toEqual([]);
  expect(await f.enrollment(id)).toMatchObject({
    status: "active",
    step_id: seq.steps[0]!.id,
  });

  // Resumed: transactional steps have no default max_late, so the late step still sends.
  await f.json(`/api/sequences/${seq.id}/status`, "PUT", { status: "active" });
  await f.pass();
  await delivered(f, 1);
  expect(await f.enrollment(id)).toMatchObject({
    step_id: seq.steps[1]!.id,
    due_at: iso(f, hour),
  });

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
  const blocked = (await f.event("b@example.test", "signup")).enrollments
    .started[0]!.id;
  // The archive and blocklist APIs end enrollments themselves; these states model a change
  // that raced the scheduler's claim (written below the API, without its effects).
  f.db.run("UPDATE sequences SET status = 'archived' WHERE id = ?", [seq.id]);
  f.db.run(
    "UPDATE subscribers SET status = 'blocklisted' WHERE email = 'b@example.test'",
  );
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
    steps: [
      tx(template),
      tx(template, { wait: "P1D" }),
      tx(template, { wait: "P5D" }),
    ],
  });
  const id = (await f.event("d@example.test")).enrollments.started[0]!.id;
  await delivered(f, 1);
  expect((await f.enrollment(id)).step_id).toBe(seq.steps[1]!.id);
  // Remove the step the enrollment waits for; keep the others by ID.
  const [one, , three] = seq.steps as { id: number }[];
  const edited = await f.json(
    `/api/sequences/${seq.id}`,
    "PUT",
    definition([
      tx(template, { id: one!.id }),
      tx(template, { id: three!.id, wait: "P5D" }),
    ]),
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
  expect(
    (await sendsOf(f, id)).map((s) => [s.step_id, s.status, s.skip_reason]),
  ).toEqual([[seq.steps[0]!.id, "skipped", "late"]]);
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
    steps: [
      mk(template, { condition: { attr: "plan", op: "eq", value: "never" } }),
    ],
  });
  const strangers = (await f.event("stranger@example.test")).enrollments
    .started[0]!.id;
  const left = await f.subscriber("left@example.test", { lists: [news] });
  await f.json("/api/subscribers/lists", "PUT", {
    ids: [left],
    action: "unsubscribe",
    target_list_ids: [news],
  });
  const leftEnrollment = (await f.event("left@example.test")).enrollments
    .started[0]!.id;
  const doubleSeq = await f.sequence({
    trigger: { event: "signup" },
    list_id: double,
    steps: [mk(template)],
  });
  await f.subscriber("pending@example.test", { lists: [double] });
  const pending = (await f.event("pending@example.test", "signup")).enrollments
    .started[0]!.id;
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
  expect((await sendsOf(f, id)).map((s) => s.step_id)).toEqual([
    seq.steps[1]!.id,
  ]);

  // Another subscriber without the plan: step 2 is false with the default on_false (exit).
  const other = (await f.event("o@example.test")).enrollments.started[0]!.id;
  await f.pass(minute);
  expect((await f.enrollment(other)).step_id).toBe(seq.steps[1]!.id);
  await f.pass(day);
  expect(await f.enrollment(other)).toMatchObject({
    status: "exited",
    exit_reason: "condition",
  });
  expect((await sendsOf(f, other)).map((s) => s.step_id)).toEqual([
    seq.steps[0]!.id,
  ]);
});

test("a condition error releases the claim with a bounded backoff, logs, and never sends", async () => {
  const f = await open();
  const template = await f.template();
  const seq = await f.sequence({
    steps: [
      tx(template, {
        condition: { sql: "abs(-9223372036854775807 - subscribers.id) > 0" },
      }),
    ],
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
  expect(await f.enrollment(id)).toMatchObject({
    status: "active",
    step_id: seq.steps[0]!.id,
  });
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
  const bad = await f.template(
    "{% for i in (1..100000000) %}xxxxxxxxxx{% endfor %}",
  );
  const good = await f.template();
  const seq = await f.sequence({
    steps: [tx(bad), tx(good, { wait: "PT1H" })],
  });
  const id = (await f.event("r@example.test")).enrollments.started[0]!.id;
  await f.pass();
  expect(await sendsOf(f, id)).toMatchObject([
    {
      step_id: seq.steps[0]!.id,
      status: "skipped",
      skip_reason: "render_failed",
    },
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
    [
      crypto.randomUUID(),
      r.subscriber_id,
      template,
      id,
      seq.steps[0]!.id,
      iso(f),
    ],
  );
  await f.pass(hour);
  expect(f.sink.messages).toHaveLength(0);
  expect((await sendsOf(f, id)).map((s) => s.step_id)).toEqual([
    seq.steps[0]!.id,
  ]);
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
  const welcome = await f.template(
    "<p>Welcome {{ subscriber.name }}</p>",
    "Welcome",
  );
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
  expect(marketing).toMatchObject({
    kind: "marketing",
    list_id: news,
    status: "sent",
  });
  const uuid = (await f.json(`/api/subscribers/${subscriber}`)).body.data.uuid;
  const url = `http://fixture.test/m/${marketing.uuid}/unsubscribe/${uuid}`;
  const mail = decoded(f.sink.messages[1]!.data);
  expect(mail.body).toContain(`<a href="${url}">unsubscribe</a>`);
  expect(mail.body).toContain(`http://fixture.test/m/${marketing.uuid}/link/`);
  expect(mail.body).toContain(`http://fixture.test/m/${marketing.uuid}/px.png`);
  expect(mail.header("List-Unsubscribe")).toBe(`<${url}>`);
  expect(mail.header("List-Unsubscribe-Post")).toBe(
    "List-Unsubscribe=One-Click",
  );
  expect((await f.enrollment(id)).status).toBe("completed");
  expect(seq.steps).toHaveLength(2);

  // RFC 8058 one-click unsubscribe from the received link.
  const response = await f.request(new URL(url).pathname, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  expect(response.status).toBe(200);
  const lists = (await f.json(`/api/subscribers/${subscriber}`)).body.data
    .lists;
  expect(lists).toMatchObject([
    { id: news, subscription_status: "unsubscribed" },
  ]);
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

// Races with the condition: `f.onCondition` acts while the scheduler awaits the evaluation,
// as an admin request arriving during a slow query would.
const always = { not: { event: "never_happens", since: "trigger" } };
const save = (
  f: SchedulerFixture,
  id: number,
  steps: object[],
  extra: object = {},
) =>
  f.json(`/api/sequences/${id}`, "PUT", {
    name: "Onboarding",
    status: "active",
    trigger: { event: "order_paid" },
    reentry: "always",
    steps,
    ...extra,
  });
/** Run `act` once, during the first condition evaluation, then evaluate normally. */
function during(f: SchedulerFixture, act: () => Promise<unknown> | unknown) {
  const state = { ran: false };
  f.onCondition = async (_, evaluate) => {
    if (!state.ran) {
      state.ran = true;
      await act();
    }
    return evaluate();
  };
  return state;
}

test("a template deleted while the condition runs is a skipped send without a template; the scheduler keeps running", async () => {
  const f = await open();
  const keep = await f.template();
  const gone = await f.template("<p>gone</p>");
  const seq = await f.sequence({
    steps: [
      tx(gone, { wait: "PT1H", condition: always }),
      tx(keep, { wait: "PT1H" }),
    ],
  });
  const id = (await f.event("race-template@example.test")).enrollments
    .started[0]!.id;
  const raced = during(f, async () => {
    expect((await f.json(`/api/templates/${gone}`, "DELETE")).status).toBe(200);
  });
  await f.pass(hour);
  expect(raced.ran).toBe(true);
  expect(f.stopped).toBe(false);
  expect(await sendsOf(f, id)).toMatchObject([
    {
      step_id: seq.steps[0]!.id,
      status: "skipped",
      skip_reason: "template_unavailable",
      template_id: null,
    },
  ]);
  expect(f.errors.filter((e) => String(e).includes("template"))).toHaveLength(
    1,
  );
  await f.pass(hour);
  await delivered(f, 1);
  expect((await f.enrollment(id)).status).toBe("completed");
  expect(f.stopped).toBe(false);
});

test("a failing decision is logged and released for a later retry, without stopping the scheduler", async () => {
  const f = await open();
  const template = await f.template();
  await f.sequence({
    steps: [tx(template, { wait: "PT1H", condition: always })],
  });
  const id = (await f.event("throws@example.test")).enrollments.started[0]!.id;
  let calls = 0;
  f.onCondition = async (_, evaluate) => {
    if (++calls === 1) throw new Error("evaluator crashed");
    return evaluate();
  };
  await f.pass(hour);
  expect(f.stopped).toBe(false);
  expect(calls).toBe(1);
  expect(f.errors.some((e) => String(e).includes(`enrollment ${id}`))).toBe(
    true,
  );
  expect(await sendsOf(f, id)).toEqual([]);
  // Released with a retry delay, not left leased for the full lease.
  await f.pass(minute);
  await delivered(f, 1);
  expect(calls).toBe(2);
  expect((await f.enrollment(id)).status).toBe("completed");
});

test("a pause during the condition releases the claim instead of sending; it runs when resumed", async () => {
  const f = await open();
  const template = await f.template();
  const seq = await f.sequence({
    steps: [tx(template, { wait: "PT1H", condition: always })],
  });
  const id = (await f.event("race-pause@example.test")).enrollments.started[0]!
    .id;
  const raced = during(f, async () => {
    const paused = await f.json(`/api/sequences/${seq.id}/status`, "PUT", {
      status: "paused",
    });
    expect(paused.status).toBe(200);
  });
  await f.pass(hour);
  await f.pass();
  expect(raced.ran).toBe(true);
  expect(await sendsOf(f, id)).toEqual([]);
  expect(f.sink.messages).toHaveLength(0);
  expect(await f.enrollment(id)).toMatchObject({
    status: "active",
    step_id: seq.steps[0]!.id,
  });

  await f.json(`/api/sequences/${seq.id}/status`, "PUT", { status: "active" });
  await f.pass();
  await delivered(f, 1);
  expect((await f.enrollment(id)).status).toBe("completed");
});

test("an archive during the condition ends the enrollment instead of sending", async () => {
  const f = await open();
  const template = await f.template();
  const seq = await f.sequence({
    steps: [tx(template, { wait: "PT1H", condition: always })],
  });
  const id = (await f.event("race-archive@example.test")).enrollments
    .started[0]!.id;
  // Written below the API (whose archive also exits enrollments): the scheduler's own check.
  during(f, () =>
    f.db.run("UPDATE sequences SET status = 'archived' WHERE id = ?", [seq.id]),
  );
  await f.pass(hour);
  expect(await f.enrollment(id)).toMatchObject({
    status: "canceled",
    exit_reason: "sequence_archived",
  });
  expect(await sendsOf(f, id)).toEqual([]);
  expect(f.sink.messages).toHaveLength(0);
});

test("an edit during the condition discards the stale decision and re-evaluates the current step", async () => {
  const f = await open();
  const before = await f.template("<p>before</p>");
  const after = await f.template("<p>after</p>");
  const seq = await f.sequence({
    steps: [
      tx(before, { wait: "PT1H", condition: always }),
      tx(before, { wait: "PT1H", condition: always }),
      tx(before, { wait: "PT1H" }),
    ],
  });
  const [one, two, three] = seq.steps as { id: number }[];
  const id = (await f.event("race-edit@example.test")).enrollments.started[0]!
    .id;

  // The step's template changes while its condition runs: the new template is sent.
  const changed = during(f, async () => {
    const r = await save(f, seq.id, [
      tx(after, { id: one!.id, wait: "PT1H", condition: always }),
      tx(before, { id: two!.id, wait: "PT1H", condition: always }),
      tx(before, { id: three!.id, wait: "PT1H" }),
    ]);
    expect(r.status).toBe(200);
  });
  await f.pass(hour);
  await delivered(f, 1);
  expect(changed.ran).toBe(true);
  expect(decoded(f.sink.messages[0]!.data).body).toContain("<p>after</p>");
  expect(await sendsOf(f, id)).toMatchObject([
    { step_id: one!.id, template_id: after },
  ]);

  // The step is deleted while its condition runs: it is not sent; the next step is.
  const deleted = during(f, async () => {
    const r = await save(f, seq.id, [
      tx(after, { id: one!.id, wait: "PT1H", condition: always }),
      tx(before, { id: three!.id, wait: "PT1H" }),
    ]);
    expect(r.status).toBe(200);
  });
  await f.pass(hour);
  await delivered(f, 2);
  expect(deleted.ran).toBe(true);
  expect((await sendsOf(f, id)).map((s) => s.step_id)).toEqual([
    one!.id,
    three!.id,
  ]);
  expect((await f.enrollment(id)).status).toBe("completed");
  expect(f.sink.messages).toHaveLength(2);
});

test("an enrollment waiting on a deleted step reaches the right next step after later saves", async () => {
  const f = await open();
  const template = await f.template();
  const step = (wait: string) => tx(template, { wait });
  type Case = {
    name: string;
    saves: (ids: number[]) => number[][];
    expected: number[];
  };
  // Steps A,B,C,D (indexes 0-3); A is sent and the enrollment waits on B. Each save lists the
  // kept steps by index, or -1 for a new step.
  const cases: Case[] = [
    {
      name: "delete B, then A",
      saves: () => [
        [0, 2, 3],
        [2, 3],
      ],
      expected: [0, 2, 3],
    },
    {
      name: "delete B, then C",
      saves: () => [
        [0, 2, 3],
        [0, 3],
      ],
      expected: [0, 3],
    },
    {
      name: "delete B and C, then A",
      saves: () => [[0, 3], [3]],
      expected: [0, 3],
    },
    {
      name: "delete B, then add one first",
      saves: () => [
        [0, 2, 3],
        [-1, 0, 2, 3],
      ],
      expected: [0, 2, 3],
    },
    {
      name: "delete B, then A, then D",
      saves: () => [[0, 2, 3], [2, 3], [2]],
      expected: [0, 2],
    },
    {
      name: "edit B, delete A, then B",
      saves: () => [
        [0, 1, 2, 3],
        [1, 2, 3],
        [2, 3],
      ],
      expected: [0, 2, 3],
    },
  ];
  for (const [n, c] of cases.entries()) {
    const event = `case_${n}`;
    const definition = { trigger: { event } };
    const seq = await f.sequence({
      ...definition,
      steps: [step("PT0S"), step("P1D"), step("P1D"), step("P1D")],
    });
    const ids = (seq.steps as { id: number }[]).map((s) => s.id);
    const id = (await f.event(`${event}@example.test`, event)).enrollments
      .started[0]!.id;
    await f.until(
      async () => (await f.enrollment(id)).step_id === ids[1],
      `${c.name}: A sent`,
    );
    for (const kept of c.saves(ids)) {
      // Each save at its own time, as an admin makes them.
      f.clock.advance(1000);
      const r = await save(
        f,
        seq.id,
        kept.map((i) =>
          i < 0 ? step("P1D") : tx(template, { id: ids[i], wait: "P1D" }),
        ),
        definition,
      );
      expect(r.status).toBe(200);
    }
    for (let i = 0; i < 4 && (await f.enrollment(id)).status === "active"; i++)
      await f.pass(day);
    const sent = (await sendsOf(f, id)).map((s) => ids.indexOf(s.step_id));
    expect({ name: c.name, sent }).toEqual({ name: c.name, sent: c.expected });
    expect((await f.enrollment(id)).status).toBe("completed");
  }
});

test("enrollments whose condition keeps failing do not starve healthy due work", async () => {
  const f = await open();
  const template = await f.template();
  const failing = await f.sequence({
    steps: [tx(template, { wait: "PT1H", condition: always })],
  });
  await f.sequence({
    trigger: { event: "signup" },
    steps: [tx(template, { wait: "PT1H", condition: always })],
  });
  const backlog = 1000;
  for (let i = 0; i < backlog; i++) await f.event(`fail-${i}@example.test`);
  const healthy = (await f.event("healthy@example.test", "signup")).enrollments
    .started[0]!.id;
  const first = (
    await f.json(`/api/enrollments?sequence_id=${failing.id}&per_page=1`)
  ).body.data.results[0] as { id: number; due_at: string };
  const healthySubscriber = (await f.enrollment(healthy))
    .subscriber_id as number;

  let evaluations = 0;
  let reachedAfter: number | null = null;
  f.onCondition = async (context, evaluate) => {
    if (Number(context.subscriberId) === healthySubscriber) {
      reachedAfter ??= evaluations;
      return evaluate();
    }
    evaluations++;
    // Each failing query uses its whole 10-second budget on the injected clock.
    f.clock.advance(10_000);
    return {
      ok: false,
      error: { kind: "timeout", message: "query timed out" },
    };
  };
  f.clock.advance(hour);
  f.scheduler.wake();
  await f.until(
    () => reachedAfter !== null || evaluations >= 3 * backlog,
    "healthy or bound",
  );
  // Each failing enrollment is tried at most once before the healthy one, due after them all.
  expect(reachedAfter).not.toBeNull();
  expect(reachedAfter!).toBeLessThanOrEqual(backlog);
  await delivered(f, 1);
  expect((await f.enrollment(healthy)).status).toBe("completed");
  // The retry delay leaves the original due time, which max_late measures from.
  expect((await f.enrollment(first.id)).due_at).toBe(first.due_at);
  f.onCondition = null;
}, 60_000);
