// B118a item 4 (B130 r3): a marketing step's send is recorded in the same write that moves its
// enrollment to the next step, so an unsubscribe that comes after it sees a transactional next step
// and keeps the enrollment running. The receipt-style step after it still sends. Decision in 05.
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

const address = "recorded-marketing@example.test";
const day = 86_400_000;

/** Mail the sink holds for the address: marketing mail carries List-Unsubscribe (D126, r2). */
function sent(f: SchedulerFixture, kind: "marketing" | "transactional") {
  return f.sink.messages.filter(
    (m) =>
      m.to.includes(address) && m.data.includes("List-Unsubscribe:") === (kind === "marketing"),
  ).length;
}

test("a marketing step sent before an unsubscribe does not stop the transactional step after it", async () => {
  const f = await open();
  const news = await f.list("News");
  const template = await f.template("<p>Hi {{ subscriber.name }}</p>", "Hello");
  // Marketing at once, then a transactional step a day later.
  const sequence = await f.sequence({
    name: "Marketing then receipt",
    list_id: news,
    trigger: { event: "order_paid" },
    steps: [
      { wait: "PT0S", kind: "marketing", template_id: template },
      { wait: "P1D", kind: "transactional", template_id: template },
    ],
  });
  const order = await f.json("/api/subscriber-events", "POST", {
    subscriber: { email: address, name: "Ada", grant_lists: [news] },
    name: "order_paid",
  });
  expect(order.status).toBe(200);
  const subscriber = asBody<number>(order.body.data.subscriber_id);
  const enrollment = async () => {
    const rows = asBody<{
      results: Array<{ sequence_id: number; status: string; exit_reason: string | null }>;
    }>((await f.json(`/api/enrollments?subscriber_id=${subscriber}`)).body.data).results;
    const row = must(
      rows.find((e) => e.sequence_id === sequence.id),
      "the enrollment of the sequence",
    );
    return { status: row.status, exit_reason: row.exit_reason };
  };

  // The marketing step is decided and its send recorded: the enrollment has moved past it.
  await f.until(() => sent(f, "marketing") === 1, "the marketing step's send");
  expect(await enrollment()).toEqual({ status: "active", exit_reason: null });

  // The subscriber leaves the list. The next step is transactional, so the enrollment keeps running.
  const left = await f.json("/api/subscribers/lists", "PUT", {
    ids: [subscriber],
    action: "unsubscribe",
    target_list_ids: [news],
  });
  expect(left.status).toBe(200);
  expect(await enrollment()).toEqual({ status: "active", exit_reason: null });

  // A day later the transactional step sends and the enrollment completes.
  await f.pass(day);
  await f.until(
    () => sent(f, "transactional") === 1,
    "the transactional step after the unsubscribe",
  );
  expect(sent(f, "marketing")).toBe(1);
  expect((await enrollment()).status).toBe("completed");
});
