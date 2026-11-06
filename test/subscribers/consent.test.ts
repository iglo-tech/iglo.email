// B19 consent invariants through the HTTP API and the public pages (D81, D82).
import { afterEach, expect, test } from "bun:test";
import { publicFixture, type PublicFixture } from "@/test/public/fixture";

const fixtures: PublicFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await publicFixture();
  fixtures.push(f);
  return f;
}
const form = (fields: Record<string, string | string[]>) =>
  Object.entries(fields)
    .flatMap(([key, value]) => [value].flat().map((v) => `${key}=${encodeURIComponent(v)}`))
    .join("&");
const membership = async (f: PublicFixture, id: number, list: number) =>
  (await f.json(`/api/subscribers/${id}`)).body.data.lists.find(
    (item: { id: number }) => item.id === list,
  ) as { subscription_status: string; subscription_updated_at: string } | undefined;
const statuses = async (f: PublicFixture, id: number) =>
  (
    (await f.json(`/api/subscribers/${id}`)).body.data.lists as {
      subscription_status: string;
    }[]
  )
    .map((l) => l.subscription_status)
    .sort();
const subscriberOf = async (f: PublicFixture, id: number) =>
  (await f.json(`/api/subscribers/${id}`)).body.data as {
    status: string;
    updated_at: string;
    uuid: string;
  };
/** A confirmed member of two lists, a stale membership timestamp for each. */
async function member(f: PublicFixture, email = "m@example.test") {
  const a = await f.list("A"),
    b = await f.list("B");
  const id = await f.subscriber(email, "M", {
    lists: [a.id, b.id],
    preconfirm_subscriptions: true,
  });
  return { id, a, b };
}

test("D81: every path into blocklisted leaves only unsubscribed memberships", async () => {
  const f = await open();
  const put = async (label: string, run: (id: number, lists: number[]) => Promise<unknown>) => {
    const m = await member(f, `${label}@example.test`);
    f.clock.advance(60_000);
    await run(m.id, [m.a.id, m.b.id]);
    expect([label, await statuses(f, m.id)]).toEqual([label, ["unsubscribed", "unsubscribed"]]);
    expect([label, (await subscriberOf(f, m.id)).status]).toEqual([label, "blocklisted"]);
    return m;
  };
  await put("patch", (id) => f.json(`/api/subscribers/${id}`, "PATCH", { status: "blocklisted" }));
  const putPath = await put("put", async (id, lists) => {
    await f.json(`/api/subscribers/${id}`, "PUT", {
      email: "put@example.test",
      name: "M",
      status: "blocklisted",
      lists,
    });
  });
  // The membership timestamp moves when consent really changes.
  expect(Date.parse((await membership(f, putPath.id, putPath.a.id))!.subscription_updated_at)).toBe(
    f.clock.now().getTime(),
  );
  await put("route", (id) => f.json(`/api/subscribers/${id}/blocklist`, "PUT"));
});

test("D81: adding or confirming never gives a blocklisted subscriber a live membership", async () => {
  const f = await open();
  const m = await member(f, "blocked@example.test");
  const extra = await f.list("Extra", "public", "double");
  await f.json(`/api/subscribers/${m.id}/blocklist`, "PUT");
  // PUT without a status.
  await f.json(`/api/subscribers/${m.id}`, "PUT", {
    email: "blocked@example.test",
    name: "M",
    lists: [m.a.id, extra.id],
    preconfirm_subscriptions: true,
  });
  expect(await statuses(f, m.id)).toEqual(["unsubscribed", "unsubscribed"]);
  // Add by IDs, with and without a status.
  for (const status of ["", "confirmed", "unconfirmed"])
    await f.json("/api/subscribers/lists", "PUT", {
      ids: [m.id],
      action: "add",
      target_list_ids: [m.b.id, extra.id],
      status,
    });
  expect(await statuses(f, m.id)).toEqual(["unsubscribed", "unsubscribed", "unsubscribed"]);
  // The opt-in page.
  const sub = await subscriberOf(f, m.id);
  f.db.run("UPDATE subscriber_lists SET status='unconfirmed' WHERE subscriber_id=?", [m.id]);
  f.overrides.showOptinPage = false;
  await f.fresh(`/subscription/optin/${sub.uuid}`, form({ confirm: "true", l: [extra.uuid] }));
  expect(await statuses(f, m.id)).not.toContain("confirmed");
});

test("D81: un-blocklisting leaves memberships unsubscribed", async () => {
  const f = await open();
  const m = await member(f, "back@example.test");
  await f.json(`/api/subscribers/${m.id}`, "PATCH", { status: "blocklisted" });
  await f.json(`/api/subscribers/${m.id}`, "PATCH", { status: "enabled" });
  expect(await statuses(f, m.id)).toEqual(["unsubscribed", "unsubscribed"]);
});

test("D82: a list's opt-in cannot change while it has unconfirmed members", async () => {
  const f = await open();
  const list = await f.list("Opt", "public", "double");
  await f.subscriber("u@example.test", "U", { lists: [list.id] });
  const body = { name: "Renamed", type: "public", optin: "single", tags: [] };
  const refused = await f.json(`/api/lists/${list.id}`, "PUT", body);
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain("unconfirmed");
  const row = (await f.json(`/api/lists/${list.id}`)).body.data;
  expect([row.optin, row.name]).toEqual(["double", "Opt"]);
  // The same opt-in, other fields: allowed.
  const ok = await f.json(`/api/lists/${list.id}`, "PUT", {
    ...body,
    optin: "double",
  });
  expect(ok.status).toBe(200);
  expect(ok.body.data.name).toBe("Renamed");
  // Once nobody is unconfirmed the change goes through.
  f.db.run("UPDATE subscriber_lists SET status='confirmed' WHERE list_id=?", [list.id]);
  expect((await f.json(`/api/lists/${list.id}`, "PUT", body)).body.data.optin).toBe("single");
});

test("the public form ignores an archived list", async () => {
  const f = await open();
  const live = await f.list("Live");
  const old = await f.list("Old");
  await f.json(`/api/lists/${old.id}`, "PUT", {
    name: "Old",
    type: "public",
    status: "archived",
  });
  const response = await f.fresh(
    "/subscription/form",
    form({ email: "new@example.test", l: [live.uuid, old.uuid] }),
  );
  expect(response.status).toBe(200);
  const rows = f.db
    .query(
      "SELECT list_id FROM subscriber_lists m JOIN subscribers s ON s.id = m.subscriber_id WHERE s.email = ?",
    )
    .all("new@example.test") as { list_id: number }[];
  expect(rows.map((r) => Number(r.list_id))).toEqual([live.id]);
  const only = await f.fresh(
    "/subscription/form",
    form({ email: "other@example.test", l: [old.uuid] }),
  );
  expect(only.status).toBe(400);
});
