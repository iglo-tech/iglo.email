// B130 (D128, r1): leaving one list through a marketing mail's link ends only the enrollments whose next step
// is marketing. Through the public link, the scheduler loop and the SMTP sink: a waiting marketing step ends
// now, a transactional-only sequence tied to the list keeps running and delivers, and a mixed sequence delivers
// its transactional step and ends at its marketing step. Enrollment states are read through GET /api/enrollments.
import { afterEach, expect, test } from "bun:test";
import { must } from "@/invariant";
import { schedulerFixture } from "@/test/scheduler/fixture";
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

const address = "leaves-news@example.test";
const day = 86_400_000;

/** Mail the sink holds for the address: marketing mail carries List-Unsubscribe (D126, r2). */
function sent(f: SchedulerFixture, kind: "marketing" | "transactional") {
  return f.sink.messages.filter(
    (m) =>
      m.to.includes(address) && m.data.includes("List-Unsubscribe:") === (kind === "marketing"),
  ).length;
}

test("leaving a list ends a waiting marketing step, keeps a transactional-only sequence, and ends a mixed sequence at its marketing step", async () => {
  const f = await open();
  const news = await f.list("News");
  const template = await f.template("<p>Hi {{ subscriber.name }}</p>", "Hello");
  const trigger = { event: "order_paid" };
  // Sends its marketing mail at once, so the person has a marketing send to leave News through.
  await f.sequence({
    name: "Marketing now",
    list_id: news,
    reentry: "always",
    trigger,
    steps: [{ wait: "PT0S", kind: "marketing", template_id: template }],
  });
  // Its next step is marketing: leaving News ends it now.
  const waiting = await f.sequence({
    name: "Marketing later",
    list_id: news,
    reentry: "always",
    trigger,
    steps: [{ wait: "P1D", kind: "marketing", template_id: template }],
  });
  // Transactional only, tied to News: it keeps running.
  const receipt = await f.sequence({
    name: "Day-later receipt",
    list_id: news,
    reentry: "always",
    trigger,
    steps: [{ wait: "P1D", kind: "transactional", template_id: template }],
  });
  // Transactional step first, then marketing: the transactional step delivers, the marketing step ends.
  const mixed = await f.sequence({
    name: "Receipt, then an offer",
    list_id: news,
    reentry: "always",
    trigger,
    steps: [
      { wait: "P1D", kind: "transactional", template_id: template },
      { wait: "P1D", kind: "marketing", template_id: template },
    ],
  });
  // 1. The order grants News: the marketing mail goes, and the three day-long sequences wait.
  const first = await f.json("/api/subscriber-events", "POST", {
    subscriber: { email: address, name: "Ada", grant_lists: [news] },
    name: "order_paid",
  });
  expect(first.status).toBe(200);
  const subscriber = asBody<number>(first.body.data.subscriber_id);
  const states = async () =>
    Object.fromEntries(
      asBody<{
        results: Array<{ sequence_id: number; status: string; exit_reason: string | null }>;
      }>((await f.json(`/api/enrollments?subscriber_id=${subscriber}`)).body.data).results.map(
        (e) => [e.sequence_id, `${e.status}:${e.exit_reason}`],
      ),
    );
  await f.until(() => sent(f, "marketing") === 1, "the marketing mail of the order");
  expect(await states()).toMatchObject({
    [waiting.id]: "active:null",
    [receipt.id]: "active:null",
    [mixed.id]: "active:null",
  });

  // 2. The person leaves News through the marketing mail's link: one list, no blocklist.
  const uuid = asBody<string>((await f.json(`/api/subscribers/${subscriber}`)).body.data.uuid);
  const marketingSends = asBody<{ results: Array<{ uuid: string }> }>(
    (await f.json(`/api/sends?subscriber_id=${subscriber}&kind=marketing`)).body.data,
  ).results;
  const unsub = await f.request(
    `/m/${must(marketingSends[0], "marketing send").uuid}/unsubscribe/${uuid}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    },
  );
  expect(unsub.status).toBe(200);
  const after = (await f.json(`/api/subscribers/${subscriber}`)).body.data;
  expect(after.status).toBe("enabled");
  expect(
    asBody<Array<{ subscription_status: string }>>(after.lists).map((l) => l.subscription_status),
  ).toEqual(["unsubscribed"]);
  // Only the waiting marketing step ends; the other two keep running.
  expect(await states()).toMatchObject({
    [waiting.id]: "exited:unsubscribed",
    [receipt.id]: "active:null",
    [mixed.id]: "active:null",
  });

  // 3. A day later both transactional steps deliver: the receipt completes, and the mixed sequence waits at
  // its marketing step.
  await f.pass(day);
  await f.until(
    () => sent(f, "transactional") === 2,
    "the receipt and the mixed sequence's transactional step",
  );
  await f.until(
    async () => (await states())[receipt.id] === "completed:null",
    "the receipt completes after its step",
  );
  expect(await states()).toMatchObject({ [mixed.id]: "active:null" });

  // 4. The next day the mixed sequence's marketing step is due. The person is off News, so it ends
  // unsubscribed and sends no marketing mail.
  await f.pass(day);
  await f.until(
    async () => (await states())[mixed.id] === "exited:unsubscribed",
    "the mixed sequence ends at its marketing step",
  );
  await f.pass();
  expect(sent(f, "marketing")).toBe(1);
  expect(sent(f, "transactional")).toBe(2);
});
