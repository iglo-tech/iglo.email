// Consent-safe list grants on subscriber events (docs/design/05-sequences.md#events-api, D99),
// observed through POST /api/subscriber-events(/batch), the subscriber and list APIs.
import { afterEach, expect, test } from "bun:test";
import { createTranslation } from "@/i18n/i18n";
import { eventsFixture } from "@/test/events/fixture";
import type { EventsFixture } from "@/test/events/fixture";

const fixtures: Array<EventsFixture> = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.close();
  }
});
async function open(language = "en") {
  const f = await eventsFixture({ language });
  fixtures.push(f);
  return f;
}
const order = (subscriber: object, extra: object = {}) => ({
  subscriber,
  name: "order_paid",
  ...extra,
});
const invalid = "Invalid fields: subscriber.grant_lists";

/** A subscriber's membership status on one list, or null when it has none. */
async function membership(f: EventsFixture, subscriberId: number, list: number) {
  const row = (await f.subscriber(subscriberId)).lists.find((l: { id: number }) => l.id === list);
  return row?.subscription_status ?? null;
}
async function unsubscribe(f: EventsFixture, subscriberId: number, list: number) {
  const r = await f.json("/api/subscribers/lists", "PUT", {
    ids: [subscriberId],
    action: "unsubscribe",
    target_list_ids: [list],
  });
  expect(r.status).toBe(200);
}

test("a grant adds a confirmed membership to a new subscriber in the same request", async () => {
  const f = await open();
  const news = await f.list("news");
  const r = await f.post(order({ email: "ana@example.test", grant_lists: [news] }));
  expect(r.status).toBe(200);
  expect(r.body.data.grants).toEqual([{ list_id: news, result: "added" }]);
  const id = r.body.data.subscriber_id;
  expect(await f.subscriber(id)).toMatchObject({ status: "enabled" });
  expect(await membership(f, id, news)).toBe("confirmed");
});

test("after a one-click unsubscribe, a repeated grant reports unsubscribed and changes nothing", async () => {
  const f = await open();
  const news = await f.list("news");
  const first = await f.post(order({ email: "ana@example.test", grant_lists: [news] }));
  const id = first.body.data.subscriber_id as number;
  await unsubscribe(f, id, news);
  expect(await membership(f, id, news)).toBe("unsubscribed");
  const again = await f.post(order({ email: "ana@example.test", grant_lists: [news] }));
  expect(again.status).toBe(200);
  expect(again.body.data.grants).toEqual([{ list_id: news, result: "unsubscribed" }]);
  expect(await membership(f, id, news)).toBe("unsubscribed");
});

test("member reports member and keeps its status: unconfirmed stays unconfirmed, confirmed stays", async () => {
  const f = await open();
  const news = await f.list("news");
  const other = await f.list("other");
  const pending = await f.json("/api/subscribers", "POST", {
    email: "pending@example.test",
    name: "Pending",
    lists: [news],
  });
  const confirmed = await f.json("/api/subscribers", "POST", {
    email: "confirmed@example.test",
    name: "Confirmed",
    lists: [other],
    preconfirm_subscriptions: true,
  });
  const a = await f.post(order({ email: "pending@example.test", grant_lists: [news] }));
  expect(a.body.data.grants).toEqual([{ list_id: news, result: "member" }]);
  expect(await membership(f, pending.body.data.id, news)).toBe("unconfirmed");
  const b = await f.post(order({ email: "confirmed@example.test", grant_lists: [other] }));
  expect(b.body.data.grants).toEqual([{ list_id: other, result: "member" }]);
  expect(await membership(f, confirmed.body.data.id, other)).toBe("confirmed");
});

test("a blocklisted subscriber gets blocklisted for every list, no membership, and the event is stored", async () => {
  const f = await open();
  const news = await f.list("news");
  const other = await f.list("other");
  const created = await f.json("/api/subscribers", "POST", {
    email: "blocked@example.test",
    name: "Blocked",
  });
  const id = created.body.data.id as number;
  const blocked = await f.json("/api/subscribers/blocklist", "PUT", { ids: [id] });
  expect(blocked.status).toBe(200);
  const before = f.count("events");
  const r = await f.post(order({ email: "blocked@example.test", grant_lists: [news, other] }));
  expect(r.status).toBe(200);
  expect(r.body.data.grants).toEqual([
    { list_id: news, result: "blocklisted" },
    { list_id: other, result: "blocklisted" },
  ]);
  expect(f.count("events")).toBe(before + 1);
  expect((await f.subscriber(id)).lists).toEqual([]);
});

