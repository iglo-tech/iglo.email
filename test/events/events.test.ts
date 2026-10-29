// Subscriber events API behavior from docs/design/05-sequences.md#events-api, through
// POST /api/subscriber-events(/batch), the subscriber API and the event owner's reads.
import { afterEach, expect, test } from "bun:test";
import type { RecordedEvent } from "@/events/store";
import { MAX_SINGLES_IN_FLIGHT } from "@/events/routes";
import { eventsFixture, type EventsFixture } from "@/test/events/fixture";

const fixtures: EventsFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
async function open(options: Parameters<typeof eventsFixture>[0] = {}) {
  const f = await eventsFixture(options);
  fixtures.push(f);
  return f;
}
const day = 86_400_000;
const event = (subscriber: object, extra: object = {}) => ({
  subscriber,
  name: "order_paid",
  ...extra,
});
const ok = { started: [], ended: [] };

test("an unknown email creates an enabled subscriber without lists and records the event", async () => {
  const f = await open();
  const now = f.clock.now().toISOString();
  const r = await f.post(
    event(
      { email: " Ana@Example.com ", attribs: { plan: "subscription" } },
      { data: { price: 79, currency: "USD" } },
    ),
  );
  expect(r.status).toBe(200);
  expect(r.body).toEqual({
    data: { event_id: expect.any(Number), subscriber_id: expect.any(Number), enrollments: ok },
  });
  const s = await f.subscriber(r.body.data.subscriber_id);
  expect(s).toMatchObject({
    email: "ana@example.com",
    name: "Ana",
    status: "enabled",
    attribs: { plan: "subscription" },
    external_id: null,
    lists: [],
  });
  const [stored, ...rest] = f.events.list(BigInt(r.body.data.subscriber_id));
  expect(rest).toEqual([]);
  expect(stored).toMatchObject({
    id: BigInt(r.body.data.event_id),
    name: "order_paid",
    data: '{"price":79,"currency":"USD"}',
    occurred_at: now,
    created_at: now,
    idempotency_key: null,
  });
});

test("lookup is by external_id first; email on that subscriber updates the address", async () => {
  const f = await open();
  const first = await f.post(
    event({ external_id: "u_1", email: "one@example.com", name: "One", attribs: { a: 1, b: 2 } }),
  );
  const other = await f.post(event({ email: "two@example.com" }));
  const id = first.body.data.subscriber_id;
  f.clock.advance(1000);
  const moved = await f.post(
    event({ external_id: "u_1", email: "new@example.com", attribs: { b: null, c: { d: 3 } } }),
  );
  expect(moved.status).toBe(200);
  expect(moved.body.data.subscriber_id).toBe(id);
  const s = await f.subscriber(id);
  expect(s).toMatchObject({
    email: "new@example.com",
    name: "One",
    external_id: "u_1",
    attribs: { a: 1, c: { d: 3 } },
    updated_at: f.clock.now().toISOString(),
  });
  // external_id alone finds it; an event that changes nothing does not touch updated_at.
  f.clock.advance(1000);
  const again = await f.post(event({ external_id: "u_1" }));
  expect(again.body.data.subscriber_id).toBe(id);
  expect((await f.subscriber(id)).updated_at).toBe(s.updated_at);
  // The same address in a different case is not an update.
  await f.post(event({ external_id: "u_1", email: "NEW@example.com" }));
  expect((await f.subscriber(id)).updated_at).toBe(s.updated_at);
  expect(other.body.data.subscriber_id).not.toBe(id);
  expect(f.count("subscribers")).toBe(2);
});

test("an unknown subscriber without email is a safe 404 with no write", async () => {
  const f = await open();
  const r = await f.post(event({ external_id: "missing" }));
  expect(r.status).toBe(404);
  expect(r.body).toEqual({ message: "Subscriber not found" });
  expect(f.count("subscribers")).toBe(0);
  expect(f.count("events")).toBe(0);
  const none = await f.post(event({ name: "only a name" }));
  expect(none.status).toBe(400);
  expect(none.body.message).toContain("subscriber");
});

