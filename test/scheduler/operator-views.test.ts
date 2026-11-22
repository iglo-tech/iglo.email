// B127: the send log names what a send is (its subject, its sequence and step), and an enrollment's
// timeline names a wait the frequency cap holds and the time the cap frees the step. Observed over
// HTTP with the injected clock; no table is read.
import { afterEach, expect, test } from "bun:test";
import { day, hour, schedulerFixture } from "@/test/scheduler/fixture";
import type { JsonObject } from "@/test/json-object";
import { asBody } from "@/test/read-body";
import type { SchedulerFixture } from "@/test/scheduler/fixture";

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
const tx = (template: number, extra: JsonObject = {}) => ({
  wait: "PT0S",
  kind: "transactional",
  template_id: template,
  ...extra,
});
const mk = (template: number, extra: JsonObject = {}) => ({
  wait: "PT0S",
  kind: "marketing",
  template_id: template,
  ...extra,
});
type TimelineEntry = { type: string; held?: string | null; held_until?: string | null };
async function timelineOf(f: SchedulerFixture, id: number) {
  const r = await f.json(`/api/enrollments/${id}/timeline`);
  expect(r.status).toBe(200);
  return asBody<Array<TimelineEntry>>(r.body.data.entries);
}

test("a sequence send names its subject, its sequence and its step, and the send log filters on them", async () => {
  const f = await open();
  const news = await f.list("News");
  const template = await f.template("<p>{{ subscriber.name }}</p>", "Welcome aboard");
  await f.sequence({
    name: "Onboarding",
    list_id: news,
    reentry: "always",
    trigger: { event: "signup_check" },
    steps: [mk(template), tx(template, { wait: "PT1H" })],
  });
  const started = await f.event("lab@example.test", "signup_check", {
    subscriber: { email: "lab@example.test", name: "Ana", grant_lists: [news] },
  });
  expect(started.enrollments.started.length).toBe(1);
  await f.until(async () => (await f.sendLog("&status=sent")).length === 1);
  await f.pass(hour);
  await f.until(async () => (await f.sendLog("&status=sent")).length === 2);

  const log = await f.sendLog();
  expect(
    log.map((s) => ({
      subject: s.subject,
      kind: s.kind,
      sequence_name: s.sequence_name,
      step_position: s.step_position,
    })),
  ).toEqual([
    { subject: "Welcome aboard", kind: "marketing", sequence_name: "Onboarding", step_position: 0 },
    {
      subject: "Welcome aboard",
      kind: "transactional",
      sequence_name: "Onboarding",
      step_position: 1,
    },
  ]);
  // The subscriber's own sends are the same rows, and a filter by source keeps the sequence's.
  const id = started.subscriber_id;
  const own = await f.json(`/api/subscribers/${id}/sends?per_page=100`);
  expect(asBody<Array<{ subject: string }>>(own.body.data.results).map((s) => s.subject)).toEqual([
    "Welcome aboard",
    "Welcome aboard",
  ]);
  const onlySequence = await f.json("/api/sends?source=sequence&per_page=100");
  expect(onlySequence.body.data.total).toBe(2);
  // A subject and a sequence are read from the journal only; nothing else of the message shows.
  const row: Record<string, unknown> = (await f.json(`/api/sends/${log[0]!.id}`)).body.data;
  expect(Object.keys(row)).not.toContain("payload");
  expect(Object.keys(row)).not.toContain("body");
}, 60_000);

