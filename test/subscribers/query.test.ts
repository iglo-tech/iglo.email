// Behavior of GET /api/subscribers, export and query-selected actions through the HTTP API.
// Reference: listmonk cmd/subscribers.go and queries/subscribers.sql at 6fcd95f.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { openReadOnly } from "@/subscribers/query-runner";
import { queryFixture, type QueryFixture } from "@/test/subscribers/fixture";

let f: QueryFixture;
let listA: number, listB: number;
const ids: Record<string, number> = {};
const q = (fragment: string) => encodeURIComponent(fragment);
const emails = (body: { data: { results: { email: string }[] | null } }) =>
  (body.data.results ?? []).map((row) => row.email.split("-")[0]);
const spin =
  "(WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c) > 0";

// Child processes of this test process, from /proc.
function children(): number[] {
  const out: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      if (new RegExp(`^PPid:\\s+${process.pid}$`, "m").test(status)) out.push(Number(entry));
    } catch {
      /* exited meanwhile */
    }
  }
  return out;
}

async function seed() {
  listA = (await f.json("/api/lists", "POST", { name: "list-a" })).body.data.id;
  listB = (await f.json("/api/lists", "POST", { name: "list-b" })).body.data.id;
  for (const [key, body] of [
    [
      "alice",
      {
        email: "alice-qx@example.test",
        name: "Alice Qx",
        lists: [listA],
        attribs: { city: "Bengaluru", zz: 1, a: { y: 2, b: 1 } },
        preconfirm_subscriptions: true,
      },
    ],
    ["bob", { email: "bob-qx@example.test", name: 'Bob, "Qx"', lists: [listA, listB] }],
    ["carol", { email: "carol-qx@example.test", name: "Carol Qx", status: "disabled" }],
    ["dave", { email: "dave-other@example.test", name: "Dave Zed", lists: [listB] }],
  ] as const) {
    const response = await f.json("/api/subscribers", "POST", body);
    expect(response.status).toBe(200);
    ids[key] = response.body.data.id;
  }
}

beforeAll(async () => {
  f = await queryFixture({ timeoutMs: 1500 });
  await seed();
});
afterAll(async () => {
  await f.close();
});

