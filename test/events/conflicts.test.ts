// An address another subscriber holds, named by an event or a subscriber write (D129), through
// POST /api/subscriber-events(/batch), PUT /api/subscribers/external/:id and POST /api/subscribers.
import { afterEach, expect, test } from "bun:test";
import { eventsFixture } from "@/test/events/fixture";
import type { EventsFixture } from "@/test/events/fixture";

const fixtures: Array<EventsFixture> = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.close();
  }
});
async function open() {
  const f = await eventsFixture();
  fixtures.push(f);
  return f;
}
const event = (subscriber: object, extra: object = {}) => ({
  subscriber,
  name: "order_paid",
  ...extra,
});
/** A subscriber made through the admin API, with the given list memberships. */
async function make(f: EventsFixture, body: Record<string, unknown>) {
  const r = await f.json("/api/subscribers", "POST", {
    status: "enabled",
    attribs: {},
    preconfirm_subscriptions: true,
    ...body,
  });
  expect(r.status).toBe(200);
  return r.body.data.id as number;
}

test("an address held by a subscriber with no external_id is claimed, keeping lists and history", async () => {
  const f = await open();
  const news = await f.list("news");
  const holder = await make(f, { email: "ana@example.com", name: "Ana", lists: [news] });
  // Earlier history of the holder: an event that names it by address only.
  expect((await f.post(event({ email: "ana@example.com" }))).status).toBe(200);
  const claimed = await f.post(
    event({
      external_id: "u_1",
      email: "ana@example.com",
      name: "Ana Lee",
      attribs: { plan: "pro" },
    }),
  );
  expect(claimed.status).toBe(200);
  expect(claimed.body.data.subscriber_id).toBe(holder);
  expect(await f.subscriber(holder)).toMatchObject({
    id: holder,
    email: "ana@example.com",
    name: "Ana Lee",
    external_id: "u_1",
    attribs: { plan: "pro" },
    lists: [{ id: news, subscription_status: "confirmed" }],
  });
  expect(f.count("subscribers")).toBe(1);
  expect(f.events.list(BigInt(holder))).toHaveLength(2);
  // Lookup is now by the external ID the claim set.
  const again = await f.post(event({ external_id: "u_1" }));
  expect(again.body.data.subscriber_id).toBe(holder);
});

test("a scoped caller claims only a holder on one of its lists, and the refusal writes nothing", async () => {
  const f = await open();
  const news = await f.list("news");
  const other = await f.list("other");
  const scoped = await f.apiUser(
    "scoped-events",
    ["subscriber_events:create"],
    [{ id: news, permissions: ["list:manage"] }],
  );
  const outside = await make(f, { email: "out@example.com", name: "Out", lists: [other] });
  const refused = await f.post(event({ external_id: "u_2", email: "out@example.com" }), scoped);
  // The holder is not on the caller's lists, so neither the claim nor the holder is revealed.
  expect(refused).toEqual({
    status: 409,
    body: { message: "E-mail already exists.", code: "email_conflict" },
  });
  expect(await f.subscriber(outside)).toMatchObject({ external_id: null, lists: [{ id: other }] });
  expect(f.count("events")).toBe(0);

  const inside = await make(f, { email: "in@example.com", name: "In", lists: [news] });
  const allowed = await f.post(event({ external_id: "u_3", email: "in@example.com" }), scoped);
  expect(allowed.status).toBe(200);
  expect(allowed.body.data.subscriber_id).toBe(inside);
  expect((await f.subscriber(inside)).external_id).toBe("u_3");
});

test("an external_id held by another subscriber refuses the claim: the address is not taken from it", async () => {
  const f = await open();
  const holder = await make(f, { email: "h@example.com", name: "H" });
  const subscriber = (await f.post(event({ external_id: "s_1", email: "s@example.com" }))).body.data
    .subscriber_id;
  const before = await f.subscriber(subscriber);
  const refused = await f.post(event({ external_id: "s_1", email: "h@example.com" }));
  // The holder has no external_id, so nothing names it; the event's external_id stays where it is.
  expect(refused).toEqual({
    status: 409,
    body: { message: "E-mail already exists.", code: "email_conflict" },
  });
  expect(await f.subscriber(subscriber)).toEqual(before);
  expect((await f.subscriber(holder)).external_id).toBeNull();
  expect(f.count("events")).toBe(1);
});

