// Authorization of a list grant on a subscriber event (D99), when it changes after the request
// began: a permission revoked while the body is held, and a replayed token that lost the list.
// Through POST /api/subscriber-events and the role APIs, observed through the stored rows.
import { afterEach, expect, test } from "bun:test";
import { eventsFixture, type EventsFixture } from "@/test/events/fixture";

const fixtures: EventsFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
async function open() {
  const f = await eventsFixture();
  fixtures.push(f);
  return f;
}
const order = (subscriber: object, extra: object = {}) => ({
  subscriber,
  name: "order_paid",
  ...extra,
});

/** A user whose role grants `permissions` and whose list role manages `lists`; its ids returned. */
async function grantUser(f: EventsFixture, name: string, lists: number[]) {
  const role = await f.json("/api/roles/users", "POST", {
    name,
    permissions: ["subscriber_events:create", "subscribers:manage"],
  });
  const listRole = await f.json("/api/roles/lists", "POST", {
    name,
    lists: lists.map((id) => ({ id, permissions: ["list:manage"] })),
  });
  const user = await f.json("/api/users", "POST", {
    username: name,
    type: "api",
    status: "enabled",
    user_role_id: role.body.data.id,
    list_role_id: listRole.body.data.id,
  });
  expect(user.status).toBe(200);
  return {
    roleId: role.body.data.id as number,
    listRoleId: listRole.body.data.id as number,
    headers: { authorization: `Basic ${btoa(`${name}:${user.body.data.password}`)}` },
  };
}

/**
 * POST one event whose body arrives in two chunks. `between` runs once the server has read the
 * first chunk and is waiting for the rest, so a change there is a change mid-request.
 */
async function heldPost(
  f: EventsFixture,
  body: object,
  headers: Record<string, string>,
  between: () => Promise<void>,
) {
  const payload = JSON.stringify(body);
  const encoder = new TextEncoder();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reading!: () => void;
  const consumed = new Promise<void>((resolve) => (reading = resolve));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload.slice(0, 10)));
    },
    async pull(controller) {
      reading();
      await gate;
      controller.enqueue(encoder.encode(payload.slice(10)));
      controller.close();
    },
  });
  const pending = f.request("/api/subscriber-events", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: stream,
  });
  await consumed;
  await between();
  release();
  const response = await pending;
  return { status: response.status, body: await response.json() };
}

test("a grant with its subscribers:manage revoked mid-request is 403, with no event, subscriber or grant", async () => {
  const f = await open();
  const news = await f.list("news");
  const user = await grantUser(f, "held-grant", [news]);
  const r = await heldPost(
    f,
    order({ email: "held@example.test", grant_lists: [news] }),
    user.headers,
    async () => {
      const revoked = await f.json(`/api/roles/users/${user.roleId}`, "PUT", {
        name: "held-grant",
        permissions: ["subscriber_events:create"],
      });
      expect(revoked.status).toBe(200);
    },
  );
  expect(r.status).toBe(403);
  expect(f.count("events")).toBe(0);
  expect(f.count("subscribers")).toBe(0);
});

test("the same held request is accepted when nothing changes, so the refusal above is the revocation", async () => {
  const f = await open();
  const news = await f.list("news");
  const user = await grantUser(f, "held-steady", [news]);
  const r = await heldPost(
    f,
    order({ email: "steady@example.test", grant_lists: [news] }),
    user.headers,
    async () => {},
  );
  expect(r.status).toBe(200);
  expect(r.body.data.grants).toEqual([{ list_id: news, result: "added" }]);
  expect(f.count("events")).toBe(1);
});

test("a replayed token that lost the granted list is 403 and writes nothing, with or without a key", async () => {
  const f = await open();
  const news = await f.list("news");
  const user = await grantUser(f, "replay-token", [news]);
  const subscriberBody = order({ email: "replay@example.test", grant_lists: [news] });
  const keyed = { ...subscriberBody, idempotency_key: "k-lost-list" };
  const first = await f.post(keyed, user.headers);
  expect(first.body.data.grants).toEqual([{ list_id: news, result: "added" }]);
  const id = first.body.data.subscriber_id as number;

  // The role keeps its permissions but its list role no longer manages the list.
  const shrunk = await f.json(`/api/roles/lists/${user.listRoleId}`, "PUT", {
    name: "replay-token",
    lists: [],
  });
  expect(shrunk.status).toBe(200);

  const events = f.count("events");
  const subscribers = f.count("subscribers");
  const membership = (await f.subscriber(id)).lists;
  expect(membership).toMatchObject([{ id: news, subscription_status: "confirmed" }]);

  const replay = await f.post(keyed, user.headers);
  expect(replay.status).toBe(403);
  const repeat = await f.post(subscriberBody, user.headers);
  expect(repeat.status).toBe(403);

  expect(f.count("events")).toBe(events);
  expect(f.count("subscribers")).toBe(subscribers);
  expect((await f.subscriber(id)).lists).toEqual(membership);
});