describe("GET /api/subscribers", () => {
  test("returns upstream's envelope, default order and paging", async () => {
    const page = await f.json("/api/subscribers?search=qx&per_page=2");
    expect(page.status).toBe(200);
    expect(Object.keys(page.body.data)).toEqual([
      "results",
      "search",
      "query",
      "total",
      "per_page",
      "page",
    ]);
    expect(emails(page.body)).toEqual(["carol", "bob"]);
    expect(page.body.data).toMatchObject({
      search: "qx",
      query: "",
      total: 3,
      per_page: 2,
      page: 1,
    });
    const second = await f.json("/api/subscribers?search=qx&per_page=2&page=2");
    expect(emails(second.body)).toEqual(["alice"]);
    const all = await f.json("/api/subscribers?per_page=all");
    expect(all.body.data.per_page).toBe(0);
    expect(all.body.data.total).toBe(4);
    const negative = await f.json("/api/subscribers?per_page=-5&page=-1");
    expect(negative.body.data).toMatchObject({ per_page: 0, page: 1, total: 4 });
    const beyond = await f.json("/api/subscribers?per_page=abc&page=3");
    expect(beyond.body.data).toMatchObject({ results: null, total: 4, per_page: 20, page: 3 });
    const none = await f.json("/api/subscribers?search=nomatchatall");
    expect(none.body.data).toMatchObject({ results: [], total: 0 });
  });

  test("orders by allow-listed columns only", async () => {
    const asc = await f.json("/api/subscribers?search=qx&order_by=name&order=asc");
    expect(emails(asc.body)).toEqual(["alice", "bob", "carol"]);
    const upper = await f.json("/api/subscribers?search=qx&order_by=email&order=ASC");
    expect(emails(upper.body)).toEqual(["carol", "bob", "alice"]);
    const injected = await f.json(
      `/api/subscribers?search=qx&order_by=${q("name; DROP TABLE subscribers")}&order=asc`,
    );
    expect(emails(injected.body)).toEqual(["alice", "bob", "carol"]);
  });

  test("search matches words, prefixes and e-mail addresses case-insensitively", async () => {
    for (const [search, expected] of [
      ["alice-qx@example.test", ["alice"]],
      ["ALICE-QX@EXAMPLE.TEST", ["alice"]],
      ["  Bob  ", ["bob"]],
      ['Bob, "Qx"', ["bob"]],
      ["carol q", ["carol"]],
      ["example.test", ["dave", "carol", "bob", "alice"]],
      ["@example", ["dave", "carol", "bob", "alice"]],
      ["qx@", ["carol", "bob", "alice"]],
      ["zed dave", []],
      ["@", ["dave", "carol", "bob", "alice"]],
    ] as const) {
      const response = await f.json(`/api/subscribers?search=${q(search)}`);
      expect([search, emails(response.body)]).toEqual([search, [...expected]]);
    }
  });

  test("filters lists, subscription and subscriber status", async () => {
    const a = await f.json(`/api/subscribers?list_id=${listA}`);
    expect(emails(a.body)).toEqual(["bob", "alice"]);
    const ab = await f.json(`/api/subscribers?list_id=${listA}&list_id=${listB}`);
    expect(ab.body.data.total).toBe(3);
    const confirmed = await f.json("/api/subscribers?subscription_status=confirmed");
    expect(emails(confirmed.body)).toEqual(["alice"]);
    const orphan = await f.json("/api/subscribers?subscription_status=none");
    expect(emails(orphan.body)).toEqual(["carol"]);
    const disabled = await f.json("/api/subscribers?status=disabled");
    expect(emails(disabled.body)).toEqual(["carol"]);
    expect((await f.json("/api/subscribers?list_id=1&list_id=abc")).body).toEqual({
      message: "Invalid ID(s)",
    });
    expect((await f.json("/api/subscribers?list_id=")).body.data.total).toBe(4);
    expect((await f.json("/api/subscribers?status=bogus")).status).toBe(400);
    expect((await f.json("/api/subscribers?subscription_status=bogus")).status).toBe(400);
  });

  test("runs SQLite fragments with the joined subscriber_lists", async () => {
    const city = await f.json(
      `/api/subscribers?query=${q("  subscribers.attribs->>'city' = 'Bengaluru';  ")}`,
    );
    expect(emails(city.body)).toEqual(["alice"]);
    expect(city.body.data.query).toBe("subscribers.attribs->>'city' = 'Bengaluru'");
    const joined = await f.json(
      `/api/subscribers?list_id=${listA}&query=${q("subscriber_lists.status = 'confirmed'")}`,
    );
    expect(emails(joined.body)).toEqual(["alice"]);
    const unjoined = await f.json(
      `/api/subscribers?query=${q("subscriber_lists.status = 'confirmed'")}`,
    );
    expect(unjoined.body.data.total).toBe(0);
    const sub = await f.json(
      `/api/subscribers?query=${q("subscribers.id IN (SELECT subscriber_id FROM subscriber_lists WHERE list_id = " + listB + ")")}&order_by=email&order=asc`,
    );
    expect(emails(sub.body)).toEqual(["bob", "dave"]);
  });

  test("refuses other tables, statements, comments and escapes", async () => {
    for (const table of ["users", "sessions", "settings", "sqlite_schema", "roles"]) {
      const response = await f.json(
        `/api/subscribers?query=${q(`subscribers.id IN (SELECT 1 FROM ${table})`)}`,
      );
      expect(response.status).toBe(400);
      expect(response.body.message).toStartWith("Error preparing subscriber query:");
    }
    for (const fragment of [
      "1=1; DELETE FROM subscribers",
      "1=1 -- comment",
      "1=1 /* x */",
      "1=1 */",
      "1=1) OR (1=1",
      "1=1) UNION SELECT id FROM users WHERE (1",
      "name = 'unterminated",
      "syntax error here",
      "name = ?",
    ]) {
      const response = await f.json(`/api/subscribers?query=${q(fragment)}`);
      expect([fragment, response.status]).toEqual([fragment, 400]);
    }
    expect((await f.json("/api/subscribers?per_page=all")).body.data.total).toBe(4);
  });

  test("the read-only connection refuses writes", () => {
    const db = openReadOnly(f.db.filename);
    try {
      for (const sql of [
        "INSERT INTO lists (uuid, name, type) VALUES ('x', 'x', 'private')",
        "UPDATE subscribers SET name = 'x'",
        "DELETE FROM subscribers",
        "PRAGMA user_version = 7",
        "PRAGMA journal_mode = DELETE",
        "CREATE TABLE stolen (x)",
      ])
        expect(() => db.run(sql)).toThrow();
      db.run("ATTACH ':memory:' AS other");
      expect(() => db.run("CREATE TABLE other.t (x)")).toThrow();
    } finally {
      db.close();
    }
    expect(f.db.query("PRAGMA user_version").get()).not.toEqual({ user_version: 7n });
  });

  test("the child runs only checked SELECTs", async () => {
    for (const sql of [
      "DELETE FROM subscribers",
      "ATTACH ':memory:' AS x",
      "PRAGMA user_version = 7",
      "SELECT id FROM users",
      "SELECT id FROM subscribers WHERE id = ?",
    ])
      await expect(f.runner.all([{ sql, args: [] }])).rejects.toThrow();
    expect(
      (await f.runner.all([{ sql: "SELECT count(*) FROM subscribers", args: [] }]))[0],
    ).toEqual([4n]);
  });

  test("a raw query has a real time limit that stops the SQLite work", async () => {
    const before = children().length;
    const started = performance.now();
    const response = await f.json(`/api/subscribers?query=${q(spin)}`);
    const elapsed = performance.now() - started;
    expect(response.status).toBe(500);
    expect(response.body.message).toBe("Error fetching Subscribers: query timed out");
    expect(elapsed).toBeLessThan(5000);
    expect(children().length).toBe(before);
    // Memory: SQLite's allocations in the child are capped.
    const big = await f.json(`/api/subscribers?query=${q("length(randomblob(1000000000)) > 0")}`);
    expect(big.body).toEqual({
      message: "Error fetching Subscribers: query exceeded the memory limit",
    });
    expect(children().length).toBe(before);
  });

  test("requires subscriber read permission and sql_query for fragments", async () => {
    const reader = await f.apiUser("reader", ["subscribers:get_all"]);
    expect((await f.json("/api/subscribers", "GET", undefined, reader)).body.data.total).toBe(4);
    const denied = await f.json(`/api/subscribers?query=${q("1=1")}`, "GET", undefined, reader);
    expect(denied).toEqual({
      status: 403,
      body: { message: "Permission denied: subscribers:sql_query" },
    });
    const nobody = await f.apiUser("nobody", ["lists:get_all"]);
    expect((await f.json("/api/subscribers", "GET", undefined, nobody)).status).toBe(403);
    const unlisted = await f.apiUser("unlisted", ["subscribers:get"]);
    expect((await f.json("/api/subscribers", "GET", undefined, unlisted)).body.data).toMatchObject({
      results: [],
      total: 0,
    });
  });

  test("list-scoped roles see only their lists and masked memberships", async () => {
    const scoped = await f.apiUser(
      "scoped",
      ["subscribers:get"],
      [{ id: listA, permissions: ["list:get"] }],
    );
    const all = await f.json("/api/subscribers?per_page=all", "GET", undefined, scoped);
    expect(emails(all.body)).toEqual(["bob", "alice"]);
    const bob = all.body.data.results[0];
    const hidden = bob.lists.find((list: { id: number }) => list.id === listB);
    expect(hidden).toMatchObject({ name: "*Unknown", restricted: true });
    expect("description" in hidden).toBe(false);
    const other = await f.json(`/api/subscribers?list_id=${listB}`, "GET", undefined, scoped);
    expect(other.body.data.total).toBe(0);
    const exported = await f.request("/api/subscribers/export", { headers: scoped });
    expect((await exported.text()).trim().split("\n")).toHaveLength(3);
  });
});