test("a conflict with a holder that has an external_id names it to a caller that manages the holder", async () => {
  const f = await open();
  const news = await f.list("news");
  const other = await f.list("other");
  const holder = await make(f, {
    email: "h@example.com",
    name: "H",
    external_id: "h_1",
    lists: [other],
  });
  const subscriber = (await f.post(event({ external_id: "s_1", email: "s@example.com" }))).body.data
    .subscriber_id;
  const before = { s: await f.subscriber(subscriber), h: await f.subscriber(holder) };
  const scoped = await f.apiUser(
    "scoped-events",
    ["subscriber_events:create"],
    [{ id: news, permissions: ["list:manage"] }],
  );
  const hidden = await f.post(event({ external_id: "s_1", email: "h@example.com" }), scoped);
  expect(hidden).toEqual({
    status: 409,
    body: { message: "E-mail already exists.", code: "email_conflict" },
  });
  const named = await f.post(event({ external_id: "s_1", email: "h@example.com" }));
  expect(named).toEqual({
    status: 409,
    body: {
      message: "E-mail already exists.",
      code: "email_conflict",
      conflict: { external_id: "h_1" },
    },
  });
  expect(await f.subscriber(subscriber)).toEqual(before.s);
  expect(await f.subscriber(holder)).toEqual(before.h);
  expect(f.count("events")).toBe(1);
});

test("a batch item carries its own claim and conflict, with the same code and conflict as a single event", async () => {
  const f = await open();
  const claimable = await make(f, { email: "c@example.com", name: "C" });
  await make(f, { email: "d@example.com", name: "D", external_id: "d_1" });
  const r = await f.batch({
    events: [
      event({ external_id: "c_1", email: "c@example.com" }),
      event({ external_id: "x_1", email: "d@example.com" }),
    ],
  });
  expect(r.status).toBe(200);
  const [claim, conflict] = r.body.data.results;
  expect(claim).toMatchObject({ status: 200, subscriber_id: claimable });
  // The address resolves to D, which has another external_id: the message names that case.
  expect(conflict).toEqual({
    status: 409,
    message: "External ID and e-mail belong to different subscribers.",
    code: "email_conflict",
    conflict: { external_id: "d_1" },
  });
  expect((await f.subscriber(claimable)).external_id).toBe("c_1");
  expect(f.count("events")).toBe(1);
});

test("a repeated idempotency_key replays the first claim without a second write", async () => {
  const f = await open();
  const holder = await make(f, { email: "r@example.com", name: "R" });
  const body = event({ external_id: "r_1", email: "r@example.com" }, { idempotency_key: "k-1" });
  const first = await f.post(body);
  expect(first.status).toBe(200);
  const retry = await f.post(body);
  expect(retry.body).toEqual(first.body);
  expect(retry.body.data.subscriber_id).toBe(holder);
  expect(f.count("events")).toBe(1);
});

test("PUT by external_id names the holder of a new e-mail, and a taken external_id is external_id_conflict", async () => {
  const f = await open();
  await make(f, { email: "h@example.com", name: "H", external_id: "h_1" });
  const subscriber = (await f.post(event({ external_id: "s_1", email: "s@example.com" }))).body.data
    .subscriber_id;
  const before = await f.subscriber(subscriber);
  const taken = await f.json("/api/subscribers/external/s_1", "PUT", {
    email: "h@example.com",
    name: "S",
    status: "enabled",
    attribs: {},
  });
  expect(taken).toEqual({
    status: 409,
    body: {
      message: "E-mail already exists.",
      code: "email_conflict",
      conflict: { external_id: "h_1" },
    },
  });
  expect(await f.subscriber(subscriber)).toEqual(before);

  const other = await f.post(event({ external_id: "t_1", email: "t@example.com" }));
  expect(other.status).toBe(200);
  const externalTaken = await f.json("/api/subscribers/external/s_1", "PUT", {
    email: "s@example.com",
    name: "S",
    status: "enabled",
    attribs: {},
    external_id: "t_1",
  });
  expect(externalTaken).toEqual({
    status: 409,
    body: { message: "External ID already exists", code: "external_id_conflict" },
  });
});

test("POST /api/subscribers names the holder only to a caller that manages it", async () => {
  const f = await open();
  const news = await f.list("news");
  await make(f, { email: "h@example.com", name: "H", external_id: "h_1", lists: [news] });
  const scoped = await f.apiUser(
    "scoped-admin",
    ["subscribers:manage"],
    [{ id: news, permissions: ["list:manage"] }],
  );
  const body = { email: "h@example.com", name: "Again", status: "enabled", attribs: {} };
  const inScope = await f.json("/api/subscribers", "POST", body, scoped);
  expect(inScope).toEqual({
    status: 409,
    body: {
      message: "E-mail already exists.",
      code: "email_conflict",
      conflict: { external_id: "h_1" },
    },
  });
  const outside = await f.apiUser("unscoped-admin", ["subscribers:manage"]);
  const hidden = await f.json("/api/subscribers", "POST", body, outside);
  expect(hidden).toEqual({
    status: 409,
    body: { message: "E-mail already exists.", code: "email_conflict" },
  });
  expect(f.count("subscribers")).toBe(1);
});