test("a new external_id is linked to a subscriber found by email, never re-pointed", async () => {
  const f = await open();
  const created = await f.post(event({ email: "ana@example.com" }));
  const id = created.body.data.subscriber_id;
  const linked = await f.post(event({ external_id: "u_9", email: "ana@example.com" }));
  expect(linked.body.data.subscriber_id).toBe(id);
  expect((await f.subscriber(id)).external_id).toBe("u_9");
  const before = await f.subscriber(id);
  const conflict = await f.post(
    event({ external_id: "u_10", email: "ana@example.com", attribs: { x: 1 } }),
  );
  expect(conflict.status).toBe(409);
  expect(await f.subscriber(id)).toEqual(before);
  expect(f.count("events")).toBe(2);
});

test("conflicts are 409 with no partial write", async () => {
  const f = await open();
  const a = (await f.post(event({ external_id: "a", email: "a@example.com", attribs: { k: 1 } })))
    .body.data.subscriber_id;
  const b = (await f.post(event({ external_id: "b", email: "b@example.com" }))).body.data
    .subscriber_id;
  const beforeA = await f.subscriber(a),
    beforeB = await f.subscriber(b);
  // A new email that belongs to another subscriber.
  const taken = await f.post(
    event({ external_id: "a", email: "b@example.com", name: "Changed", attribs: { k: 2 } }),
  );
  expect(taken.status).toBe(409);
  expect(taken.body).toEqual({ message: "E-mail already exists." });
  // external_id and email naming different subscribers.
  const crossed = await f.post(event({ external_id: "b", email: "a@example.com" }));
  expect(crossed.status).toBe(409);
  expect(await f.subscriber(a)).toEqual(beforeA);
  expect(await f.subscriber(b)).toEqual(beforeB);
  expect(f.count("events")).toBe(2);
});

test("blocklisted subscribers still get their events recorded", async () => {
  const f = await open();
  const id = (await f.post(event({ email: "blocked@example.com" }))).body.data.subscriber_id;
  expect((await f.json(`/api/subscribers/${id}/blocklist`, "PUT", {})).status).toBe(200);
  const r = await f.post(event({ email: "blocked@example.com", attribs: { seen: true } }));
  expect(r.status).toBe(200);
  expect(await f.subscriber(id)).toMatchObject({ status: "blocklisted", attribs: { seen: true } });
  expect(f.events.list(BigInt(id))).toHaveLength(2);
});

test("a repeated idempotency_key for the same subscriber returns the first result and changes nothing", async () => {
  const f = await open();
  const body = event(
    { external_id: "u_1", email: "ana@example.com", attribs: { plan: "trial" } },
    { idempotency_key: "polar:evt_1" },
  );
  const first = await f.post(body);
  const before = await f.subscriber(first.body.data.subscriber_id);
  f.clock.advance(5000);
  const retry = await f.post({
    ...body,
    subscriber: { external_id: "u_1", email: "changed@example.com", attribs: { plan: "paid" } },
    data: { different: true },
  });
  expect(retry).toEqual(first);
  expect(await f.subscriber(first.body.data.subscriber_id)).toEqual(before);
  expect(f.count("events")).toBe(1);
  // The key is per subscriber: another subscriber may use it.
  const other = await f.post({ ...body, subscriber: { email: "other@example.com" } });
  expect(other.status).toBe(200);
  expect(other.body.data.event_id).not.toBe(first.body.data.event_id);
  // Even a retry that would now conflict replays the first result.
  const conflicting = await f.post({
    ...body,
    subscriber: { external_id: "u_1", email: "other@example.com" },
  });
  expect(conflicting).toEqual(first);
});

test("idempotency holds under concurrent requests and after a restart", async () => {
  const f = await open();
  const body = event({ email: "race@example.com", attribs: { n: 1 } }, { idempotency_key: "k" });
  const results = await Promise.all(Array.from({ length: 20 }, () => f.post(body)));
  for (const r of results) expect(r).toEqual(results[0]!);
  expect(f.count("events")).toBe(1);
  expect(f.count("subscribers")).toBe(1);
  await f.restart();
  const later = await f.post({
    ...body,
    subscriber: { email: "race@example.com", attribs: { n: 2 } },
  });
  expect(later).toEqual(results[0]!);
  expect((await f.subscriber(later.body.data.subscriber_id)).attribs).toEqual({ n: 1 });
});

