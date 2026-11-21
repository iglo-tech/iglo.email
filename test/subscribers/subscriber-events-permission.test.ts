// B123 (D126): GET /api/subscribers/:id/subscriber-events needs `subscriber_events:get` as well as
// the subscriber read scope, as enrollments and sends need their own permission. Through HTTP on the
// production router: a role without the permission is refused, one with it is served, and the
// subscriber read scope still applies.
import { afterEach, expect, test } from "bun:test";
import { queryFixture } from "@/test/subscribers/fixture";
import type { QueryFixture } from "@/test/subscribers/fixture";

const fixtures: Array<QueryFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});

async function open() {
  const f = await queryFixture();
  fixtures.push(f);
  return f;
}

async function subscriberInList(f: QueryFixture, listId: number) {
  const created = await f.json("/api/subscribers", "POST", {
    email: `events-${listId}@example.test`,
    name: "Events",
    lists: [listId],
  });
  expect(created.status).toBe(200);
  return created.body.data.id as number;
}

test("subscriber events need subscriber_events:get on REST, with the subscriber read scope", async () => {
  const f = await open();
  const listA = (
    await f.json("/api/lists", "POST", { name: "Events A", type: "public", optin: "single" })
  ).body.data.id as number;
  const listB = (
    await f.json("/api/lists", "POST", { name: "Events B", type: "public", optin: "single" })
  ).body.data.id as number;
  const inside = await subscriberInList(f, listA);
  const outside = await subscriberInList(f, listB);
  const scope = [{ id: listA, permissions: ["list:get"] }];
  const reader = await f.apiUser("events-reader", ["subscribers:get"], scope);
  const withEvents = await f.apiUser(
    "events-granted",
    ["subscribers:get", "subscriber_events:get"],
    scope,
  );
  const eventsOnly = await f.apiUser("events-only", ["subscriber_events:get"], scope);

  const path = (id: number) => `/api/subscribers/${id}/subscriber-events`;
  // The permission is missing: refused whatever the list scope.
  const refused = await f.json(path(inside), "GET", undefined, reader);
  expect([refused.status, refused.body.message]).toEqual([
    403,
    "permission denied: subscriber_events:get",
  ]);
  // The permission is held and the subscriber is in scope: served (the fixture's history is empty).
  const served = await f.json(path(inside), "GET", undefined, withEvents);
  expect(served.status).toBe(200);
  expect(served.body.data).toEqual([]);
  // The permission is held but the subscriber read scope is not: the subscriber read is refused.
  const unread = await f.json(path(inside), "GET", undefined, eventsOnly);
  expect(unread.status).toBe(403);
  // In the permission but out of the user's lists: refused, as GET /api/subscribers/:id is.
  const other = await f.json(path(outside), "GET", undefined, withEvents);
  expect(other.status).toBe(403);
  // Missing subscribers are answered as before (400 for a numeric ID, as the read routes do).
  const missing = await f.json(path(999_999), "GET", undefined, withEvents);
  expect(missing.status).toBe(400);
});
