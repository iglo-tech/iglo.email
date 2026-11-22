// B124 (D125): a self-wiped person is not silently re-opted into marketing. The audit repro through
// the events API, the subscribers API, the paired public wipe, the scheduler loop and the SMTP sink:
// a grant and a marketing mail, a self-wipe, the same event again (suppressed, no marketing,
// transactional still sent), a replay under an idempotency key, and an operator's explicit removal.
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

const address = "wiped@example.test";
const externalId = "app-customer-7";

/** Mail the sink holds for the address: marketing mail carries List-Unsubscribe (D126, r2). */
function sent(f: SchedulerFixture, kind: "marketing" | "transactional") {
  return f.sink.messages.filter(
    (m) =>
      m.to.includes(address) && m.data.includes("List-Unsubscribe:") === (kind === "marketing"),
  ).length;
}

test("a self-wiped person gets no marketing again, and their transactional mail still goes", async () => {
  const f = await open();
  const news = await f.list("News");
  const template = await f.template("<p>Hi {{ subscriber.name }}</p>", "Hello");
  const marketing = await f.sequence({
    name: "Marketing",
    list_id: news,
    reentry: "always",
    trigger: { event: "order_paid" },
    steps: [{ wait: "PT0S", kind: "marketing", template_id: template }],
  });
  const receipt = await f.sequence({
    name: "Receipt",
    reentry: "always",
    trigger: { event: "order_paid" },
    steps: [{ wait: "PT0S", kind: "transactional", template_id: template }],
  });
  const order = (extra: JsonObject = {}) =>
    f.json("/api/subscriber-events", "POST", {
      subscriber: {
        email: address,
        name: "Wiped",
        external_id: externalId,
        grant_lists: [news],
      },
      name: "order_paid",
      ...extra,
    });

  // 1. The grant adds consent; the marketing sequence sends its mail.
  const first = await order();
  expect(first.status).toBe(200);
  expect(first.body.data.grants).toEqual([{ list_id: news, result: "added" }]);
  const subscriber = first.body.data.subscriber_id as number;
  await f.until(() => sent(f, "marketing") === 1, "the marketing mail");
  await f.until(() => sent(f, "transactional") === 1, "the receipt of the first event");

  // 2. The person wipes through the paired link of their marketing mail.
  const uuid = (await f.json(`/api/subscribers/${subscriber}`)).body.data.uuid as string;
  const send = (
    f.db.query("SELECT uuid FROM sends WHERE to_email = ? AND kind = 'marketing'").get(address) as {
      uuid: string;
    }
  ).uuid;
  expect((await f.request(`/m/${send}/wipe/${uuid}?confirm=true`, { method: "POST" })).status).toBe(
    200,
  );
  expect((await f.json(`/api/subscribers/${subscriber}`)).status).not.toBe(200);
  // The table is read only to prove the absence: a row names the person by keyed hashes.
  const rows = JSON.stringify(f.db.query("SELECT * FROM suppressions").all(), (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  expect(rows).toContain("email_hash");
  expect(rows).not.toContain(address);
  expect(rows).not.toContain(externalId);

  // 3. An operator creates the address by hand with a marketing list: no list is given.
  const created = await f.json("/api/subscribers", "POST", {
    email: address,
    name: "Wiped",
    lists: [news],
  });
  expect(created.status).toBe(200);
  expect(created.body.data.lists).toEqual([]);

  // 4. The same event again: suppressed, the transactional sequence starts, marketing does not.
  const again = await order();
  expect(again.status).toBe(200);
  expect(again.body.data.grants).toEqual([{ list_id: news, result: "suppressed" }]);
  expect(
    again.body.data.enrollments.started.map((s: { sequence_id: number }) => s.sequence_id),
  ).toEqual([receipt.id]);
  const person = again.body.data.subscriber_id as number;
  await f.until(() => sent(f, "transactional") === 2, "the transactional mail after the wipe");
  await f.pass();
  await f.pass();
  expect(sent(f, "marketing")).toBe(1);
  const marketingEnrollments = f.db
    .query("SELECT count(*) AS n FROM enrollments WHERE sequence_id = ? AND subscriber_id = ?")
    .get(marketing.id, person) as { n: number | bigint };
  expect(Number(marketingEnrollments.n)).toBe(0);

  // 5. A repeat under an idempotency key replays the suppressed answer, and changes nothing.
  const keyed = await order({ idempotency_key: "audit:1" });
  const replay = await order({ idempotency_key: "audit:1" });
  expect(keyed.body.data.grants).toEqual([{ list_id: news, result: "suppressed" }]);
  expect(replay.body.data).toEqual(keyed.body.data);

  // 6. An operator removes the suppression on the person's explicit request, once. A second
  // removal finds nothing, and the next grant is an ordinary one.
  const removed = await f.json("/api/suppressions", "DELETE", { email: address });
  expect(removed.status).toBe(200);
  expect(removed.body.data).toEqual({ removed: 1 });
  expect((await f.json("/api/suppressions", "DELETE", { email: address })).body.data).toEqual({
    removed: 0,
  });
  const honoured = await order();
  expect(honoured.body.data.grants).toEqual([{ list_id: news, result: "added" }]);
  await f.until(() => sent(f, "marketing") === 2, "marketing after an explicit removal");
});

test("a blocklisted subscriber keeps the blocklisted answer rather than the suppressed one", async () => {
  const f = await open();
  const news = await f.list("News");
  const created = await f.json("/api/subscribers", "POST", { email: "blocked@example.test" });
  const id = created.body.data.id as number;
  await f.json("/api/subscribers/blocklist", "PUT", { ids: [id] });
  const r = await f.json("/api/subscriber-events", "POST", {
    subscriber: { email: "blocked@example.test", grant_lists: [news] },
    name: "order_paid",
  });
  expect(r.body.data.grants).toEqual([{ list_id: news, result: "blocklisted" }]);
});
