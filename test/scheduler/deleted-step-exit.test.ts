// B130 (D128 item 9, r2): leaving a list ends an enrollment by the step it will run next. A waiting enrollment
// whose step was deleted runs the next active step, as the scheduler advances it; so leaving the list ends it
// only when that next step is marketing. Through the public link, the SMTP sink and the scheduler loop. States
// are read through GET /api/enrollments.
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

const address = "deleted-step@example.test";
const day = 86_400_000;

/** Mail the sink holds for the address: marketing mail carries List-Unsubscribe (D126, r2). */
function sent(f: SchedulerFixture, kind: "marketing" | "transactional") {
  return f.sink.messages.filter(
    (m) =>
      m.to.includes(address) && m.data.includes("List-Unsubscribe:") === (kind === "marketing"),
  ).length;
}

/** Each enrollment of the subscriber, as `status:exit_reason`, by sequence ID. */
async function states(f: SchedulerFixture, subscriber: number) {
  const listed = asBody<{
    results: Array<{ sequence_id: number; status: string; exit_reason: string | null }>;
  }>((await f.json(`/api/enrollments?subscriber_id=${subscriber}`)).body.data);
  return Object.fromEntries(
    listed.results.map((e) => [e.sequence_id, `${e.status}:${e.exit_reason}`]),
  );
}

/** Leave News through the subscriber's marketing mail's link: a one-click unsubscribe from that list. */
async function leaveNews(f: SchedulerFixture, subscriber: number) {
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
}

/** A News sequence whose one marketing step sends at once, so the subscriber has a marketing mail to leave News through. */
async function marketingMail(f: SchedulerFixture, news: number, template: number) {
  await f.sequence({
    name: "Marketing now",
    list_id: news,
    trigger: { event: "order_paid" },
    steps: [{ wait: "PT0S", kind: "marketing", template_id: template }],
  });
}

test("a waiting enrollment whose deleted step was marketing runs its next, transactional step after leaving the list", async () => {
  const f = await open();
  const news = await f.list("News");
  const template = await f.template("<p>Hi {{ subscriber.name }}</p>", "Hello");
  await marketingMail(f, news, template);
  // Marketing step A waits a day, then transactional step B waits a day more.
  const seq = await f.sequence({
    name: "Offer, then receipt",
    list_id: news,
    trigger: { event: "order_paid" },
    steps: [
      { wait: "P1D", kind: "marketing", template_id: template },
      { wait: "P2D", kind: "transactional", template_id: template },
    ],
  });
  const first = await f.json("/api/subscriber-events", "POST", {
    subscriber: { email: address, name: "Ada", grant_lists: [news] },
    name: "order_paid",
  });
  expect(first.status).toBe(200);
  const subscriber = asBody<number>(first.body.data.subscriber_id);
  const enrollment = (await states(f, subscriber))[seq.id];
  expect(enrollment).toBe("active:null");
  await f.until(() => sent(f, "marketing") === 1, "the marketing mail of the order");

  // Delete step A while the enrollment waits on it. Its next active step is B, transactional.
  const [, b] = seq.steps as Array<{ id: number }>;
  const edited = await f.json(`/api/sequences/${seq.id}`, "PUT", {
    name: "Offer, then receipt",
    list_id: news,
    status: "active",
    trigger: { event: "order_paid" },
    reentry: "always",
    steps: [{ id: b!.id, wait: "P2D", kind: "transactional", template_id: template }],
  });
  expect(edited.status).toBe(200);

  // Leaving News keeps the enrollment: its next step is transactional.
  await leaveNews(f, subscriber);
  expect((await states(f, subscriber))[seq.id]).toBe("active:null");

  // Its transactional step delivers when it comes due, and the enrollment completes.
  await f.pass(2 * day);
  await f.until(
    () => sent(f, "transactional") === 1,
    "the transactional step after the deleted one",
  );
  await f.until(
    async () => (await states(f, subscriber))[seq.id] === "completed:null",
    "the enrollment completes after its transactional step",
  );
  expect(sent(f, "marketing")).toBe(1);
});

