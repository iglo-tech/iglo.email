// B130 (D128): the public "Unsubscribe from all mailing lists" option, through the public link, the events
// API, the scheduler loop and the SMTP sink. Every list ends and a marketing suppression is written: a
// marketing sequence that is waiting ends now as an unsubscribe ends it, no marketing sequence starts
// again, and a transactional sequence step still delivers. The tx API and the admin blocklist are in
// test/unsubscribe/all-lists.test.ts.
import { afterEach, expect, test } from "bun:test";
import { schedulerFixture } from "@/test/scheduler/fixture";
import type { SchedulerFixture } from "@/test/scheduler/fixture";
import { must } from "@/invariant";
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

const address = "all-lists@example.test";

/** Mail the sink holds for the address: marketing mail carries List-Unsubscribe (D126, r2). */
function sent(f: SchedulerFixture, kind: "marketing" | "transactional") {
  return f.sink.messages.filter(
    (m) =>
      m.to.includes(address) && m.data.includes("List-Unsubscribe:") === (kind === "marketing"),
  ).length;
}

test("the all-lists option ends waiting marketing, keeps transactional steps, and refuses later marketing starts", async () => {
  const f = await open();
  const news = await f.list("News");
  const other = await f.list("Other");
  const template = await f.template("<p>Hi {{ subscriber.name }}</p>", "Hello");
  // Sends its marketing mail at once, so the person has a marketing send to unsubscribe through.
  const now = await f.sequence({
    name: "Marketing now",
    list_id: news,
    reentry: "always",
    trigger: { event: "order_paid" },
    steps: [{ wait: "PT0S", kind: "marketing", template_id: template }],
  });
  // Waits a day: its next step is marketing, so the option ends it.
  const later = await f.sequence({
    name: "Marketing later",
    list_id: other,
    reentry: "always",
    trigger: { event: "order_paid" },
    steps: [{ wait: "P1D", kind: "marketing", template_id: template }],
  });
  const receipt = await f.sequence({
    name: "Receipt",
    reentry: "always",
    trigger: { event: "order_paid" },
    steps: [{ wait: "PT0S", kind: "transactional", template_id: template }],
  });
  const order = () =>
    f.json("/api/subscriber-events", "POST", {
      subscriber: { email: address, name: "Ada", grant_lists: [news, other] },
      name: "order_paid",
    });

  // 1. The first order grants both lists: the marketing mail goes, the day-long step waits, the receipt goes.
  const first = await order();
  expect(first.status).toBe(200);
  const subscriber = asBody<number>(first.body.data.subscriber_id);
  const enrolled = async (sequence: number) => {
    const rows = asBody<{
      results: Array<{ sequence_id: number; status: string; exit_reason: string | null }>;
    }>((await f.json(`/api/enrollments?subscriber_id=${subscriber}`)).body.data).results;
    const row = must(
      rows.find((e) => e.sequence_id === sequence),
      "the enrollment of the sequence",
    );
    return { status: row.status, exit_reason: row.exit_reason };
  };
  await f.until(() => sent(f, "marketing") === 1, "the marketing mail of the first order");
  await f.until(() => sent(f, "transactional") === 1, "the receipt of the first order");
  expect(await enrolled(later.id)).toEqual({ status: "active", exit_reason: null });

  // 2. The public link of that marketing mail: the all-lists option, as its form posts it.
  const uuid = asBody<string>((await f.json(`/api/subscribers/${subscriber}`)).body.data.uuid);
  const marketingSends = asBody<{ results: Array<{ uuid: string }> }>(
    (await f.json(`/api/sends?subscriber_id=${subscriber}&kind=marketing`)).body.data,
  ).results;
  const option = await f.request(
    `/m/${must(marketingSends[0], "marketing send").uuid}/unsubscribe/${uuid}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click&blocklist=true",
    },
  );
  expect(option.status).toBe(200);
  expect(await option.text()).toContain("You have unsubscribed successfully.");

  // 3. Every list ends; the status stays enabled, so the person is not blocklisted.
  const after = (await f.json(`/api/subscribers/${subscriber}`)).body.data;
  expect(after.status).toBe("enabled");
  expect(
    asBody<Array<{ subscription_status: string }>>(after.lists).map((l) => l.subscription_status),
  ).toEqual(["unsubscribed", "unsubscribed"]);
  expect(await enrolled(later.id)).toEqual({ status: "exited", exit_reason: "unsubscribed" });

  // 4. A later order: both grants are suppressed, neither marketing sequence starts, the receipt does.
  const again = await order();
  expect(again.body.data.grants).toEqual([
    { list_id: news, result: "suppressed" },
    { list_id: other, result: "suppressed" },
  ]);
  const outcome = asBody<{
    started: Array<{ sequence_id: number }>;
    skipped: Array<{ sequence_id: number; reason: string }>;
  }>(again.body.data.enrollments);
  expect(outcome.started.map((s) => s.sequence_id)).toEqual([receipt.id]);
  expect(outcome.skipped).toEqual(
    expect.arrayContaining([
      { sequence_id: now.id, reason: "suppressed" },
      { sequence_id: later.id, reason: "suppressed" },
    ]),
  );
  await f.until(() => sent(f, "transactional") === 2, "the receipt after the option");
  await f.pass();
  await f.pass();
  expect(sent(f, "marketing")).toBe(1);
});
