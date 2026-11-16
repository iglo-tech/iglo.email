// Manual and test enrollments from an existing event (docs/design/05-sequences.md#test-mode, D101):
// `trigger_event_id` must be the subscriber's own event under the sequence's trigger name, else
// 400 with nothing written. Through POST /api/enrollments and the events API.
import { afterEach, expect, test } from "bun:test";
import { sequencesFixture, type SequencesFixture } from "@/test/sequences/fixture";

const fixtures: SequencesFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await sequencesFixture();
  fixtures.push(f);
  return f;
}
const day = 86_400_000;
const refusal = { status: 400, message: "Invalid fields: trigger_event_id" };

async function sequence(f: SequencesFixture) {
  const tx = await f.template();
  const created = await f.json("/api/sequences", "POST", {
    name: "After purchase",
    status: "active",
    trigger: { event: "order_paid" },
    reentry: "always",
    steps: [{ wait: "P3D", kind: "transactional", template_id: tx }],
  });
  expect(created.status).toBe(200);
  return created.body.data.id as number;
}

test("D101: a manual enrollment records the subscriber's earlier event as its trigger", async () => {
  const f = await open();
  const seq = await sequence(f);
  const subscriber = await f.subscriber("manual@example.test");
  const paid = await f.event({
    subscriber: { email: "manual@example.test" },
    name: "order_paid",
    occurred_at: new Date(f.clock.now().getTime() - 2 * day).toISOString(),
  });
  expect(paid.status).toBe(200);
  const eventId = paid.body.data.event_id as number;

  const enrolled = await f.json("/api/enrollments", "POST", {
    sequence_id: seq,
    subscriber_id: subscriber,
    trigger_event_id: eventId,
  });
  expect(enrolled.status).toBe(200);
  expect(enrolled.body.data).toMatchObject({ trigger_event_id: eventId, test: false });
  // The wait still starts from now: the trigger only sets what conditions measure from.
  expect(Date.parse(enrolled.body.data.due_at) - f.clock.now().getTime()).toBe(3 * day);
});

test("D101: a test enrollment records it too, and a null ID is the same as none", async () => {
  const f = await open();
  const seq = await sequence(f);
  const subscriber = await f.subscriber("test-trigger@example.test");
  const paid = await f.event({
    subscriber: { email: "test-trigger@example.test" },
    name: "order_paid",
  });
  const eventId = paid.body.data.event_id as number;

  const tested = await f.json("/api/enrollments", "POST", {
    sequence_id: seq,
    subscriber_id: subscriber,
    test: true,
    trigger_event_id: eventId,
  });
  expect(tested.status).toBe(200);
  expect(tested.body.data).toMatchObject({ trigger_event_id: eventId, test: true });
  const none = await f.json("/api/enrollments", "POST", {
    sequence_id: seq,
    subscriber_id: subscriber,
    trigger_event_id: null,
    force: true,
  });
  expect(none.status).toBe(200);
  expect(none.body.data.trigger_event_id).toBeNull();
});

test("D101: another subscriber's event, another event name or an unknown ID is 400 with no write", async () => {
  const f = await open();
  const seq = await sequence(f);
  const mine = await f.subscriber("mine@example.test");
  await f.subscriber("theirs@example.test");
  const theirs = (
    await f.event({ subscriber: { email: "theirs@example.test" }, name: "order_paid" })
  ).body.data.event_id as number;
  const feedback = (
    await f.event({ subscriber: { email: "mine@example.test" }, name: "feedback_given" })
  ).body.data.event_id as number;
  const before = f.count("enrollments");

  const cases: [string, unknown][] = [
    ["another subscriber's event", theirs],
    ["an event under another name", feedback],
    ["an unknown ID", 999_999],
    ["a non-ID", "abc"],
    ["zero", 0],
  ];
  for (const [label, trigger] of cases) {
    for (const extra of [{}, { test: true }, { force: true }]) {
      const r = await f.json("/api/enrollments", "POST", {
        sequence_id: seq,
        subscriber_id: mine,
        trigger_event_id: trigger,
        ...extra,
      });
      expect([label, extra, r.status, r.body.message]).toEqual([
        label,
        extra,
        refusal.status,
        refusal.message,
      ]);
    }
  }
  expect(f.count("enrollments")).toBe(before);
});
