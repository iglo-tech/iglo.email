// D124: a transactional step runs late only when its author sets max_late; a step with max_late
// that runs after due_at + max_late is a `late` skip, as marketing is (B116's reason), and a step
// without it sends however late it is. An event dated ahead of the clock (within the skew) starts
// its first step at that time, not before. Observed over HTTP and the send log, with the injected
// clock.
import { afterEach, expect, test } from "bun:test";
import { day, hour, minute, schedulerFixture } from "@/test/scheduler/fixture";
import type { JsonObject } from "@/test/json-object";
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
const event = (f: SchedulerFixture, body: JsonObject) =>
  f.json("/api/subscriber-events", "POST", body);

test("a transactional step with max_late skips a six-day-old order as late; without it the step sends", async () => {
  const f = await open();
  const template = await f.template("<p>Hi</p>", "Hello");
  await f.sequence({
    name: "Bounded",
    reentry: "always",
    trigger: { event: "order_paid" },
    steps: [tx(template, { max_late: "P1D" })],
  });
  await f.sequence({
    name: "Unbounded",
    reentry: "always",
    trigger: { event: "order_paid" },
    steps: [tx(template)],
  });
  const occurred = new Date(f.clock.now().getTime() - 6 * day).toISOString();
  const r = await event(f, {
    subscriber: { email: "old-order@example.test" },
    name: "order_paid",
    occurred_at: occurred,
  });
  expect(r.status).toBe(200);
  expect(r.body.data.enrollments.started).toHaveLength(2);

  // Waits for both steps to settle, whatever they did: a step that sends when it should be skipped then
  // fails the assertions below with its status and reason, not as a timeout.
  await f.until(
    async () =>
      (await f.sendLog("")).filter((s) => s.status !== "queued" && s.status !== "sending")
        .length === 2,
    "both steps settled",
  );
  expect((await f.sendLog("&status=skipped")).map((s) => [s.kind, s.skip_reason])).toEqual([
    ["transactional", "late"],
  ]);
  expect((await f.sendLog("&status=sent")).map((s) => s.kind)).toEqual(["transactional"]);
});

test("an event dated 14 minutes ahead starts its first step at that time, not before", async () => {
  const f = await open();
  const template = await f.template("<p>Hi</p>", "Hello");
  await f.sequence({
    name: "Ahead",
    reentry: "always",
    trigger: { event: "order_paid" },
    steps: [tx(template)],
  });
  const at = new Date(f.clock.now().getTime() + 14 * minute).toISOString();
  const r = await event(f, {
    subscriber: { email: "ahead@example.test" },
    name: "order_paid",
    occurred_at: at,
  });
  expect(r.status).toBe(200);
  expect(r.body.data.enrollments.started).toHaveLength(1);

  await f.pass(13 * minute);
  expect(await f.sendLog("")).toEqual([]);
  await f.pass(2 * minute);
  await f.until(async () => (await f.sendLog("&status=sent")).length === 1);
  expect((await f.sendLog("&status=sent")).map((s) => s.kind)).toEqual(["transactional"]);
});

// D124: an occurred_at up to MAX_OCCURRED_AHEAD_MS (15 minutes) after receipt is accepted, and a later one is
// refused. The boundary is on the instant, so the offset does not move it, and a fraction of a second past the
// millisecond is cut off before the comparison (src/events/input.ts parseOccurredAt).
test("a +02:00 occurred_at is the instant it names: 15 minutes ahead starts then, not before", async () => {
  const f = await open();
  const template = await f.template("<p>Hi</p>", "Hello");
  await f.sequence({
    name: "Offset",
    reentry: "always",
    trigger: { event: "order_paid" },
    steps: [tx(template)],
  });
  const at = new Date(f.clock.now().getTime() + 15 * minute);
  const local = new Date(at.getTime() + 2 * hour).toISOString().replace("Z", "+02:00");
  expect(local.endsWith("+02:00")).toBe(true);
  const r = await event(f, {
    subscriber: { email: "offset@example.test" },
    name: "order_paid",
    occurred_at: local,
  });
  expect(r.status).toBe(200);
  expect(r.body.data.enrollments.started).toHaveLength(1);

  await f.pass(14 * minute);
  expect(await f.sendLog("")).toEqual([]);
  await f.pass(minute + 1000);
  await f.until(async () => (await f.sendLog("&status=sent")).length === 1, "offset step sent");
});

test("occurred_at at exactly 15 minutes is accepted; a millisecond past it is refused; a sub-millisecond part counts as cut off", async () => {
  const f = await open();
  const template = await f.template("<p>Hi</p>", "Hello");
  await f.sequence({
    name: "Boundary",
    reentry: "always",
    trigger: { event: "order_paid" },
    steps: [tx(template)],
  });
  const boundary = new Date(f.clock.now().getTime() + 15 * minute).toISOString();
  const exact = await event(f, {
    subscriber: { email: "exact@example.test" },
    name: "order_paid",
    occurred_at: boundary,
  });
  expect(exact.status).toBe(200);
  expect(exact.body.data.enrollments.started).toHaveLength(1);

  const past = new Date(f.clock.now().getTime() + 15 * minute + 1).toISOString();
  const refused = await event(f, {
    subscriber: { email: "past@example.test" },
    name: "order_paid",
    occurred_at: past,
  });
  expect(refused.status).toBe(400);

  // 999 ns past the boundary's millisecond is cut off, so this is the boundary itself: accepted.
  const cutOff = boundary.replace(/\.(\d{3})Z$/, ".$1999Z");
  const sub = await event(f, {
    subscriber: { email: "cut@example.test" },
    name: "order_paid",
    occurred_at: cutOff,
  });
  expect(sub.status).toBe(200);
  expect(sub.body.data.enrollments.started).toHaveLength(1);
});