test("occurred_at is normalized UTC; events older than 7 days are stored but not trigger-eligible", async () => {
  const seen: RecordedEvent[] = [];
  const f = await open({
    exitThenTrigger: (e) => {
      seen.push(e);
      return { started: [], ended: [] };
    },
  });
  const now = f.clock.now().getTime();
  const at = (ms: number) => new Date(now - ms).toISOString();
  const send = (occurred_at?: string) =>
    f.post(event({ email: "w@example.com" }, occurred_at === undefined ? {} : { occurred_at }));
  expect((await send()).status).toBe(200);
  expect((await send(at(7 * day))).status).toBe(200);
  expect((await send(at(7 * day + 1))).status).toBe(200);
  expect((await send("2025-12-01T12:00:00+02:00")).status).toBe(200);
  expect((await send("2026-01-02T03:04:05.123456789Z")).status).toBe(200);
  expect(seen.map((e) => [e.occurredAt, e.triggerEligible])).toEqual([
    [at(0), true],
    [at(7 * day), true],
    [at(7 * day + 1), false],
    ["2025-12-01T10:00:00.000Z", false],
    ["2026-01-02T03:04:05.123Z", true],
  ]);
  for (const e of seen) expect(e.receivedAt).toBe(at(0));
  const stored = f.events.list(seen[0]!.subscriberId);
  expect(stored.map((row) => row.occurred_at)).toEqual(seen.map((e) => e.occurredAt));
  for (const bad of [
    "2026-01-02",
    "2026-01-02 03:04:05Z",
    "2026-02-30T00:00:00Z",
    "2026-01-02T24:00:00Z",
    "2026-01-02T03:04:60Z",
    "0099-01-01T00:00:00Z",
    "2026-01-02T03:04:05",
    "2026-01-02T03:04:05+24:00",
    "+275760-09-13T00:00:00Z",
    1735689600,
  ]) {
    const r = await f.post(event({ email: "w@example.com" }, { occurred_at: bad }));
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("occurred_at");
  }
  expect(seen).toHaveLength(5);
});

test("exit-then-trigger runs inside the event transaction; its failure rolls back the event and upsert", async () => {
  let fail = false;
  const f = await open({
    exitThenTrigger: () => {
      if (fail) throw new Error("sequence failure");
      expect(f.db.inTransaction).toBe(true);
      return { started: [7], ended: [3] };
    },
  });
  const r = await f.post(event({ email: "seam@example.com" }));
  expect(r.body.data.enrollments).toEqual({ started: [7], ended: [3] });
  fail = true;
  const failed = await f.post(event({ email: "seam2@example.com" }));
  expect(failed.status).toBe(500);
  expect(f.count("subscribers")).toBe(1);
  expect(f.count("events")).toBe(1);
  expect(f.errors).toHaveLength(1);
});