test("grants are reported in request order, one result per list", async () => {
  const f = await open();
  const a = await f.list("a");
  const b = await f.list("b");
  const c = await f.list("c");
  await f.json("/api/subscribers", "POST", {
    email: "mix@example.test",
    name: "Mix",
    lists: [b],
    preconfirm_subscriptions: true,
  });
  const r = await f.post(order({ email: "mix@example.test", grant_lists: [c, b, a] }));
  expect(r.body.data.grants).toEqual([
    { list_id: c, result: "added" },
    { list_id: b, result: "member" },
    { list_id: a, result: "added" },
  ]);
});

test("no grant asked means grants is an empty array, and null means no grant too", async () => {
  const f = await open();
  const none = await f.post(order({ email: "none@example.test" }));
  expect(none.body.data.grants).toEqual([]);
  const nulled = await f.post(order({ email: "nulled@example.test", grant_lists: null }));
  expect(nulled.status).toBe(200);
  expect(nulled.body.data.grants).toEqual([]);
});

test("invalid grant lists are a 400 with no write", async () => {
  const f = await open();
  const news = await f.list("news");
  const double = await f.list("double", "double");
  const many = Array.from({ length: 21 }, (_, i) => news + i);
  const cases: Array<unknown> = [
    [],
    [news, news],
    [news, 1.5],
    [news, "2"],
    [news, -1],
    [news, 0],
    [999_999],
    [double],
    many,
    "news",
    {},
  ];
  for (const grant_lists of cases) {
    const before = [f.count("events"), f.count("subscribers")];
    const r = await f.post(order({ email: "x@example.test", grant_lists }));
    expect({ grant_lists, status: r.status, message: r.body?.message }).toEqual({
      grant_lists,
      status: 400,
      message: invalid,
    });
    expect([f.count("events"), f.count("subscribers")]).toEqual(before);
  }
});

test("a grant may name up to 20 distinct lists", async () => {
  const f = await open();
  const lists: Array<number> = [];
  for (let i = 0; i < 20; i++) {
    lists.push(await f.list(`l${i}`));
  }
  const r = await f.post(order({ email: "many@example.test", grant_lists: lists }));
  expect(r.status).toBe(200);
  expect(r.body.data.grants.map((g: { list_id: number }) => g.list_id)).toEqual(lists);
});

test("a batch with one bad grant records the other events and reports the bad one", async () => {
  const f = await open();
  const news = await f.list("news");
  const r = await f.batch({
    events: [
      order({ email: "one@example.test", grant_lists: [news] }),
      order({ email: "two@example.test", grant_lists: [999_999] }),
      order({ email: "three@example.test", grant_lists: [news] }),
    ],
  });
  expect(r.status).toBe(200);
  const [first, second, third] = r.body.data.results;
  expect(first).toMatchObject({ status: 200, grants: [{ list_id: news, result: "added" }] });
  expect(second).toEqual({ status: 400, message: invalid, code: "invalid_fields" });
  expect(third).toMatchObject({ status: 200, grants: [{ list_id: news, result: "added" }] });
  expect(f.count("events")).toBe(2);
  expect(f.count("subscribers")).toBe(2);
});

test("an event that cannot receive a grant writes nothing, even the subscriber it would create", async () => {
  const f = await open();
  const news = await f.list("news");
  const r = await f.post(order({ email: "ghost@example.test", grant_lists: [news, 999_999] }));
  expect(r.status).toBe(400);
  expect(f.count("subscribers")).toBe(0);
  expect(f.count("events")).toBe(0);
});