// B127 r1: an event's row names the sequences it started and the ones it exited, each by its name read
// by ID, so the names do not depend on a page of sequences (the first hundred are not special).
test("an event names the sequences it started and exited, past the first hundred sequences", async () => {
  const f = await open();
  const template = await f.template("<p>Hi</p>", "Waiting");
  const count = 101;
  for (let i = 1; i <= count; i++) {
    await f.sequence({
      name: `Seq ${i}`,
      reentry: "always",
      trigger: { event: "links_start" },
      exit_on: ["links_stop"],
      steps: [tx(template, { wait: "P1D" })],
    });
  }
  const ana = await f.subscriber("links@example.test");
  const started = await f.event("links@example.test", "links_start", {
    subscriber: { email: "links@example.test", name: "Ana" },
  });
  expect(started.enrollments.started.length).toBe(count);
  await f.event("links@example.test", "links_stop", {
    subscriber: { email: "links@example.test", name: "Ana" },
  });

  const rows = asBody<
    Array<{
      name: string;
      started: Array<{ sequence_name: string }>;
      exited: Array<{ sequence_name: string }>;
    }>
  >((await f.json(`/api/subscribers/${ana}/subscriber-events`)).body.data.results);
  const stopped = rows.find((row) => row.name === "links_stop")!;
  expect(stopped.exited.length).toBe(count);
  expect(stopped.exited.map((link) => link.sequence_name)).toContain("Seq 101");
  const begun = rows.find((row) => row.name === "links_start")!;
  expect(begun.started.length).toBe(count);
  expect(begun.started.map((link) => link.sequence_name)).toContain("Seq 101");
  expect(begun.exited.length).toBe(0);
}, 60_000);

test("a marketing wait the frequency cap holds names the cap and when it frees the step; a transactional wait names none", async () => {
  const f = await open();
  f.marketing.minInterval = "P7D";
  const news = await f.list("News");
  const template = await f.template();
  await f.sequence({
    name: "Held",
    list_id: news,
    reentry: "always",
    trigger: { event: "held_check" },
    // The hold is six days long, past the two days a marketing step tolerates by default.
    steps: [mk(template), mk(template, { wait: "PT1H", max_late: "P8D" })],
  });
  await f.sequence({
    name: "Plain",
    reentry: "always",
    trigger: { event: "plain_check" },
    steps: [tx(template), tx(template, { wait: "PT1H" })],
  });
  const held = await f.event("held@example.test", "held_check", {
    subscriber: { email: "held@example.test", name: "Ana", grant_lists: [news] },
  });
  const plain = await f.event("plain@example.test", "plain_check", {
    subscriber: { email: "plain@example.test", name: "Ben" },
  });
  await f.until(async () => (await f.sendLog("&kind=marketing&status=sent")).length === 1);
  const first = (await f.sendLog("&kind=marketing&status=sent"))[0]!;

  // The second marketing step is due an hour on, but the cap admits nothing until the first send
  // is seven days old, so the wait is held until then.
  const heldWait = (await timelineOf(f, held.enrollments.started[0]!.id)).find(
    (e) => e.type === "waiting",
  );
  expect(heldWait?.held).toBe("frequency_cap");
  const freeAt = new Date(Date.parse(String(first.sent_at)) + 7 * day).toISOString();
  expect(heldWait?.held_until).toBe(freeAt);

  // A transactional wait is never held by the cap, whatever the journal holds.
  const plainWait = (await timelineOf(f, plain.enrollments.started[0]!.id)).find(
    (e) => e.type === "waiting",
  );
  expect(plainWait?.held).toBeNull();
  expect(plainWait?.held_until).toBeNull();

  // The subscriber's own enrollment list names the same hold, so its Enrollments tab shows it (B127).
  const listed = async (subscriber: number) =>
    asBody<Array<{ id: number; held_until: string | null }>>(
      (await f.json(`/api/subscribers/${subscriber}/enrollments`)).body.data.results,
    );
  const heldRow = (await listed(held.subscriber_id)).find(
    (row) => row.id === held.enrollments.started[0]!.id,
  );
  expect(heldRow?.held_until).toBe(freeAt);
  const plainRow = (await listed(plain.subscriber_id)).find(
    (row) => row.id === plain.enrollments.started[0]!.id,
  );
  expect(plainRow?.held_until).toBeNull();

  // Once the cap frees the step, the hold ends and the second step goes.
  await f.pass(7 * day);
  await f.until(async () => (await f.sendLog("&kind=marketing&status=sent")).length === 2);
  const after = (await timelineOf(f, held.enrollments.started[0]!.id)).find(
    (e) => e.type === "waiting",
  );
  expect(after).toBeUndefined();
}, 60_000);