test("malformed and hostile input fails safely without writes", async () => {
  const f = await open({ domains: { block: ["blocked.test"] } });
  const raw = (body: string, type = "application/json") =>
    f.request("/api/subscriber-events", {
      method: "POST",
      headers: { ...f.api, "content-type": type },
      body,
    });
  expect((await raw("{")).status).toBe(400);
  expect((await raw("")).status).toBe(400);
  expect((await raw("[]")).status).toBe(400);
  expect((await raw("null")).status).toBe(400);
  expect((await raw(JSON.stringify(event({ email: "a@example.com" })), "text/plain")).status).toBe(
    415,
  );
  expect((await raw(`{"name":"x","pad":"${"a".repeat(70_000)}"}`)).status).toBe(413);
  expect((await raw(`${"[".repeat(30_000)}${"]".repeat(30_000)}`)).status).toBe(400);
  const nested = `{"events":[${'{"a":'.repeat(500_000)}1${"}".repeat(500_000)}]}`;
  const deepBatch = await f.request("/api/subscriber-events/batch", {
    method: "POST",
    headers: { ...f.api, "content-type": "application/json" },
    body: nested,
  });
  expect(deepBatch.status).toBeLessThan(500);
  const deep = `{"subscriber":{"email":"d@example.com"},"name":"x","data":${'{"a":'.repeat(40)}1${"}".repeat(40)}}`;
  expect((await raw(deep)).status).toBe(400);
  const infinite = `{"subscriber":{"email":"i@example.com"},"name":"x","data":{"n":1e999}}`;
  expect((await raw(infinite)).status).toBe(400);
  const invalidUtf8 = new Uint8Array([...Buffer.from('{"name":"'), 0xff, ...Buffer.from('"}')]);
  expect(
    (
      await f.request("/api/subscriber-events", {
        method: "POST",
        headers: { ...f.api, "content-type": "application/json" },
        body: invalidUtf8,
      })
    ).status,
  ).toBe(400);
  const cases: [unknown, string][] = [
    [event({ email: "a@example.com" }, { extra: 1 }), "extra"],
    [event({ email: "a@example.com", status: "blocklisted" }), "subscriber.status"],
    [event({ email: "a@example.com", lists: [1] }), "subscriber.lists"],
    [event({ email: "not-an-email" }), "subscriber.email"],
    [event({ email: `${"a".repeat(1000)}@example.com` }), "subscriber.email"],
    [event({ email: 7 }), "subscriber.email"],
    [event({ external_id: "" }), "subscriber.external_id"],
    [event({ external_id: "x\u0000" }), "subscriber.external_id"],
    [event({ external_id: "a".repeat(2001) }), "subscriber.external_id"],
    [event({ email: "a@example.com", name: "x\u0000" }), "subscriber.name"],
    [event({ email: "a@example.com", attribs: [1] }), "subscriber.attribs"],
    [event({ email: "a@example.com", attribs: { k: "v\u0000" } }), "subscriber.attribs"],
    [event({ email: "a@example.com" }, { name: "" }), "name"],
    [event({ email: "a@example.com" }, { name: "x\ny" }), "name"],
    [event({ email: "a@example.com" }, { name: "\ud800" }), "name"],
    [event({ email: "a@example.com" }, { name: "n".repeat(201) }), "name"],
    [event({ email: "a@example.com" }, { name: 5 }), "name"],
    [event({ email: "a@example.com" }, { data: [1] }), "data"],
    [event({ email: "a@example.com" }, { data: "{}" }), "data"],
    [event({ email: "a@example.com" }, { data: { s: "x".repeat(33_000) } }), "data"],
    [event({ email: "a@example.com" }, { idempotency_key: "" }), "idempotency_key"],
    [event({ email: "a@example.com" }, { idempotency_key: "k".repeat(256) }), "idempotency_key"],
    [event({ email: "a@example.com" }, { idempotency_key: 1 }), "idempotency_key"],
    [JSON.stringify("string"), "event"],
  ];
  for (const [body, field] of cases) {
    const r = await f.post(body);
    expect([r.status, r.body.message]).toEqual([400, `Invalid fields: ${field}`]);
  }
  const blocked = await f.post(event({ email: "x@blocked.test" }));
  expect(blocked).toEqual({ status: 400, body: { message: "The e-mail domain is blocklisted." } });
  expect(f.count("subscribers")).toBe(0);
  expect(f.count("events")).toBe(0);
  // `__proto__` is an ordinary key, and lone surrogates in values are made well-formed.
  const proto = await raw(
    '{"subscriber":{"email":"p@example.com","attribs":{"__proto__":{"admin":true},"s":"\\ud800"}},"name":"x","data":{"__proto__":1}}',
  );
  expect(proto.status).toBe(200);
  const id = ((await proto.json()) as { data: { subscriber_id: number } }).data.subscriber_id;
  expect((await f.subscriber(id)).attribs).toEqual(
    JSON.parse('{"__proto__":{"admin":true},"s":"�"}'),
  );
  expect(f.events.list(BigInt(id))[0]!.data).toBe('{"__proto__":1}');
});

test("merged attributes are bounded unless an event shrinks them", async () => {
  const f = await open();
  const id = (await f.post(event({ email: "big@example.com", attribs: { a: "x".repeat(30_000) } })))
    .body.data.subscriber_id;
  await f.post(event({ email: "big@example.com", attribs: { b: "x".repeat(30_000) } }));
  const before = await f.subscriber(id);
  const over = await f.post(
    event({ email: "big@example.com", attribs: { c: "x".repeat(10_000) } }),
  );
  expect(over).toEqual({ status: 400, body: { message: "Invalid attributes." } });
  expect(await f.subscriber(id)).toEqual(before);
  expect(f.events.list(BigInt(id))).toHaveLength(2);
  const removed = await f.post(event({ email: "big@example.com", attribs: { a: null } }));
  expect(removed.status).toBe(200);
  expect(Object.keys((await f.subscriber(id)).attribs)).toEqual(["b"]);
});