describe("GET /api/subscribers/export", () => {
  test("streams upstream's CSV columns and formats", async () => {
    const response = await f.json("/api/subscribers?search=qx&per_page=all");
    expect(response.status).toBe(200);
    const csv = await f.request("/api/subscribers/export?search=qx", {
      headers: {
        authorization: (await f.apiUser("exporter", ["subscribers:get_all"])).authorization,
      },
    });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toBe("text/csv");
    expect(csv.headers.get("content-disposition")).toBe("attachment; filename=subscribers.csv");
    expect(csv.headers.get("cache-control")).toBe("no-cache");
    const lines = (await csv.text()).split("\n");
    expect(lines[0]).toBe("uuid,email,name,attributes,status,created_at,updated_at");
    expect(lines).toHaveLength(5);
    expect(lines[1]).toMatch(
      /^[0-9a-f-]{36},alice-qx@example\.test,Alice Qx,"\{""a"": \{""b"": 1, ""y"": 2\}, ""zz"": 1, ""city"": ""Bengaluru""\}",enabled,2026-01-02 03:04:05 \+0000 UTC,2026-01-02 03:04:05 \+0000 UTC$/,
    );
    expect(lines[2]).toContain(',bob-qx@example.test,"Bob, ""Qx""",{},enabled,');
    expect(lines[4]).toBe("");
  });

  test("filters by id, list and query, and compresses when accepted", async () => {
    const auth = {
      cookie: "",
      ...(await f.apiUser("exporter2", [
        "subscribers:get_all",
        "subscribers:sql_query",
        "lists:get_all",
      ])),
    };
    const text = async (path: string) => (await f.request(path, { headers: auth })).text();
    expect(
      (await text(`/api/subscribers/export?id=${ids.bob}&id=${ids.dave}`)).split("\n"),
    ).toHaveLength(4);
    expect((await text(`/api/subscribers/export?list_id=${listB}`)).split("\n")).toHaveLength(4);
    expect(
      await text(`/api/subscribers/export?query=${q("subscribers.status = 'disabled'")}`),
    ).toContain("carol-qx@example.test");
    const bad = await f.request(`/api/subscribers/export?id=1&id=x`, { headers: auth });
    expect(bad.status).toBe(400);
    const gzip = await f.request("/api/subscribers/export", {
      headers: { ...auth, "accept-encoding": "gzip, deflate" },
    });
    expect(gzip.headers.get("content-encoding")).toBe("gzip");
    const raw = new Uint8Array(await gzip.arrayBuffer());
    expect(gunzipSync(raw).toString()).toStartWith("uuid,email,name");
    const slow = await f.request(`/api/subscribers/export?query=${q(spin)}`, { headers: auth });
    expect(slow.status).toBe(500);
    const forbidden = await f.request(`/api/subscribers/export?query=${q("1=1")}`, {
      headers: await f.apiUser("exporter3", ["subscribers:get_all"]),
    });
    expect(forbidden.status).toBe(403);
  });
});

