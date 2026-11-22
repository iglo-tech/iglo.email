// POST /api/enrollments names a subscriber the caller must be able to read under the rule of
// GET /api/subscribers/:id (D103): one it cannot read answers 404 like an absent one, and writes
// nothing. Through the HTTP API with scoped API users and an all-access reader for the checks.
import { afterEach, expect, test } from "bun:test";
import { sequencesFixture } from "@/test/sequences/fixture";
import type { JsonObject } from "@/test/json-object";
import type { SequencesFixture } from "@/test/sequences/fixture";

const fixtures: Array<SequencesFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open() {
  const f = await sequencesFixture();
  fixtures.push(f);
  return f;
}
const absent = { status: 404, body: { message: "Subscriber not found", code: "not_found" } };

async function sequence(f: SequencesFixture, extra: JsonObject = {}) {
  const tx = await f.template();
  const created = await f.json("/api/sequences", "POST", {
    name: "Scoped",
    status: "active",
    trigger: { event: "order_paid" },
    reentry: "always",
    steps: [{ wait: "P3D", kind: "transactional", template_id: tx }],
    ...extra,
  });
  if (created.status !== 200) {
    throw new Error(JSON.stringify(created.body));
  }
  return created.body.data.id as number;
}

/** A caller that may manage enrollments and read subscribers on list `a` only. */
async function scoped(f: SequencesFixture, list: number) {
  return f.apiUser(
    ["sequences:manage", "subscribers:get"],
    [{ id: list, permissions: ["list:get"] }],
  );
}

/** Enrollments of one subscriber, read by a caller that sees everything. */
const enrollmentsOf = async (f: SequencesFixture, subscriber: number) =>
  (await f.json(`/api/enrollments?subscriber_id=${subscriber}`)).body.data.total as number;

test("D103: a scoped caller enrolls a subscriber on one of its lists", async () => {
  const f = await open();
  const a = await f.list("a");
  const seq = await sequence(f);
  const id = await f.subscriber("on-a@example.test", { lists: [a] });
  const caller = await scoped(f, a);
  const r = await f.json(
    "/api/enrollments",
    "POST",
    { sequence_id: seq, subscriber_id: id },
    caller,
  );
  expect(r.status).toBe(200);
  expect(r.body.data).toMatchObject({ subscriber_id: id, sequence_id: seq, status: "active" });
});

test("D103: a subscriber only on another list is 404 like an absent one, with no enrollment", async () => {
  const f = await open();
  const a = await f.list("a");
  const b = await f.list("b");
  const seq = await sequence(f);
  const other = await f.subscriber("only-b@example.test", { lists: [b] });
  const caller = await scoped(f, a);
  const before = f.count("enrollments");

  const refused = await f.json(
    "/api/enrollments",
    "POST",
    { sequence_id: seq, subscriber_id: other },
    caller,
  );
  expect(refused).toEqual(absent);
  const missing = await f.json(
    "/api/enrollments",
    "POST",
    { sequence_id: seq, subscriber_id: 999_999 },
    caller,
  );
  expect(missing).toEqual(absent);
  expect(f.count("enrollments")).toBe(before);
  expect(await enrollmentsOf(f, other)).toBe(0);
});

test("D103: the refusal is the same for test enrollments and for a trigger event", async () => {
  const f = await open();
  const a = await f.list("a");
  const b = await f.list("b");
  const seq = await sequence(f);
  const other = await f.subscriber("only-b-2@example.test", { lists: [b] });
  const event = await f.event({
    subscriber: { email: "only-b-2@example.test" },
    name: "order_paid",
  });
  const caller = await scoped(f, a);
  // The event itself starts an enrollment: the refusals must leave the count as it is.
  const before = f.count("enrollments");
  const baseline = await enrollmentsOf(f, other);
  // The subscriber check comes first: neither the event nor the test rules are reached.
  const cases: Array<object> = [
    { test: true },
    { force: true },
    { trigger_event_id: event.body.data.event_id },
    { test: true, trigger_event_id: event.body.data.event_id },
    { trigger_event_id: 999_999 },
  ];
  for (const extra of cases) {
    const r = await f.json(
      "/api/enrollments",
      "POST",
      { sequence_id: seq, subscriber_id: other, ...extra },
      caller,
    );
    expect([extra, r]).toEqual([extra, absent]);
  }
  expect(f.count("enrollments")).toBe(before);
  expect(await enrollmentsOf(f, other)).toBe(baseline);
});

test("D103: a caller that reads every subscriber and every list is unaffected", async () => {
  const f = await open();
  const b = await f.list("b");
  const seq = await sequence(f);
  const other = await f.subscriber("only-b-3@example.test", { lists: [b] });
  const everything = await f.apiUser(["sequences:manage", "subscribers:get_all", "lists:get_all"]);
  const r = await f.json(
    "/api/enrollments",
    "POST",
    { sequence_id: seq, subscriber_id: other, test: true },
    everything,
  );
  expect(r.status).toBe(200);
  expect(r.body.data).toMatchObject({ subscriber_id: other, test: true });
});

test("D103: subscribers:get_all without list read scope is refused a list-B subscriber as absent", async () => {
  const f = await open();
  const b = await f.list("b");
  const seq = await sequence(f);
  const other = await f.subscriber("only-b-4@example.test", { lists: [b] });
  // The same rule as GET /api/subscribers/:id, which refuses this reader too (403).
  const bare = await f.apiUser(["sequences:manage", "subscribers:get_all"]);
  expect(
    await f.json("/api/enrollments", "POST", { sequence_id: seq, subscriber_id: other }, bare),
  ).toEqual(absent);
  expect(await enrollmentsOf(f, other)).toBe(0);
});

test("D103: a caller without read access to subscribers is refused the same way", async () => {
  const f = await open();
  const a = await f.list("a");
  const seq = await sequence(f);
  const id = await f.subscriber("unreadable@example.test", { lists: [a] });
  const manageOnly = await f.apiUser(
    ["sequences:manage"],
    [{ id: a, permissions: ["list:manage"] }],
  );
  expect(
    await f.json("/api/enrollments", "POST", { sequence_id: seq, subscriber_id: id }, manageOnly),
  ).toEqual(absent);
  expect(await enrollmentsOf(f, id)).toBe(0);
});