test("the subscriber_events:create permission is required and revalidated", async () => {
  const f = await open();
  const body = event({ email: "perm@example.com" });
  expect((await f.post(body, {})).status).toBe(403);
  const other = await f.apiUser("no-events", ["subscribers:manage", "subscriber_events:get"]);
  const denied = await f.post(body, other);
  expect(denied).toEqual({
    status: 403,
    body: { message: "permission denied: subscriber_events:create" },
  });
  expect((await f.batch({ events: [body] }, other)).status).toBe(403);
  // A cookie session needs its CSRF token.
  const { cookie } = f.sessionHeaders;
  expect((await f.post(body, { cookie })).status).toBe(403);
  expect((await f.post(body, f.sessionHeaders)).status).toBe(200);
  expect(f.count("events")).toBe(1);
});

test("a batch returns per-item results; each item is atomic and a bad item drops no others", async () => {
  const f = await open();
  const taken = (await f.post(event({ external_id: "t", email: "taken@example.com" }))).body.data
    .subscriber_id;
  const r = await f.batch({
    events: [
      event({ email: "b1@example.com" }, { idempotency_key: "k1" }),
      event({ email: "b1@example.com" }, { idempotency_key: "k1" }),
      event({ email: "b1@example.com", attribs: { n: 2 } }, { name: "second" }),
      { name: "missing subscriber" },
      event({ external_id: "t", email: "b1@example.com", attribs: { lost: true } }),
      event({ external_id: "nobody" }),
      event({ email: "b2@example.com" }),
    ],
  });
  expect(r.status).toBe(200);
  const results = r.body.data.results;
  expect(results.map((x: { status: number }) => x.status)).toEqual([
    200, 200, 200, 400, 409, 404, 200,
  ]);
  expect(results[1]).toEqual(results[0]);
  expect(results[2].subscriber_id).toBe(results[0].subscriber_id);
  expect(results[3]).toEqual({ status: 400, message: "Invalid fields: subscriber" });
  expect(results[4]).toEqual({ status: 409, message: "E-mail already exists." });
  expect((await f.subscriber(taken)).attribs).toEqual({});
  expect((await f.subscriber(results[0].subscriber_id)).attribs).toEqual({ n: 2 });
  expect(f.count("subscribers")).toBe(3);
  expect(f.count("events")).toBe(4);
});

test("batch limits: 1 to 500 events and a bounded body", async () => {
  const f = await open();
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => event({ email: `m${i}@example.com` }));
  expect((await f.batch({ events: [] })).status).toBe(400);
  expect((await f.batch({ events: many(501) })).body).toEqual({
    message: "Invalid fields: events",
  });
  expect((await f.batch([event({ email: "a@example.com" })])).status).toBe(400);
  expect((await f.batch({ events: many(1), more: 1 })).status).toBe(400);
  const huge = {
    events: [event({ email: "h@example.com" }, { data: { s: "x".repeat(4_200_000) } })],
  };
  expect((await f.batch(huge)).status).toBe(413);
  expect(f.count("events")).toBe(0);
  const full = await f.batch({ events: many(500) });
  expect(full.status).toBe(200);
  expect(full.body.data.results).toHaveLength(500);
  expect(f.count("events")).toBe(500);
});

test("an unexpected failure rolls back the whole batch", async () => {
  let calls = 0;
  const f = await open({
    exitThenTrigger: () => {
      if (++calls === 2) throw new Error("boom");
      return { started: [], ended: [] };
    },
  });
  const r = await f.batch({
    events: [event({ email: "r1@example.com" }), event({ email: "r2@example.com" })],
  });
  expect(r.status).toBe(500);
  expect(f.count("subscribers")).toBe(0);
  expect(f.count("events")).toBe(0);
});

