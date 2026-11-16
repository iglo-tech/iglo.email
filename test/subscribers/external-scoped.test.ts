// A list-scoped API user and the external-ID answers (D101): an absent external ID is 404 on both
// selector forms, a subscriber outside the user's lists keeps 403, a list-scoped subscriber is
// served, and refusals write nothing. Observed through the HTTP API of the production router.
import { afterEach, expect, test } from "bun:test";
import { queryFixture, type QueryFixture } from "@/test/subscribers/fixture";

const fixtures: QueryFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

const forms = (external: string) =>
  [
    `/api/subscribers/external/${encodeURIComponent(external)}`,
    `/api/subscribers/external?external_id=${encodeURIComponent(external)}`,
  ] as const;

test("D101: a list-scoped token gets 404 for an absent external ID and keeps 403 out of scope", async () => {
  const f = await queryFixture();
  fixtures.push(f);
  const listA = (
    await f.json("/api/lists", "POST", { name: "Scope A", type: "public", optin: "single" })
  ).body.data.id as number;
  const listB = (
    await f.json("/api/lists", "POST", { name: "Scope B", type: "public", optin: "single" })
  ).body.data.id as number;
  const inside = await f.json("/api/subscribers", "POST", {
    email: "inside@example.test",
    name: "Inside",
    external_id: "inside-1",
    lists: [listA],
  });
  const outside = await f.json("/api/subscribers", "POST", {
    email: "outside@example.test",
    name: "Outside",
    external_id: "outside-1",
    lists: [listB],
  });
  expect([inside.status, outside.status]).toEqual([200, 200]);
  const scoped = await f.apiUser(
    "scoped-external",
    ["subscribers:get", "subscribers:manage"],
    [{ id: listA, permissions: ["list:get", "list:manage"] }],
  );

  for (const path of forms("absent-1")) {
    const read = await f.json(path, "GET", undefined, scoped);
    expect([path, read.status, read.body.message]).toEqual([path, 404, "Subscriber not found."]);
    const write = await f.json(path, "PUT", { email: "new@example.test", name: "New" }, scoped);
    expect([path, write.status, write.body.message]).toEqual([path, 404, "Subscriber not found."]);
    const removed = await f.json(path, "DELETE", undefined, scoped);
    expect([path, removed.status, removed.body.message]).toEqual([
      path,
      404,
      "Subscriber not found.",
    ]);
  }

  for (const path of forms("outside-1")) {
    const read = await f.json(path, "GET", undefined, scoped);
    expect([path, read.status]).toEqual([path, 403]);
    const removed = await f.json(path, "DELETE", undefined, scoped);
    expect([path, removed.status]).toEqual([path, 403]);
  }

  for (const path of forms("inside-1")) {
    const read = await f.json(path, "GET", undefined, scoped);
    expect([path, read.status, read.body.data.email]).toEqual([path, 200, "inside@example.test"]);
  }

  // Refusals wrote nothing: the outside subscriber is still there, and the address a refused
  // PUT named is still free.
  expect((await f.json("/api/subscribers/external/outside-1")).body.data.name).toBe("Outside");
  const free = await f.json("/api/subscribers", "POST", {
    email: "new@example.test",
    name: "New",
  });
  expect(free.status).toBe(200);
});
