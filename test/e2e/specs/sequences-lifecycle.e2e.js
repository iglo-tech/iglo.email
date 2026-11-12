// Sequence depth (docs/design/13-e2e-coverage.md, E7): what a sequence does over its life, in real
// time against the compiled executable. The scheduler ticks every 15 s (src/scheduler/scheduler.ts),
// so every wait for a send is bounded by a tick and every "nothing is sent" check waits past a due
// time and two ticks. Each test makes its own uniquely named sequences, templates and subscribers,
// and asserts on the sink, the API or the explorer. `sequences.e2e.js` covers the screens.
import { expect } from "@playwright/test";
import { startSink } from "../../tx/sink.ts";
import { api, ok, requestAdmin, signIn, test, unique } from "../helpers.js";

// The scheduler's tick (src/scheduler/scheduler.ts, SCHEDULER_INTERVAL_MS).
const TICK_MS = 15_000;
const FINISH = { timeout: 60_000 };

// Settings and the SMTP server this file changed. `afterEach` puts them back through the request
// fixture, since a test that timed out has closed its page by then.
let changed = {};
let sinks = [];

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test.afterEach(async ({ request }) => {
  for (const sink of sinks.splice(0)) await sink.close();
  const pending = changed;
  changed = {};
  if (Object.keys(pending).length === 0) return;
  const call = await requestAdmin(request);
  const failures = [];
  for (const [key, value] of Object.entries(pending)) {
    try {
      const response = await call(`/api/settings/${key}`, "PUT", value);
      if (response.status !== 200) failures.push(`${key} answered ${response.status}`);
    } catch (error) {
      failures.push(`${key}: ${error.message}`);
    }
  }
  expect(failures, "restoring settings").toEqual([]);
});

async function change(page, key, value) {
  if (!(key in changed)) changed[key] = (await ok(page, "/api/settings"))[key];
  await ok(page, `/api/settings/${key}`, "PUT", value);
}

const template = (page, subject = unique("Lifecycle subject")) =>
  ok(page, "/api/templates", "POST", {
    name: unique("lifecycle-tx"),
    type: "tx",
    subject,
    body: "<p>{{ subscriber.name }}</p>",
  });

// A marketing step's template is a transactional one with the unsubscribe link a marketing mail has.
const marketingTemplate = (page) =>
  ok(page, "/api/templates", "POST", {
    name: unique("lifecycle-marketing"),
    type: "tx",
    subject: unique("Lifecycle marketing"),
    body: '<p>News.</p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>',
  });

const sequence = (page, definition) =>
  ok(page, "/api/sequences", "POST", {
    name: unique("Lifecycle sequence"),
    status: "active",
    trigger: { event: unique("evt") },
    ...definition,
  });

const subscriber = (page, extra = {}) =>
  ok(page, "/api/subscribers", "POST", {
    email: `${unique("life")}@example.com`,
    name: "Lifecycle Reader",
    status: "enabled",
    lists: [],
    ...extra,
  });

// An event for a subscriber by address: the API's own answer, with the enrollments it started.
async function fire(page, email, name, data = {}) {
  const made = await api(page, "/api/subscriber-events", "POST", {
    subscriber: { email },
    name,
    data,
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return made.body.data.enrollments;
}

const enrollment = (page, id) => ok(page, `/api/enrollments/${id}`);

// The subjects of the mails the sink holds for one address, right now.
async function subjectsTo(address) {
  const response = await fetch(`${process.env.E2E_MAIL}?to=${encodeURIComponent(address)}`);
  return (await response.json()).map((mail) => mail.subject);
}

// Waits until a mail with `subject` reached `address`. A send waits for the scheduler's next tick.
async function arrived(address, subject, timeout = 30_000) {
  await expect(async () => {
    expect(await subjectsTo(address)).toContain(subject);
  }).toPass({ timeout });
}

// Waits past a due time and two scheduler ticks after it, so the scheduler has run twice since.
async function pastDueAndTwoTicks(dueAt) {
  const until = Date.parse(dueAt) + 2 * TICK_MS;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now())));
}

