// B116 (D131): every skipped send and every sequence start that a subscriber's state prevents
// carries a machine-readable reason, visible through the events, sends and subscriber APIs.
// Observed over HTTP with the injected clock; no table is read.
import { afterEach, expect, test } from "bun:test";
import { ascending } from "@/test/order";
import { day, hour, minute, schedulerFixture } from "@/test/scheduler/fixture";
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
const event = (f: SchedulerFixture, body: object) => f.json("/api/subscriber-events", "POST", body);

test("a blocklisted person's event names each sequence it would start, marketing or transactional, and starts none", async () => {
  const f = await open();
  const news = await f.list("News");
  const template = await f.template();
  const marketing = await f.sequence({
    name: "Marketing",
    list_id: news,
    reentry: "always",
    trigger: { event: "order_paid" },
    steps: [mk(template)],
  });
  const receipt = await f.sequence({
    name: "Receipt",
    reentry: "always",
    trigger: { event: "order_paid" },
    steps: [tx(template)],
  });
  const created = await event(f, { subscriber: { email: "bl@example.test" }, name: "signup" });
  const subscriber = created.body.data.subscriber_id as number;
  expect((await f.json(`/api/subscribers/${subscriber}/blocklist`, "PUT", {})).status).toBe(200);

  const paid = await event(f, { subscriber: { email: "bl@example.test" }, name: "order_paid" });
  expect(paid.status).toBe(200);
  expect(paid.body.data.enrollments.started).toEqual([]);
  expect(paid.body.data.enrollments.skipped).toEqual([
    { sequence_id: marketing.id, reason: "subscriber_blocklisted" },
    { sequence_id: receipt.id, reason: "subscriber_blocklisted" },
  ]);
  expect((await f.json(`/api/enrollments?subscriber_id=${subscriber}`)).body.data.results).toEqual(
    [],
  );

  // The subscriber's own event list shows the same outcome for that event.
  const timeline = (await f.json(`/api/subscribers/${subscriber}/subscriber-events`)).body.data
    .results as Array<{ name: string; skipped: Array<unknown> }>;
  expect(timeline.find((e) => e.name === "order_paid")?.skipped).toEqual([
    { sequence_id: marketing.id, reason: "subscriber_blocklisted" },
    { sequence_id: receipt.id, reason: "subscriber_blocklisted" },
  ]);
  // An event that starts nothing says so with an empty list.
  expect(timeline.find((e) => e.name === "signup")?.skipped).toEqual([]);
});

test("a suppressed person's marketing start is named suppressed, and their transactional sequence still starts", async () => {
  const f = await open();
  const news = await f.list("News");
  const template = await f.template("<p>Hi</p>", "Hello");
  const marketing = await f.sequence({
    name: "Marketing",
    list_id: news,
    reentry: "always",
    trigger: { event: "order_paid" },
    steps: [mk(template)],
  });
  const receipt = await f.sequence({
    name: "Receipt",
    reentry: "always",
    trigger: { event: "order_paid" },
    steps: [tx(template)],
  });
  const address = "wiped@example.test";
  const order = () =>
    event(f, {
      subscriber: { email: address, name: "Wiped", external_id: "customer-7", grant_lists: [news] },
      name: "order_paid",
    });

  // The grant adds consent, so the marketing sequence starts and its mail goes out.
  const first = await order();
  expect(
    first.body.data.enrollments.started
      .map((s: { sequence_id: number }) => s.sequence_id)
      .sort(ascending),
  ).toEqual([marketing.id, receipt.id].sort(ascending));
  const subscriber = first.body.data.subscriber_id as number;
  await f.until(async () => (await f.sendLog("&kind=marketing&status=sent")).length === 1);

  // The person wipes through the paired link of that marketing mail.
  const uuid = (await f.json(`/api/subscribers/${subscriber}`)).body.data.uuid as string;
  const send = (await f.sendLog("&kind=marketing"))[0]!.uuid as string;
  expect((await f.request(`/m/${send}/wipe/${uuid}?confirm=true`, { method: "POST" })).status).toBe(
    200,
  );

  // An operator re-creates the address with the list: the wipe still stands, so none is granted.
  expect(
    (await f.json("/api/subscribers", "POST", { email: address, name: "Wiped", lists: [news] }))
      .status,
  ).toBe(200);
  const again = await order();
  expect(again.body.data.grants).toEqual([{ list_id: news, result: "suppressed" }]);
  expect(
    again.body.data.enrollments.started.map((s: { sequence_id: number }) => s.sequence_id),
  ).toEqual([receipt.id]);
  expect(again.body.data.enrollments.skipped).toEqual([
    { sequence_id: marketing.id, reason: "suppressed" },
  ]);
});

test("a late step and a capped marketing step are skipped sends whose reasons the send log shows", async () => {
  const f = await open();
  const news = await f.list("News");
  const template = await f.template();

  // late: the step is due an hour after the event and its window is thirty minutes.
  await f.sequence({
    name: "Late",
    reentry: "always",
    trigger: { event: "late_check" },
    steps: [tx(template, { wait: "PT1H", max_late: "PT30M" })],
  });
  await event(f, { subscriber: { email: "late@example.test" }, name: "late_check" });
  await f.pass(2 * hour);
  expect((await f.sendLog("&status=skipped")).map((s) => s.skip_reason)).toEqual(["late"]);

  // frequency_cap: a skipped marketing step inside the seven-day window of an earlier send.
  f.marketing.minInterval = "P7D";
  await f.sequence({
    name: "Cap",
    list_id: news,
    reentry: "always",
    trigger: { event: "cap_check" },
    steps: [
      mk(template),
      mk(template, { wait: "P1D" }),
      mk(template, { wait: "PT1H", cap_policy: "skip" }),
    ],
  });
  await event(f, {
    subscriber: { email: "cap@example.test", grant_lists: [news] },
    name: "cap_check",
  });
  await f.until(async () => (await f.sendLog("&kind=marketing&status=sent")).length === 1);
  await f.pass(day);
  await f.pass(6 * day - minute);
  await f.pass(minute);
  await f.until(async () => (await f.sendLog("&kind=marketing&status=sent")).length === 2);
  await f.pass(hour);
  const skipped = await f.sendLog("&kind=marketing&status=skipped");
  expect(skipped.map((s) => s.skip_reason)).toEqual(["frequency_cap"]);

  // Every skipped row in the journal names its reason.
  const all = await f.sendLog("&status=skipped");
  expect(all.length).toBe(2);
  expect(all.every((s) => typeof s.skip_reason === "string" && s.skip_reason !== "")).toBe(true);
});
