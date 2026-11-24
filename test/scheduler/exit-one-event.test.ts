// B118h: an enrollment's exit is shown on one event of the subscriber's Events tab, the one that
// would have ended it: the lowest-ID event with the exit's name and receive time among all of the
// subscriber's events, or, when the enrollment's trigger was received at the same time, whatever its
// name, the lowest after the trigger (docs/design/05-sequences.md#events-tab). Observed over HTTP with
// the injected clock.
import { afterEach, expect, test } from "bun:test";
import { hour, schedulerFixture } from "@/test/scheduler/fixture";
import type { SchedulerFixture } from "@/test/scheduler/fixture";
import { asBody } from "@/test/read-body";

const fixtures: Array<SchedulerFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open() {
  const f = await schedulerFixture();
  fixtures.push(f);
  return f;
}
const tx = (template: number, extra: Record<string, unknown> = {}) => ({
  wait: "PT0S",
  kind: "transactional",
  template_id: template,
  ...extra,
});

const email = "one-exit@example.test";
const subscriber = { email, name: "Ana" };
const named = (name: string) => ({ subscriber, name });

type BatchResult = {
  event_id: number;
  subscriber_id: number;
  enrollments: { started: Array<{ id: number }>; ended: Array<{ id: number }> };
};
type TabRow = {
  id: number;
  name: string;
  started: Array<{ enrollment_id: number }>;
  exited: Array<{ enrollment_id: number }>;
};

/** One page of the subscriber's Events tab, newest first. */
async function tab(f: SchedulerFixture, subscriberId: number, query = "") {
  const r = await f.json(`/api/subscribers/${subscriberId}/subscriber-events${query}`);
  expect(r.status).toBe(200);
  return asBody<Array<TabRow>>(r.body.data.results);
}

/** A batch of events, in order; each result carries its event's ID and its enrollments. */
async function batch(f: SchedulerFixture, events: Array<Record<string, unknown>>) {
  const r = await f.json("/api/subscriber-events/batch", "POST", { events });
  expect(r.status).toBe(200);
  return asBody<Array<BatchResult>>(r.body.data.results);
}

// Two events of one name in one batch share the receive time, so both match the exit. The exit
// is shown on the first (lowest ID) only: it is the one that ended the enrollment.
test("two events of one name in one batch show an exit on the lowest-ID event only", async () => {
  const f = await open();
  const template = await f.template("<p>Hi</p>", "Waiting");
  await f.sequence({
    name: "Stop path",
    trigger: { event: "one_start" },
    exit_on: ["one_stop"],
    reentry: "always",
    steps: [tx(template, { wait: "P1D" })],
  });
  const started = await f.event(email, "one_start", { subscriber });
  const enrollment = started.enrollments.started[0]!.id;
  await f.pass(hour);

  const batch = await f.json("/api/subscriber-events/batch", "POST", {
    events: [named("one_stop"), named("one_stop")],
  });
  expect(batch.status).toBe(200);
  const [first, second] = asBody<Array<BatchResult>>(batch.body.data.results);
  expect(first!.enrollments.ended.map((e) => e.id)).toEqual([enrollment]);
  expect(second!.enrollments.ended).toEqual([]);

  const rows = await tab(f, started.subscriber_id);
  const byId = (id: number) => rows.find((row) => row.id === id)!;
  expect(byId(first!.event_id).exited.map((link) => link.enrollment_id)).toEqual([enrollment]);
  expect(byId(second!.event_id).exited).toEqual([]);
});

// The batch's first event starts the enrollment, so it cannot have ended it: the next event of
// that name, in the same batch, is the one that exits it (it also starts the next run).
test("an enrollment started by an event of the same batch is exited by the next event of that name", async () => {
  const f = await open();
  const template = await f.template("<p>Hi</p>", "Waiting");
  await f.sequence({
    name: "Gate path",
    trigger: { event: "two_gate" },
    exit_on: ["two_gate"],
    reentry: "always",
    steps: [tx(template, { wait: "P1D" })],
  });
  const batch = await f.json("/api/subscriber-events/batch", "POST", {
    events: [named("two_gate"), named("two_gate")],
  });
  expect(batch.status).toBe(200);
  const [first, second] = asBody<Array<BatchResult>>(batch.body.data.results);
  const startedBy = first!.enrollments.started.map((e) => e.id);
  expect(startedBy).toHaveLength(1);
  expect(second!.enrollments.ended.map((e) => e.id)).toEqual(startedBy);

  const rows = await tab(f, first!.subscriber_id);
  const byId = (id: number) => rows.find((row) => row.id === id)!;
  expect(byId(first!.event_id).started.map((link) => link.enrollment_id)).toEqual(startedBy);
  expect(byId(first!.event_id).exited).toEqual([]);
  expect(byId(second!.event_id).exited.map((link) => link.enrollment_id)).toEqual(startedBy);
});

