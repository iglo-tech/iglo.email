// B5: a reschedule that shortens a wait makes the step due now, never late
// (docs/design/05-sequences.md#reschedule), through the real scheduler on the injected clock.
import { afterEach, expect, test } from "bun:test";
import { day, schedulerFixture, type SchedulerFixture } from "@/test/scheduler/fixture";

const fixtures: SchedulerFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await schedulerFixture();
  fixtures.push(f);
  return f;
}
async function shorten(f: SchedulerFixture, id: number, wait: string) {
  const full = (await f.json(`/api/sequences/${id}`)).body.data;
  full.steps[0].wait = wait;
  delete full.status;
  expect((await f.json(`/api/sequences/${id}`, "PUT", full)).status).toBe(200);
}
const reschedule = (f: SchedulerFixture, seq: { id: number; steps: { id: number }[] }) =>
  f.json(`/api/sequences/${seq.id}/steps/${seq.steps[0]!.id}/reschedule`, "POST");
async function sent(f: SchedulerFixture) {
  await f.until(
    async () =>
      f.sink.messages.length >= 1 &&
      (await f.sendLog()).every((s) => s.status !== "queued" && s.status !== "sending"),
    "one message",
  );
}

test("a shortened wait with max_late sends after a reschedule; it is not skipped as late", async () => {
  const f = await open();
  const template = await f.template();
  const seq = await f.sequence({
    steps: [{ wait: "P7D", kind: "transactional", template_id: template, max_late: "PT6H" }],
  });
  await f.event("late@example.test");
  await f.pass(2 * day);
  expect(f.sink.messages).toHaveLength(0);
  await shorten(f, seq.id, "PT1H");
  expect((await reschedule(f, seq)).body.data).toEqual({ changed: 1 });
  // The reschedule wakes the scheduler; the step was due 47 hours ago by the new wait, and a
  // stored past time would be a late skip.
  await sent(f);
  expect((await f.sendLog()).map((s) => [s.status, s.skip_reason])).toEqual([["sent", null]]);
});

test("a marketing step with the default P2D limit sends after a reschedule", async () => {
  const f = await open();
  const template = await f.template();
  const news = await f.list("news");
  await f.subscriber("m@example.test", { lists: [news] });
  const seq = await f.sequence({
    list_id: news,
    steps: [{ wait: "P7D", kind: "marketing", template_id: template }],
  });
  await f.event("m@example.test");
  await f.pass(5 * day);
  await shorten(f, seq.id, "PT1H");
  expect((await reschedule(f, seq)).body.data).toEqual({ changed: 1 });
  await sent(f);
  expect((await f.sendLog()).map((s) => [s.status, s.skip_reason])).toEqual([["sent", null]]);
});

test("an enrollment in retry backoff is rewritten but not counted", async () => {
  const f = await open();
  const template = await f.template();
  const seq = await f.sequence({
    steps: [{ wait: "P1D", kind: "transactional", template_id: template }],
  });
  const id = (await f.event("r@example.test")).enrollments.started[0]!.id;
  f.db.run("UPDATE enrollments SET retry_at = ? WHERE id = ?", [
    new Date(f.clock.now().getTime() + 3 * day).toISOString(),
    id,
  ]);
  const row = () =>
    f.db
      .query<{ due_at: string; retry_at: string; occurred_at: string }, [number]>(
        `SELECT e.due_at, e.retry_at, ev.occurred_at FROM enrollments e
           JOIN events ev ON ev.id = e.trigger_event_id WHERE e.id = ?`,
      )
      .get(id)!;
  const before = row();
  const started = Date.parse(before.occurred_at);
  expect(Date.parse(before.due_at)).toBe(started + day);
  await shorten(f, seq.id, "P2D");
  expect((await reschedule(f, seq)).body.data).toEqual({ changed: 0 });
  // The wait is counted from the event again, and the backoff is left where it was.
  const after = row();
  expect(Date.parse(after.due_at)).toBe(started + 2 * day);
  expect(after.retry_at).toBe(before.retry_at);
});