test("a token needs manage scope on every granted list: otherwise 403 and nothing is written", async () => {
  const f = await open();
  const news = await f.list("news");
  const other = await f.list("other");
  // Event creation but no subscribers:manage at all.
  const events = await f.apiUser("events-only", ["subscriber_events:create"]);
  const denied = await f.post(order({ email: "d1@example.test", grant_lists: [news] }), events);
  expect(denied.status).toBe(403);
  // subscribers:manage, but only the read scope on the list.
  const read = await f.apiUser(
    "read-scope",
    ["subscriber_events:create", "subscribers:manage"],
    [{ id: news, permissions: ["list:get"] }],
  );
  const readOnly = await f.post(order({ email: "d2@example.test", grant_lists: [news] }), read);
  expect(readOnly.status).toBe(403);
  // Manage on one of the two lists is not enough.
  const partial = await f.apiUser(
    "partial-scope",
    ["subscriber_events:create", "subscribers:manage"],
    [{ id: news, permissions: ["list:manage"] }],
  );
  const half = await f.post(
    order({ email: "d3@example.test", grant_lists: [news, other] }),
    partial,
  );
  expect(half.status).toBe(403);
  expect(f.count("events")).toBe(0);
  expect(f.count("subscribers")).toBe(0);
  // Without a grant, the event needs no subscriber permission (unchanged).
  const plain = await f.post(order({ email: "d4@example.test" }), events);
  expect(plain.status).toBe(200);
  expect(plain.body.data.grants).toEqual([]);
});

test("a token with manage scope on the granted lists is allowed", async () => {
  const f = await open();
  const news = await f.list("news");
  const manager = await f.apiUser(
    "news-manager",
    ["subscriber_events:create", "subscribers:manage"],
    [{ id: news, permissions: ["list:manage"] }],
  );
  const r = await f.post(order({ email: "ok@example.test", grant_lists: [news] }), manager);
  expect(r.status).toBe(200);
  expect(r.body.data.grants).toEqual([{ list_id: news, result: "added" }]);
});

test("in a batch, a list the token cannot manage refuses only its own item", async () => {
  const f = await open();
  const news = await f.list("news");
  const other = await f.list("other");
  const partial = await f.apiUser(
    "news-only",
    ["subscriber_events:create", "subscribers:manage"],
    [{ id: news, permissions: ["list:manage"] }],
  );
  const r = await f.batch(
    {
      events: [
        order({ email: "b1@example.test", grant_lists: [news] }),
        order({ email: "b2@example.test", grant_lists: [other] }),
        order({ email: "b3@example.test" }),
      ],
    },
    partial,
  );
  expect(r.status).toBe(200);
  const [first, second, third] = r.body.data.results;
  expect(first.status).toBe(200);
  expect(second.status).toBe(403);
  expect(third.status).toBe(200);
  expect(f.count("events")).toBe(2);
  expect(f.count("subscribers")).toBe(2);
  expect(await f.subscriber(first.subscriber_id).then((s) => s.lists)).toMatchObject([
    { id: news, subscription_status: "confirmed" },
  ]);
});

test("a repeated idempotency key replays the first grants and changes nothing", async () => {
  const f = await open();
  const news = await f.list("news");
  const first = await f.post(
    order({ email: "replay@example.test", grant_lists: [news] }, { idempotency_key: "k-1" }),
  );
  expect(first.body.data.grants).toEqual([{ list_id: news, result: "added" }]);
  const id = first.body.data.subscriber_id as number;
  await unsubscribe(f, id, news);
  const events = f.count("events");
  const replay = await f.post(
    order({ email: "replay@example.test", grant_lists: [news] }, { idempotency_key: "k-1" }),
  );
  expect(replay.body.data).toEqual(first.body.data);
  expect(await membership(f, id, news)).toBe("unsubscribed");
  expect(f.count("events")).toBe(events);
});

test("a replay keeps the grants of its first request across a restart", async () => {
  const f = await open();
  const news = await f.list("news");
  const first = await f.post(
    order({ email: "again@example.test", grant_lists: [news] }, { idempotency_key: "k-2" }),
  );
  await f.restart();
  const replay = await f.post(
    order({ email: "again@example.test", grant_lists: [news] }, { idempotency_key: "k-2" }),
  );
  expect(replay.body.data).toEqual(first.body.data);
});

test("a limited token needs a managed list the existing subscriber is already on, as PUT does", async () => {
  const f = await open();
  const news = await f.list("news");
  const secret = await f.list("secret");
  const created = await f.json("/api/subscribers", "POST", {
    email: "vip@example.test",
    name: "Vip",
    lists: [secret],
    preconfirm_subscriptions: true,
  });
  const id = created.body.data.id as number;
  // Manages news only; vip is on secret only.
  const news_only = await f.apiUser(
    "news-events",
    ["subscriber_events:create", "subscribers:manage"],
    [{ id: news, permissions: ["list:manage"] }],
  );
  const put = await f.json(
    "/api/subscribers/lists",
    "PUT",
    { ids: [id], action: "add", status: "confirmed", target_list_ids: [news] },
    news_only,
  );
  expect(put.status).toBe(403);
  const before = [f.count("events"), f.count("subscribers")];
  const r = await f.post(order({ email: "vip@example.test", grant_lists: [news] }), news_only);
  expect(r.status).toBe(403);
  expect(await membership(f, id, news)).toBeNull();
  expect(await membership(f, id, secret)).toBe("confirmed");
  expect([f.count("events"), f.count("subscribers")]).toEqual(before);
});

