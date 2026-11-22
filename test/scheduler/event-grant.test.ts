// A list grant on the trigger event lands before the sequence starts (D99): a PT0S marketing
// first step sends when granted and ends unsubscribed when the grant is missing or refused.
import { afterEach, expect, test } from "bun:test";
import { schedulerFixture } from "@/test/scheduler/fixture";
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
const mk = (template: number) => ({ wait: "PT0S", kind: "marketing", template_id: template });
const order = (subscriber: JsonObject) => ({ subscriber, name: "order_paid" });

/** Wait until the outbox has journaled every send and `count` messages reached the sink. */
async function delivered(f: SchedulerFixture, count: number) {
  await f.until(
    async () =>
      f.sink.messages.length >= count &&
      (await f.sendLog()).every((s) => s.status !== "queued" && s.status !== "sending"),
    `${count} messages`,
  );
}

test("a grant on the trigger event lets a PT0S marketing first step send", async () => {
  const f = await open();
  const template = await f.template("<p>Fresh offer for {{ subscriber.name }}</p>", "Offer");
  const news = await f.list("news");
  await f.sequence({ list_id: news, steps: [mk(template)] });
  const started = await f.json(
    "/api/subscriber-events",
    "POST",
    order({ email: "fresh@example.test", name: "Fresh", grant_lists: [news] }),
  );
  expect(started.status).toBe(200);
  expect(started.body.data.grants).toEqual([{ list_id: news, result: "added" }]);
  const enrollment = started.body.data.enrollments.started[0]!.id as number;
  await f.pass(0);
  await delivered(f, 1);
  expect(await f.enrollment(enrollment)).toMatchObject({ status: "completed" });
  expect(f.sink.messages).toHaveLength(1);
});

test("without a grant the same event ends the enrollment unsubscribed and sends nothing", async () => {
  const f = await open();
  const template = await f.template();
  const news = await f.list("news");
  await f.sequence({ list_id: news, steps: [mk(template)] });
  const started = await f.json(
    "/api/subscriber-events",
    "POST",
    order({ email: "plain@example.test" }),
  );
  const enrollment = started.body.data.enrollments.started[0]!.id as number;
  await f.pass(0);
  expect(await f.enrollment(enrollment)).toMatchObject({
    status: "exited",
    exit_reason: "unsubscribed",
  });
  expect(await f.sendLog()).toEqual([]);
});

test("after a one-click unsubscribe, a repeated grant does not revive the enrollment", async () => {
  const f = await open();
  const template = await f.template();
  const news = await f.list("news");
  await f.sequence({ list_id: news, steps: [mk(template)] });
  const first = await f.json(
    "/api/subscriber-events",
    "POST",
    order({ email: "gone@example.test", grant_lists: [news] }),
  );
  const subscriberId = first.body.data.subscriber_id as number;
  await f.pass(0);
  await delivered(f, 1);
  const out = await f.json("/api/subscribers/lists", "PUT", {
    ids: [subscriberId],
    action: "unsubscribe",
    target_list_ids: [news],
  });
  expect(out.status).toBe(200);
  const repeat = await f.json(
    "/api/subscriber-events",
    "POST",
    order({ email: "gone@example.test", grant_lists: [news] }),
  );
  expect(repeat.body.data.grants).toEqual([{ list_id: news, result: "unsubscribed" }]);
  const enrollment = repeat.body.data.enrollments.started[0]!.id as number;
  await f.pass(0);
  expect(await f.enrollment(enrollment)).toMatchObject({
    status: "exited",
    exit_reason: "unsubscribed",
  });
});