test("re-entry: never stays out after a run, after_exit waits for the exit, always replaces", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const tx = await template(page);
  const evt = unique("evt");
  const stop = unique("stop");
  const steps = [{ wait: "P1D", kind: "transactional", template_id: tx.id }];
  const never = await sequence(page, {
    trigger: { event: evt },
    reentry: "never",
    exit_on: [stop],
    steps,
  });
  const after = await sequence(page, {
    trigger: { event: evt },
    reentry: "after_exit",
    exit_on: [stop],
    steps,
  });
  const always = await sequence(page, { trigger: { event: evt }, reentry: "always", steps });
  const who = await subscriber(page);
  const sequenceIDs = (rows) => rows.map((row) => row.sequence_id);

  // The first event starts all three.
  const first = await fire(page, who.email, evt);
  expect(sequenceIDs(first.started)).toEqual([never.id, after.id, always.id]);

  // A second event: `always` replaces its running enrollment; the other two keep theirs.
  const second = await fire(page, who.email, evt);
  expect(sequenceIDs(second.started)).toEqual([always.id]);
  expect(sequenceIDs(second.ended)).toEqual([always.id]);
  const replaced = first.started.find((row) => row.sequence_id === always.id);
  expect((await enrollment(page, replaced.id)).status).toBe("exited");

  // Manual enrolls: `never` and `after_exit` both refuse while the person is enrolled.
  for (const refused of [never, after]) {
    const answer = await api(page, "/api/enrollments", "POST", {
      sequence_id: refused.id,
      subscriber_id: who.id,
    });
    expect(answer.status).toBe(409);
  }

  // Leaving by an exit event ends the `never` and `after_exit` runs, and no others.
  const left = await fire(page, who.email, stop);
  expect(sequenceIDs(left.ended).sort((a, b) => a - b)).toEqual([never.id, after.id]);

  // After the exit: `never` still refuses for good, `after_exit` starts again, `always` replaces.
  const third = await fire(page, who.email, evt);
  expect(sequenceIDs(third.started)).toEqual([after.id, always.id]);
  expect(sequenceIDs(third.ended)).toEqual([always.id]);
  const again = await api(page, "/api/enrollments", "POST", {
    sequence_id: never.id,
    subscriber_id: who.id,
  });
  expect(again.status).toBe(409);
});

test("an event trigger with a PT0S first step mails the reader within one scheduler tick", async ({
  page,
}) => {
  const subject = unique("Instant subject");
  const tx = await template(page, subject);
  const evt = unique("evt");
  await sequence(page, {
    trigger: { event: evt },
    steps: [{ wait: "PT0S", kind: "transactional", template_id: tx.id }],
  });
  const email = `${unique("instant")}@example.com`;
  const started = Date.now();
  const rows = await fire(page, email, evt);
  expect(rows.started).toHaveLength(1);
  await arrived(email, subject, TICK_MS);
  expect(Date.now() - started).toBeLessThan(TICK_MS + 5_000);
});

test("a trigger with a where clause enrolls only the events whose data matches", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const subject = unique("Pro subject");
  const tx = await template(page, subject);
  const evt = unique("evt");
  await sequence(page, {
    trigger: { event: evt, where: { "data.plan": "pro" } },
    steps: [{ wait: "PT0S", kind: "transactional", template_id: tx.id }],
  });
  const who = await subscriber(page);
  const free = await fire(page, who.email, evt, { plan: "free" });
  expect(free.started).toEqual([]);
  const pro = await fire(page, who.email, evt, { plan: "pro" });
  expect(pro.started).toHaveLength(1);

  await arrived(who.email, subject);
  // The free event made no enrollment, so the one matching event is the only mail and the only run.
  expect(await subjectsTo(who.email)).toEqual([subject]);
  const listed = await ok(page, `/api/enrollments?subscriber_id=${who.id}`);
  expect(listed.total).toBe(1);
});

test("a paused sequence sends nothing when a step falls due, and sends once it is active again", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const subject = unique("Paused subject");
  const tx = await template(page, subject);
  const evt = unique("evt");
  const seq = await sequence(page, {
    trigger: { event: evt },
    steps: [{ wait: "PT5S", kind: "transactional", template_id: tx.id }],
  });
  const who = await subscriber(page);
  const [started] = (await fire(page, who.email, evt)).started;
  const due = (await enrollment(page, started.id)).due_at;
  expect(due).toBeTruthy();

  await ok(page, `/api/sequences/${seq.id}/status`, "PUT", { status: "paused" });
  await pastDueAndTwoTicks(due);
  expect(await subjectsTo(who.email)).toEqual([]);
  expect((await enrollment(page, started.id)).status).toBe("active");

  await ok(page, `/api/sequences/${seq.id}/status`, "PUT", { status: "active" });
  await arrived(who.email, subject);
  expect(await subjectsTo(who.email)).toEqual([subject]);
});