// The trigger and the exit's event share the batch's time but not a name. The first stop came before
// the enrollment existed, so the exit is shown on the second stop, the first after the trigger.
test("an exit is shown after its enrollment's trigger, whatever the trigger's name", async () => {
  const f = await open();
  const template = await f.template("<p>Hi</p>", "Waiting");
  await f.sequence({
    name: "Late start path",
    trigger: { event: "three_start" },
    exit_on: ["three_stop"],
    steps: [tx(template, { wait: "P1D" })],
  });
  const batch = await f.json("/api/subscriber-events/batch", "POST", {
    events: [named("three_stop"), named("three_start"), named("three_stop")],
  });
  expect(batch.status).toBe(200);
  const [before, start, stop] = asBody<Array<BatchResult>>(batch.body.data.results);
  const started = start!.enrollments.started.map((e) => e.id);
  expect(started).toHaveLength(1);
  expect(stop!.enrollments.ended.map((e) => e.id)).toEqual(started);

  const rows = await tab(f, start!.subscriber_id);
  const byId = (id: number) => rows.find((row) => row.id === id)!;
  expect(byId(before!.event_id).exited).toEqual([]);
  expect(byId(start!.event_id).started.map((link) => link.enrollment_id)).toEqual(started);
  expect(byId(stop!.event_id).exited.map((link) => link.enrollment_id)).toEqual(started);
});

// The exit belongs to the first event of its name in the batch, which is on the second page here.
// The second event of the name, on this page, is not shown the exit; the page that holds the
// first event shows it.
test("an exit shows on this page only when its one event is on this page", async () => {
  const f = await open();
  const template = await f.template("<p>Hi</p>", "Waiting");
  await f.sequence({
    name: "Page path",
    trigger: { event: "page_start" },
    exit_on: ["page_stop"],
    reentry: "always",
    steps: [tx(template, { wait: "P1D" })],
  });
  const started = await f.event(email, "page_start", { subscriber });
  const enrollment = started.enrollments.started[0]!.id;
  await f.pass(hour);
  const batch = await f.json("/api/subscriber-events/batch", "POST", {
    events: [named("page_stop"), named("page_stop")],
  });
  const [first, second] = asBody<Array<BatchResult>>(batch.body.data.results);
  // A newer event pushes the second stop onto page 1 of two: page 1 is [filler, second stop].
  await f.event(email, "page_filler", { subscriber });

  const subscriberId = started.subscriber_id;
  const pageOne = await tab(f, subscriberId, "?per_page=2&page=1");
  const pageTwo = await tab(f, subscriberId, "?per_page=2&page=2");
  expect(pageOne.map((row) => row.id)).toContain(second!.event_id);
  expect(pageTwo.map((row) => row.id)).toContain(first!.event_id);

  expect(pageOne.find((row) => row.id === second!.event_id)!.exited).toEqual([]);
  expect(pageTwo.find((row) => row.id === first!.event_id)!.exited).toEqual([
    expect.objectContaining({ enrollment_id: enrollment }),
  ]);
});

// Two exits of one name, an hour apart, with reentry always: each run ends on its own stop. The
// second stop's choice must be the one received at its own time, not the first stop of the name.
test("two exits of one name an hour apart are each shown on their own event", async () => {
  const f = await open();
  const template = await f.template("<p>Hi</p>", "Waiting");
  await f.sequence({
    name: "Repeat stop path",
    trigger: { event: "four_start" },
    exit_on: ["four_stop"],
    reentry: "always",
    steps: [tx(template, { wait: "P1D" })],
  });
  const firstStart = await f.event(email, "four_start", { subscriber });
  const firstEnrollment = firstStart.enrollments.started[0]!.id;
  await f.pass(hour);
  const [firstStop] = await batch(f, [named("four_stop")]);
  await f.pass(hour);
  const secondStart = await f.event(email, "four_start", { subscriber });
  const secondEnrollment = secondStart.enrollments.started[0]!.id;
  await f.pass(hour);
  const [secondStop] = await batch(f, [named("four_stop")]);
  expect(firstStop!.enrollments.ended.map((e) => e.id)).toEqual([firstEnrollment]);
  expect(secondStop!.enrollments.ended.map((e) => e.id)).toEqual([secondEnrollment]);

  const rows = await tab(f, firstStart.subscriber_id);
  const byId = (id: number) => rows.find((row) => row.id === id)!;
  expect(byId(firstStop!.event_id).exited.map((link) => link.enrollment_id)).toEqual([
    firstEnrollment,
  ]);
  expect(byId(secondStop!.event_id).exited.map((link) => link.enrollment_id)).toEqual([
    secondEnrollment,
  ]);
});

// Another subscriber's event of the same name, received in the same batch and before Ana's, has
// the same receive time. It is not Ana's event: Ana's stop is shown the exit, Bob's event is not.
test("another subscriber's same-named event in the same batch is never chosen", async () => {
  const f = await open();
  const template = await f.template("<p>Hi</p>", "Waiting");
  await f.sequence({
    name: "Other subscriber path",
    trigger: { event: "five_start" },
    exit_on: ["five_stop"],
    reentry: "always",
    steps: [tx(template, { wait: "P1D" })],
  });
  const started = await f.event(email, "five_start", { subscriber });
  const enrollment = started.enrollments.started[0]!.id;
  await f.pass(hour);
  const [other, ana] = await batch(f, [
    { subscriber: { email: "other-exit@example.test", name: "Bob" }, name: "five_stop" },
    named("five_stop"),
  ]);
  expect(other!.subscriber_id).not.toBe(started.subscriber_id);
  expect(ana!.enrollments.ended.map((e) => e.id)).toEqual([enrollment]);

  const rows = await tab(f, started.subscriber_id);
  const byId = (id: number) => rows.find((row) => row.id === id)!;
  expect(byId(ana!.event_id).exited.map((link) => link.enrollment_id)).toEqual([enrollment]);
});
