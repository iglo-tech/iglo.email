// Reschedule of a manual and a test enrollment that name an older event as their trigger (D101,
// docs/design/05-sequences.md#reschedule): the wait counts from the enrollment's creation, and a
// test keeps its 1-minute cap. Through the HTTP API on the injected clock, no sleeps.
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
async function shorten(f: SchedulerFixture, id: number, wait: string) {
  const full = (await f.json(`/api/sequences/${id}`)).body.data;
  full.steps[0].wait = wait;
  delete full.status;
  expect((await f.json(`/api/sequences/${id}`, "PUT", full)).status).toBe(200);
}
const reschedule = (f: SchedulerFixture, seq: { id: number; steps: { id: number }[] }) =>
  f.json(`/api/sequences/${seq.id}/steps/${seq.steps[0]!.id}/reschedule`, "POST");

/** A purchase ten days old, recorded before any sequence exists, so it starts nothing. */
async function oldPurchase(f: SchedulerFixture, email: string) {
  const r = await f.json("/api/subscriber-events", "POST", {
    subscriber: { email, name: "Old" },
    name: "order_paid",
    occurred_at: new Date(f.clock.now().getTime() - 10 * day).toISOString(),
  });
  expect(r.status).toBe(200);
  return {
    eventId: r.body.data.event_id as number,
    subscriberId: r.body.data.subscriber_id as number,
  };
}

test("D101: a manual enrollment's wait counts from its creation, not from the older event, on reschedule", async () => {
  const f = await open();
  const template = await f.template();
  const purchase = await oldPurchase(f, "manual-resched@example.test");
  const seq = await f.sequence({
    steps: [{ wait: "P3D", kind: "transactional", template_id: template }],
  });
  const enrolled = await f.json("/api/enrollments", "POST", {
    sequence_id: seq.id,
    subscriber_id: purchase.subscriberId,
    trigger_event_id: purchase.eventId,
  });
  expect(enrolled.status).toBe(200);
  const id = enrolled.body.data.id as number;
  const created = Date.parse(enrolled.body.data.created_at);
  expect(Date.parse(enrolled.body.data.due_at)).toBe(created + 3 * day);

  await f.pass(day);
  await shorten(f, seq.id, "P5D");
  expect((await reschedule(f, seq)).body.data).toEqual({ changed: 1 });
  // From the event it would be long past, and due now; from creation it is five days on.
  expect(Date.parse((await f.enrollment(id)).due_at)).toBe(created + 5 * day);
  expect((await f.enrollment(id)).status).toBe("active");
  expect(f.sink.messages).toHaveLength(0);
});

test("D101: a test enrollment keeps its 1-minute cap, counted from creation, on reschedule", async () => {
  const f = await open();
  const template = await f.template();
  const purchase = await oldPurchase(f, "test-resched@example.test");
  const seq = await f.sequence({
    steps: [{ wait: "P3D", kind: "transactional", template_id: template }],
  });
  const tested = await f.json("/api/enrollments", "POST", {
    sequence_id: seq.id,
    subscriber_id: purchase.subscriberId,
    test: true,
    trigger_event_id: purchase.eventId,
  });
  expect(tested.status).toBe(200);
  const id = tested.body.data.id as number;
  const created = Date.parse(tested.body.data.created_at);
  expect(Date.parse(tested.body.data.due_at)).toBe(created + minute);

  // Half a minute later the test is still waiting; the longer wait does not uncap it, and the
  // old event does not make it due.
  await f.pass(30_000);
  await shorten(f, seq.id, "P7D");
  expect((await reschedule(f, seq)).body.data).toEqual({ changed: 0 });
  const row = await f.enrollment(id);
  expect(Date.parse(row.due_at)).toBe(created + minute);
  expect(row.test).toBe(true);
  expect(row.status).toBe("active");
  expect(f.sink.messages).toHaveLength(0);
});