test("a limited token may grant on an existing subscriber already on a list it manages", async () => {
  const f = await open();
  const news = await f.list("news");
  const sport = await f.list("sport");
  const created = await f.json("/api/subscribers", "POST", {
    email: "fan@example.test",
    name: "Fan",
    lists: [news],
    preconfirm_subscriptions: true,
  });
  const id = created.body.data.id as number;
  const sport_events = await f.apiUser(
    "sport-events",
    ["subscriber_events:create", "subscribers:manage"],
    [
      { id: news, permissions: ["list:manage"] },
      { id: sport, permissions: ["list:manage"] },
    ],
  );
  const r = await f.post(order({ email: "fan@example.test", grant_lists: [sport] }), sport_events);
  expect(r.status).toBe(200);
  expect(r.body.data.grants).toEqual([{ list_id: sport, result: "added" }]);
  expect(await membership(f, id, sport)).toBe("confirmed");
});

test("a limited token may grant on a subscriber the event creates, and manage-all tokens are unaffected", async () => {
  const f = await open();
  const news = await f.list("news");
  const other = await f.list("other");
  const news_events = await f.apiUser(
    "news-created",
    ["subscriber_events:create", "subscribers:manage"],
    [{ id: news, permissions: ["list:manage"] }],
  );
  const created = await f.post(
    order({ email: "new@example.test", grant_lists: [news] }),
    news_events,
  );
  expect(created.status).toBe(200);
  expect(created.body.data.grants).toEqual([{ list_id: news, result: "added" }]);
  expect(await membership(f, created.body.data.subscriber_id, news)).toBe("confirmed");
  // An existing subscriber with no membership at all: a limited token cannot grant it (as PUT),
  // while a token that manages every list still can.
  await f.json("/api/subscribers", "POST", { email: "bare@example.test", name: "Bare" });
  const refused = await f.post(
    order({ email: "bare@example.test", grant_lists: [news] }),
    news_events,
  );
  expect(refused.status).toBe(403);
  const all = await f.post(order({ email: "bare@example.test", grant_lists: [other] }));
  expect(all.status).toBe(200);
  expect(all.body.data.grants).toEqual([{ list_id: other, result: "added" }]);
});

test("in a batch, an existing subscriber outside the token's lists refuses only its own item", async () => {
  const f = await open();
  const news = await f.list("news");
  const secret = await f.list("secret");
  await f.json("/api/subscribers", "POST", {
    email: "outside@example.test",
    name: "Outside",
    lists: [secret],
    preconfirm_subscriptions: true,
  });
  const news_only = await f.apiUser(
    "news-batch",
    ["subscriber_events:create", "subscribers:manage"],
    [{ id: news, permissions: ["list:manage"] }],
  );
  const r = await f.batch(
    {
      events: [
        order({ email: "outside@example.test", grant_lists: [news] }),
        order({ email: "inside@example.test", grant_lists: [news] }),
      ],
    },
    news_only,
  );
  expect(r.status).toBe(200);
  const [outside, inside] = r.body.data.results;
  expect(outside).toEqual({
    status: 403,
    message: expect.any(String),
    code: "permission_denied",
  });
  expect(inside).toMatchObject({ status: 200, grants: [{ list_id: news, result: "added" }] });
  expect(f.count("events")).toBe(1);
  expect(f.count("subscribers")).toBe(2);
});

test("the refused grant list names its field in the app's language, as other event field errors do", async () => {
  const f = await open("fr");
  const news = await f.list("news");
  const r = await f.post(order({ email: "fr@example.test", grant_lists: [news, 999_999] }));
  expect(r.status).toBe(400);
  expect(r.body.message).toBe(
    createTranslation("fr").Ts("globals.messages.invalidFields", "name", "subscriber.grant_lists"),
  );
  expect(r.body.message).not.toBe(invalid);
  expect(f.count("events")).toBe(0);
});