test("archiving a sequence exits its running enrollments and refuses new ones; nothing more sends", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const subject = unique("Archived subject");
  const tx = await template(page, subject);
  const evt = unique("evt");
  const seq = await sequence(page, {
    trigger: { event: evt },
    steps: [{ wait: "PT5S", kind: "transactional", template_id: tx.id }],
  });
  const who = await subscriber(page);
  const [started] = (await fire(page, who.email, evt)).started;
  const due = (await enrollment(page, started.id)).due_at;

  await ok(page, `/api/sequences/${seq.id}/status`, "PUT", { status: "archived" });
  const exited = await enrollment(page, started.id);
  expect(exited).toMatchObject({ status: "exited", exit_reason: "sequence_archived" });

  // A new trigger starts nothing, and a manual enroll is refused as not active.
  expect((await fire(page, who.email, evt)).started).toEqual([]);
  const manual = await api(page, "/api/enrollments", "POST", {
    sequence_id: seq.id,
    subscriber_id: who.id,
  });
  expect(manual.status).toBe(409);

  await pastDueAndTwoTicks(due);
  expect(await subjectsTo(who.email)).toEqual([]);
});

test("a step whose condition is false is skipped when on_false is skip, and the next step sends", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const first = await template(page, unique("First"));
  const skipped = await template(page, unique("Skipped"));
  const last = await template(page, unique("Last"));
  const evt = unique("evt");
  await sequence(page, {
    trigger: { event: evt },
    steps: [
      { wait: "PT0S", kind: "transactional", template_id: first.id },
      {
        wait: "PT3S",
        kind: "transactional",
        template_id: skipped.id,
        condition: { attr: "tier", op: "eq", value: "gold" },
        on_false: "skip",
      },
      { wait: "PT0S", kind: "transactional", template_id: last.id },
    ],
  });
  const who = await subscriber(page, { attribs: { tier: "silver" } });
  const [started] = (await fire(page, who.email, evt)).started;

  await expect
    .poll(async () => (await enrollment(page, started.id)).status, FINISH)
    .toBe("completed");
  expect((await subjectsTo(who.email)).sort()).toEqual([first.subject, last.subject].sort());
});

test("a step whose condition is false exits the enrollment when on_false is exit, and nothing after it sends", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const first = await template(page, unique("First"));
  const gated = await template(page, unique("Gated"));
  const last = await template(page, unique("Last"));
  const evt = unique("evt");
  await sequence(page, {
    trigger: { event: evt },
    steps: [
      { wait: "PT0S", kind: "transactional", template_id: first.id },
      {
        wait: "PT3S",
        kind: "transactional",
        template_id: gated.id,
        condition: { attr: "tier", op: "eq", value: "gold" },
        on_false: "exit",
      },
      { wait: "PT0S", kind: "transactional", template_id: last.id },
    ],
  });
  const who = await subscriber(page, { attribs: { tier: "silver" } });
  const [started] = (await fire(page, who.email, evt)).started;

  await expect.poll(async () => (await enrollment(page, started.id)).status, FINISH).toBe("exited");
  expect(await enrollment(page, started.id)).toMatchObject({ exit_reason: "condition" });
  // Exited before the last step was ever due: its mail never comes, now or later.
  expect(await subjectsTo(who.email)).toEqual([first.subject]);
});