describe("query-selected actions", () => {
  test("validate the request like upstream", async () => {
    for (const [path, method, body, status, message] of [
      [
        "/api/subscribers/query/lists",
        "PUT",
        { search: "qx", action: "add" },
        400,
        "No lists given.",
      ],
      [
        "/api/subscribers/query/lists",
        "PUT",
        { action: "add", target_list_ids: [listB] },
        400,
        "Invalid fields: query",
      ],
      [
        "/api/subscribers/query/lists",
        "PUT",
        { search: "qx", action: "bogus", target_list_ids: [listB] },
        400,
        "Invalid action.",
      ],
      [
        "/api/subscribers/query/lists",
        "PUT",
        { search: "qx", action: "add", status: "bogus", target_list_ids: [listB] },
        400,
        "Invalid fields: status",
      ],
      ["/api/subscribers/query/delete", "POST", {}, 400, "Invalid fields: query"],
      ["/api/subscribers/query/blocklist", "PUT", { search: 5 }, 400, "Bad Request"],
    ] as const) {
      const response = await f.json(path, method, body);
      expect([path, response.status, response.body.message]).toEqual([path, status, message]);
    }
    expect((await f.json("/api/subscribers?per_page=all")).body.data.total).toBe(4);
  });

  test("a failed write changes nothing", async () => {
    const response = await f.json("/api/subscribers/query/lists", "PUT", {
      search: "qx",
      action: "add",
      target_list_ids: [listB, 999999],
    });
    expect(response.status).toBe(500);
    expect(response.body.message).toStartWith("Error updating Subscribers:");
    expect((await f.json(`/api/subscribers?list_id=${listB}`)).body.data.total).toBe(2);
  });

  test("add, unsubscribe and remove memberships", async () => {
    expect(
      (
        await f.json("/api/subscribers/query/lists", "PUT", {
          query: "subscribers.email LIKE '%-qx@example.test'",
          action: "add",
          target_list_ids: [listB],
          status: "confirmed",
        })
      ).body,
    ).toEqual({ data: true });
    const b = await f.json(`/api/subscribers?list_id=${listB}&subscription_status=confirmed`);
    // Existing memberships are kept as they are (upstream's DO NOTHING).
    expect(emails(b.body).sort()).toEqual(["alice", "carol"]);
    await f.json("/api/subscribers/query/lists", "PUT", {
      search: "carol",
      action: "unsubscribe",
      target_list_ids: [listB],
    });
    expect(
      emails(
        (await f.json(`/api/subscribers?list_id=${listB}&subscription_status=unsubscribed`)).body,
      ),
    ).toEqual(["carol"]);
    await f.json("/api/subscribers/query/lists", "PUT", {
      search: "carol",
      action: "remove",
      target_list_ids: [listB],
    });
    expect(emails((await f.json("/api/subscribers?subscription_status=none")).body)).toEqual([
      "carol",
    ]);
  });

  test("blocklist and delete", async () => {
    await f.json("/api/subscribers/query/blocklist", "PUT", { search: "bob-qx@example.test" });
    const bob = (await f.json(`/api/subscribers/${ids.bob}`)).body.data;
    expect(bob.status).toBe("blocklisted");
    expect(
      bob.lists.every(
        (l: { subscription_status: string }) => l.subscription_status === "unsubscribed",
      ),
    ).toBe(true);
    const dave = (await f.json(`/api/subscribers/${ids.dave}`)).body.data;
    expect(dave.status).toBe("enabled");
    await f.json("/api/subscribers/query/delete", "POST", {
      query: "subscribers.status = 'disabled'",
      search: "qx",
    });
    expect((await f.json(`/api/subscribers/${ids.carol}`)).status).toBe(400);
    expect((await f.json("/api/subscribers?per_page=all")).body.data.total).toBe(3);
  });

  test("list-scoped managers act only within their lists", async () => {
    const extra = await f.json("/api/subscribers", "POST", {
      email: "erin-outside@example.test",
      name: "Erin Outside",
    });
    const manager = await f.apiUser(
      "manager",
      ["subscribers:manage", "subscribers:get"],
      [{ id: listA, permissions: ["list:manage", "list:get"] }],
    );
    const response = await f.json("/api/subscribers/query/delete", "POST", { all: true }, manager);
    expect(response.body).toEqual({ data: true });
    const left = await f.json("/api/subscribers?per_page=all&order_by=email&order=asc");
    // Alice and Bob were in list A; Dave (list B) and Erin (no lists) remain.
    expect(emails(left.body)).toEqual(["dave", "erin"]);
    const denied = await f.json(
      "/api/subscribers/query/blocklist",
      "PUT",
      { query: "1=1" },
      manager,
    );
    expect(denied.status).toBe(403);
    void extra;
  });

  test("a concurrent change cannot redirect a raw-SQL action", async () => {
    const z = await f.json("/api/subscribers", "POST", {
      email: "zoe-race@example.test",
      name: "Zoe Race",
      lists: [listA],
    });
    const manager = await f.apiUser(
      "racer",
      ["subscribers:manage", "subscribers:get", "subscribers:sql_query"],
      [{ id: listA, permissions: ["list:manage", "list:get"] }],
    );
    // The fragment is slow enough to change the selected subscriber while it runs.
    const slow =
      "(WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 300000) SELECT count(*) FROM c) > 0";
    const pending = f.json("/api/subscribers/query/delete", "POST", { query: slow }, manager);
    await Bun.sleep(30);
    expect(
      (
        await f.json(`/api/subscribers/lists/${z.body.data.id}`, "PUT", {
          action: "remove",
          target_list_ids: [listA],
        })
      ).status,
    ).toBe(200);
    expect((await pending).body).toEqual({ data: true });
    expect((await f.json(`/api/subscribers/${z.body.data.id}`)).status).toBe(200);
  });
});