test("retention purges events received more than 400 days ago in bounded batches", async () => {
  const f = await open();
  const id = (await f.post(event({ email: "old@example.com" }))).body.data.subscriber_id;
  for (let i = 0; i < 4; i++) await f.post(event({ email: "old@example.com" }));
  f.clock.advance(10 * day);
  // A backfill received now is retained from its receipt, not its occurred_at.
  await f.post(
    event({ email: "old@example.com" }, { occurred_at: "2020-01-01T00:00:00Z", name: "backfill" }),
  );
  f.clock.advance(390 * day + 1);
  const transactions: number[] = [];
  const purge = f.events.purge.bind(f.events);
  (f.events as { purge: typeof purge }).purge = (before, window) => {
    const deleted = purge(before, window);
    transactions.push(deleted.length);
    return deleted;
  };
  const loop = f.retention({ batchSize: 2 });
  for (let i = 0; i < 5; i++) {
    await f.clock.whenSleeping();
    f.clock.advance(0);
  }
  await f.clock.whenSleeping();
  expect(transactions).toEqual([2, 2, 1, 0]);
  expect(f.events.list(BigInt(id)).map((e) => e.name)).toEqual(["backfill"]);
  // Hourly afterwards; the backfill expires 400 days after it was received.
  f.clock.advance(10 * day);
  await Bun.sleep(0);
  await f.clock.whenSleeping();
  expect(f.events.list(BigInt(id))).toEqual([]);
  await loop.stop();
  expect(f.errors).toEqual([]);
});

test("concurrent single events share commits but keep independent results", async () => {
  const f = await open({
    exitThenTrigger: (e) => {
      if (e.name === "explode") throw new Error("sequence failure");
      return { started: [], ended: [] };
    },
  });
  await f.post(event({ external_id: "x", email: "x@example.com" }));
  await f.post(event({ email: "y@example.com" }));
  const denied = await f.apiUser("denied", ["subscribers:get_all"]);
  const results = await Promise.all([
    f.post(event({ email: "g1@example.com" })),
    f.post(event({ external_id: "x", email: "y@example.com", attribs: { lost: 1 } })),
    f.post(event({ email: "boom@example.com" }, { name: "explode" })),
    f.post(event({ email: "d@example.com" }), denied),
    f.post(event({ email: "g2@example.com" })),
  ]);
  expect(results.map((r) => r.status)).toEqual([200, 409, 500, 403, 200]);
  expect(f.count("subscribers")).toBe(4);
  expect(f.count("events")).toBe(4);
  expect(f.errors).toHaveLength(1);
});

test("a shared COMMIT failure fails every grouped request once, without replay", async () => {
  let poisonCalls = 0;
  const f = await open({
    exitThenTrigger: (e) => {
      if (e.name === "poison") {
        poisonCalls++;
        // A deferred foreign-key violation passes the savepoint and fails only at COMMIT.
        f.db.run("PRAGMA defer_foreign_keys = ON");
        f.db.run(
          "INSERT INTO events (subscriber_id, name, data, occurred_at, created_at) VALUES (999999999, 'orphan', '{}', ?, ?)",
          [e.occurredAt, e.receivedAt],
        );
      }
      return { started: [], ended: [] };
    },
  });
  const results = await Promise.all([
    f.post(event({ email: "c1@example.com" })),
    f.post(event({ email: "c2@example.com" }, { name: "poison" })),
    f.post(event({ email: "c3@example.com" })),
  ]);
  expect(results.map((r) => r.status)).toEqual([500, 500, 500]);
  expect(poisonCalls).toBe(1);
  expect(f.count("subscribers")).toBe(0);
  expect(f.count("events")).toBe(0);
  // The store recovers for later requests.
  expect((await f.post(event({ email: "after@example.com" }))).status).toBe(200);
});

test("single-event admission is bounded and recovers after saturation", async () => {
  const f = await open();
  const held: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const pending = Array.from({ length: MAX_SINGLES_IN_FLIGHT }, () =>
    f.postStream(
      new ReadableStream<Uint8Array>({
        start(controller) {
          held.push(controller);
        },
      }),
    ),
  );
  for (let i = 0; i < 200 && held.length < MAX_SINGLES_IN_FLIGHT; i++) await Bun.sleep(5);
  await Bun.sleep(50);
  const shed = await f.post(event({ email: "over@example.com" }));
  expect(shed.status).toBe(429);
  const body = new TextEncoder().encode(JSON.stringify(event({ email: "held@example.com" })));
  for (const controller of held) {
    controller.enqueue(body);
    controller.close();
  }
  const statuses = (await Promise.all(pending)).map((r) => r.status);
  expect(statuses.filter((status) => status !== 200 && status !== 409)).toEqual([]);
  expect((await f.post(event({ email: "recovered@example.com" }))).status).toBe(200);
});
