// A test enrollment from an event recorded before it (docs/design/05-sequences.md#test-mode,
// D101): conditions with `since: "trigger"` and the template's `trigger` data measure from that
// event, through the scheduler loop with an injected clock and the SMTP sink.
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
function decoded(data: string) {
  const at = data.indexOf("\r\n\r\n");
  return data
    .slice(at + 4)
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
const ago = (f: SchedulerFixture, ms: number) =>
  new Date(f.clock.now().getTime() - ms).toISOString();
/** Record an event and return its ID, as the events API answers it. */
async function record(
  f: SchedulerFixture,
  email: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const r = await f.json("/api/subscriber-events", "POST", {
    subscriber: { email, name: "Ana" },
    name,
    ...extra,
  });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return { id: r.body.data.event_id as number, subscriber: r.body.data.subscriber_id as number };
}
/** Sequence with one step that is due after `wait` and runs only if nothing was downloaded. */
async function sequence(f: SchedulerFixture) {
  const template = await f.template(
    "<p>{{ trigger.name }} {{ trigger.data.order }} pack</p>",
    "Since the purchase",
  );
  return f.sequence({
    trigger: { event: "order_paid" },
    steps: [
      {
        wait: "P7D",
        kind: "transactional",
        template_id: template,
        condition: { not: { event: "download_finished", since: "trigger" } },
      },
    ],
  });
}
async function waitForRun(f: SchedulerFixture, id: number) {
  await f.until(async () => {
    const e = await f.enrollment(id);
    return e.status !== "active";
  }, `enrollment ${id} settled`);
}

test("D101: no download since the earlier purchase sends, and the template reads that event", async () => {
  const f = await open();
  const seq = await sequence(f);
  const paid = await record(f, "quiet@example.test", "order_paid", {
    data: { order: "A1" },
    occurred_at: ago(f, 2 * day),
  });
  const started = await f.json("/api/enrollments", "POST", {
    sequence_id: seq.id,
    subscriber_id: paid.subscriber,
    test: true,
    trigger_event_id: paid.id,
  });
  expect(started.status).toBe(200);
  await f.pass(minute);
  await f.until(() => f.sink.messages.length === 1, "one message");
  expect(decoded(f.sink.messages[0]!.data)).toContain("<p>order_paid A1 pack</p>");
  expect((await f.enrollment(started.body.data.id)).status).toBe("completed");
});

test("D101: a download after the earlier purchase ends the test without mail", async () => {
  const f = await open();
  const seq = await sequence(f);
  const paid = await record(f, "bought@example.test", "order_paid", {
    data: { order: "B2" },
    occurred_at: ago(f, 2 * day),
  });
  await record(f, "bought@example.test", "download_finished", {
    occurred_at: ago(f, day),
  });
  const started = await f.json("/api/enrollments", "POST", {
    sequence_id: seq.id,
    subscriber_id: paid.subscriber,
    test: true,
    trigger_event_id: paid.id,
  });
  expect(started.status).toBe(200);
  await f.pass(minute);
  await waitForRun(f, started.body.data.id);
  expect((await f.enrollment(started.body.data.id)).status).toBe("exited");
  expect(f.sink.messages).toHaveLength(0);
});

test("D101: without trigger_event_id the same download is before the trigger and does not count", async () => {
  const f = await open();
  const seq = await sequence(f);
  const subscriber = await f.subscriber("unlinked@example.test");
  await record(f, "unlinked@example.test", "order_paid", { data: { order: "C3" } });
  await record(f, "unlinked@example.test", "download_finished", {
    occurred_at: ago(f, day),
  });
  // Without an event the trigger is the enrollment itself, so yesterday's download is earlier.
  const started = await f.json("/api/enrollments", "POST", {
    sequence_id: seq.id,
    subscriber_id: subscriber,
    test: true,
  });
  expect(started.status).toBe(200);
  await f.pass(minute);
  await f.until(() => f.sink.messages.length === 1, "one message");
  // No trigger event: the template's trigger data is empty.
  expect(decoded(f.sink.messages[0]!.data)).toContain("<p>  pack</p>");
});