test("a changed wait applied through the reschedule endpoint moves a waiting enrollment, which then sends", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const subject = unique("Rescheduled subject");
  const tx = await template(page, subject);
  const seq = await sequence(page, {
    reentry: "always",
    steps: [{ wait: "P1D", kind: "transactional", template_id: tx.id }],
  });
  const who = await subscriber(page);
  const made = await api(page, "/api/enrollments", "POST", {
    sequence_id: seq.id,
    subscriber_id: who.id,
  });
  expect(made.status).toBe(200);
  const enrolled = made.body.data;

  const step = (await ok(page, `/api/sequences/${seq.id}`)).steps[0];
  const saved = await api(page, `/api/sequences/${seq.id}`, "PUT", {
    name: unique("Rescheduled sequence"),
    status: "active",
    trigger: { event: seq.trigger.event },
    reentry: "always",
    steps: [{ ...step, wait: "PT5S" }],
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  // Saving changes nothing a waiting enrollment has; the reschedule endpoint moves it.
  expect((await enrollment(page, enrolled.id)).due_at).toBe(enrolled.due_at);

  const moved = await api(page, `/api/sequences/${seq.id}/steps/${step.id}/reschedule`, "POST");
  expect(moved.body.data).toEqual({ changed: 1 });
  const after = await enrollment(page, enrolled.id);
  // Counted from the enrollment's start, as the new wait says: five seconds, not a day.
  expect(Date.parse(after.due_at) - Date.parse(enrolled.created_at)).toBe(5_000);
  await arrived(who.email, subject);
});

test("the timeline shows a sent step, a skipped step and a failed step", async ({ page }) => {
  test.setTimeout(120_000);
  // The stack's own sink takes every message, so a refusal needs a sink of this file's own, which
  // refuses one recipient with a 550: a proven rejection, as operations.e2e.js does for its pause.
  const sink = await startSink({ reject: (to) => to.startsWith("refused-") });
  sinks.push(sink);
  const [server] = (await ok(page, "/api/settings")).smtp;
  await change(page, "smtp", [{ ...server, port: sink.port }]);

  const list = await ok(page, "/api/lists", "POST", {
    name: unique("Lifecycle audience"),
    type: "public",
    optin: "single",
  });
  const marketing = await marketingTemplate(page);
  const tx = await template(page);
  // Two marketing steps to one reader: the second is inside the frequency cap, so `skip` records it.
  const capped = await sequence(page, {
    list_id: list.id,
    steps: [
      { wait: "PT0S", kind: "marketing", template_id: marketing.id },
      { wait: "PT0S", kind: "marketing", template_id: marketing.id, cap_policy: "skip" },
      { wait: "PT0S", kind: "transactional", template_id: tx.id },
    ],
  });
  const reader = await subscriber(page, { lists: [list.id] });
  const sent = await api(page, "/api/enrollments", "POST", {
    sequence_id: capped.id,
    subscriber_id: reader.id,
  });
  expect(sent.status).toBe(200);

  const refusedSeq = await sequence(page, {
    steps: [{ wait: "PT0S", kind: "transactional", template_id: tx.id }],
  });
  const refused = await subscriber(page, { email: `refused-${unique("life")}@example.com` });
  const failed = await api(page, "/api/enrollments", "POST", {
    sequence_id: refusedSeq.id,
    subscriber_id: refused.id,
  });
  expect(failed.status).toBe(200);

  // The step entries of an enrollment's timeline: the sends, in the order they were recorded.
  const stepEntries = async (id) =>
    (await ok(page, `/api/enrollments/${id}/timeline`)).entries
      .filter((entry) => entry.type === "step")
      .map((entry) => [entry.decision, entry.reason ?? null]);
  // A send is recorded as `sending` before it ends, so the poll waits for the final decisions.
  await expect
    .poll(() => stepEntries(sent.body.data.id), FINISH)
    .toEqual([
      ["sent", null],
      ["skipped", "frequency_cap"],
      ["sent", null],
    ]);
  await expect.poll(() => stepEntries(failed.body.data.id), FINISH).toEqual([["failed", null]]);

  // The page shows the same three step entries, and the refused one as failed.
  await page.goto(`/admin/sequences/enrollments/${sent.body.data.id}`);
  const steps = page.locator('[data-testid="timeline-entry"][data-type="step"]');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText("sent");
  await expect(steps.nth(1)).toContainText("skipped (frequency_cap)");
  await expect(steps.nth(2)).toContainText("sent");
  await page.goto(`/admin/sequences/enrollments/${failed.body.data.id}`);
  await expect(page.locator('[data-testid="timeline-entry"][data-type="step"]')).toContainText(
    "failed",
  );
});