test("a waiting enrollment whose deleted step was transactional ends when leaving the list, since its next step is marketing", async () => {
  const f = await open();
  const news = await f.list("News");
  const template = await f.template("<p>Hi {{ subscriber.name }}</p>", "Hello");
  await marketingMail(f, news, template);
  // Transactional step A waits a day, then marketing step B waits a day more.
  const seq = await f.sequence({
    name: "Receipt, then an offer",
    list_id: news,
    trigger: { event: "order_paid" },
    steps: [
      { wait: "P1D", kind: "transactional", template_id: template },
      { wait: "P2D", kind: "marketing", template_id: template },
    ],
  });
  const first = await f.json("/api/subscriber-events", "POST", {
    subscriber: { email: address, name: "Ada", grant_lists: [news] },
    name: "order_paid",
  });
  expect(first.status).toBe(200);
  const subscriber = asBody<number>(first.body.data.subscriber_id);
  await f.until(() => sent(f, "marketing") === 1, "the marketing mail of the order");
  expect((await states(f, subscriber))[seq.id]).toBe("active:null");

  // Delete step A while the enrollment waits on it. Its next active step is B, marketing.
  const [, b] = seq.steps as Array<{ id: number }>;
  const edited = await f.json(`/api/sequences/${seq.id}`, "PUT", {
    name: "Receipt, then an offer",
    list_id: news,
    status: "active",
    trigger: { event: "order_paid" },
    reentry: "always",
    steps: [{ id: b!.id, wait: "P2D", kind: "marketing", template_id: template }],
  });
  expect(edited.status).toBe(200);

  // Leaving News ends the enrollment now, before its next step comes due, and no marketing mail goes out.
  await leaveNews(f, subscriber);
  expect((await states(f, subscriber))[seq.id]).toBe("exited:unsubscribed");
  await f.pass(3 * day);
  expect(sent(f, "marketing")).toBe(1);
  expect(sent(f, "transactional")).toBe(0);
});

/**
 * The all-lists option, as its public form posts it (`blocklist=true`), through the same link as
 * `leaveNews`. It unsubscribes from every list, so the exit rule for a waiting enrollment applies to it too.
 */
async function leaveAllLists(f: SchedulerFixture, subscriber: number) {
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
}

// B130 r3: the deleted-step exit rule through the all-lists option. The deleted step was transactional and
// the next active step is marketing, so the all-lists option ends the enrollment as it does for one list.
// Mutation: the exit rule skipped for the all-lists option leaves the enrollment active, and the state check fails.
test("the all-lists option ends a waiting enrollment whose next step after a deleted transactional step is marketing", async () => {
  const f = await open();
  const news = await f.list("News");
  const template = await f.template("<p>Hi {{ subscriber.name }}</p>", "Hello");
  await marketingMail(f, news, template);
  const seq = await f.sequence({
    name: "Receipt, then an offer, all lists",
    list_id: news,
    trigger: { event: "order_paid" },
    steps: [
      { wait: "P1D", kind: "transactional", template_id: template },
      { wait: "P2D", kind: "marketing", template_id: template },
    ],
  });
  const first = await f.json("/api/subscriber-events", "POST", {
    subscriber: { email: address, name: "Ada", grant_lists: [news] },
    name: "order_paid",
  });
  expect(first.status).toBe(200);
  const subscriber = asBody<number>(first.body.data.subscriber_id);
  await f.until(() => sent(f, "marketing") === 1, "the marketing mail of the order");
  expect((await states(f, subscriber))[seq.id]).toBe("active:null");

  const [, b] = seq.steps as Array<{ id: number }>;
  const edited = await f.json(`/api/sequences/${seq.id}`, "PUT", {
    name: "Receipt, then an offer, all lists",
    list_id: news,
    status: "active",
    trigger: { event: "order_paid" },
    reentry: "always",
    steps: [{ id: b!.id, wait: "P2D", kind: "marketing", template_id: template }],
  });
  expect(edited.status).toBe(200);

  await leaveAllLists(f, subscriber);
  expect((await states(f, subscriber))[seq.id]).toBe("exited:unsubscribed");
  await f.pass(3 * day);
  expect(sent(f, "marketing")).toBe(1);
  expect(sent(f, "transactional")).toBe(0);
});
