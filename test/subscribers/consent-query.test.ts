// B19 (D81): the query-selected membership actions follow the by-IDs results.
import { afterEach, expect, test } from "bun:test";
import { queryFixture, type QueryFixture } from "@/test/subscribers/fixture";

const fixtures: QueryFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await queryFixture();
  fixtures.push(f);
  return f;
}
const list = async (f: QueryFixture, name: string) =>
  (await f.json("/api/lists", "POST", { name })).body.data.id as number;
const person = async (f: QueryFixture, email: string, lists: number[], extra: object = {}) =>
  (
    await f.json("/api/subscribers", "POST", {
      email,
      name: "P",
      lists,
      ...extra,
    })
  ).body.data.id as number;
const statuses = async (f: QueryFixture, id: number) =>
  (
    (await f.json(`/api/subscribers/${id}`)).body.data.lists as {
      subscription_status: string;
    }[]
  ).map((l) => l.subscription_status);

test("add by IDs and add by query give the same result for an existing membership", async () => {
  const f = await open();
  const a = await list(f, "A");
  const byId = await person(f, "id@example.test", [a]);
  const byQuery = await person(f, "query@example.test", [a]);
  await f.json("/api/subscribers/lists", "PUT", {
    ids: [byId],
    action: "add",
    target_list_ids: [a],
    status: "confirmed",
  });
  expect(
    (
      await f.json("/api/subscribers/query/lists", "PUT", {
        query: "subscribers.email = 'query@example.test'",
        action: "add",
        target_list_ids: [a],
        status: "confirmed",
      })
    ).status,
  ).toBe(200);
  expect(await statuses(f, byId)).toEqual(["confirmed"]);
  expect(await statuses(f, byQuery)).toEqual(["confirmed"]);
  // Without a status an existing membership is kept, in both.
  await f.json("/api/subscribers/query/lists", "PUT", {
    query: "subscribers.email = 'query@example.test'",
    action: "add",
    target_list_ids: [a],
  });
  expect(await statuses(f, byQuery)).toEqual(["confirmed"]);
});

test("adding by query never gives a blocklisted subscriber a live membership", async () => {
  const f = await open();
  const a = await list(f, "A"),
    b = await list(f, "B");
  const id = await person(f, "blocked@example.test", [a], {
    preconfirm_subscriptions: true,
  });
  await f.json(`/api/subscribers/${id}/blocklist`, "PUT");
  for (const status of ["", "confirmed", "unconfirmed"])
    expect(
      (
        await f.json("/api/subscribers/query/lists", "PUT", {
          query: "subscribers.status = 'blocklisted'",
          action: "add",
          target_list_ids: [a, b],
          status,
        })
      ).status,
    ).toBe(200);
  expect(await statuses(f, id)).toEqual(["unsubscribed", "unsubscribed"]);
});

test("blocklisting by query stamps only the memberships that change", async () => {
  const f = await open();
  const a = await list(f, "A"),
    b = await list(f, "B");
  const id = await person(f, "stamp@example.test", [a, b], {
    preconfirm_subscriptions: true,
  });
  await f.json("/api/subscribers/lists", "PUT", {
    ids: [id],
    action: "unsubscribe",
    target_list_ids: [a],
  });
  const stamp = async () =>
    Object.fromEntries(
      (
        (await f.json(`/api/subscribers/${id}`)).body.data.lists as {
          id: number;
          subscription_updated_at: string;
        }[]
      ).map((l) => [l.id, l.subscription_updated_at]),
    );
  const before = await stamp();
  f.clock.advance(60_000);
  await f.json("/api/subscribers/query/blocklist", "PUT", {
    query: "subscribers.email = 'stamp@example.test'",
  });
  const after = await stamp();
  expect(after[a]).toBe(before[a]!);
  expect(after[b]).toBe(f.clock.now().toISOString());
});
