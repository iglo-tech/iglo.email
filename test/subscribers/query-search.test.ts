// Search and the raw-query allow-list through the HTTP API.
// Reference: listmonk queries/subscribers.sql (`~* ('***=' || search)`) and
// internal/core/subscribers.go allowedSubQueryTables at 6fcd95f.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { queryFixture, type QueryFixture } from "@/test/subscribers/fixture";

const q = (fragment: string) => encodeURIComponent(fragment);
const emails = (body: { data: { results: { email: string }[] | null } }) =>
  (body.data.results ?? []).map((row) => row.email.split("-")[0]);

const get = (f: QueryFixture, path: string) => f.request(path, { headers: f.sessionHeaders });

describe("accented search", () => {
  let f: QueryFixture;
  beforeAll(async () => {
    f = await queryFixture();
    for (const [email, name] of [
      ["accent-a@example.test", "José Acc"],
      ["plain-a@example.test", "Jose Acc"],
      ["upper-a@example.test", "JOSÉ Upper"],
    ])
      expect((await f.json("/api/subscribers", "POST", { email, name })).status).toBe(200);
  });
  afterAll(async () => {
    await f.close();
  });

  test("folds case but not accents, like upstream", async () => {
    for (const [search, expected] of [
      ["José", ["upper", "accent"]],
      ["josé acc", ["accent"]],
      ["JOSÉ", ["upper", "accent"]],
      ["Jose", ["plain"]],
      ["jose acc", ["plain"]],
    ] as const) {
      const response = await f.json(`/api/subscribers?search=${q(search)}`);
      expect([search, emails(response.body)]).toEqual([search, [...expected]]);
    }
    const csv = await (await get(f, "/api/subscribers/export?search=Jos%C3%A9%20acc")).text();
    expect(csv).toContain("accent-a@example.test");
    expect(csv).not.toContain("plain-a@example.test");
  });

  test("query-selected actions use the same search", async () => {
    expect(
      await f.json("/api/subscribers/query/delete", "POST", {
        search: "José Acc",
      }),
    ).toEqual({ status: 200, body: { data: true } });
    const left = await f.json("/api/subscribers?per_page=all");
    expect(emails(left.body).sort()).toEqual(["plain", "upper"]);
  });
});

describe("sharp S search", () => {
  let f: QueryFixture;
  beforeAll(async () => {
    f = await queryFixture();
    for (const [email, name] of [
      ["capital-s@example.test", "GRO\u1E9E Sharp"],
      ["small-s@example.test", "Gro\u00DF Sharp"],
      ["double-s@example.test", "GROSS Sharp"],
    ])
      expect((await f.json("/api/subscribers", "POST", { email, name })).status).toBe(200);
  });
  afterAll(async () => {
    await f.close();
  });

  test("ß matches capital ẞ but not SS, in the list, export and bulk actions", async () => {
    for (const search of ["Gro\u00DF", "GRO\u1E9E"]) {
      const response = await f.json(`/api/subscribers?search=${q(search)}`);
      expect([search, emails(response.body).sort()]).toEqual([search, ["capital", "small"]]);
    }
    const csv = await (await get(f, `/api/subscribers/export?search=${q("Gro\u00DF")}`)).text();
    expect(csv).toContain("capital-s@example.test");
    expect(csv).not.toContain("double-s@example.test");
    expect(
      (await f.json("/api/subscribers/query/blocklist", "PUT", { search: "Gro\u00DF" })).status,
    ).toBe(200);
    const all = await f.json("/api/subscribers?per_page=all");
    const status = Object.fromEntries(
      (all.body.data.results as { email: string; status: string }[]).map((row) => [
        row.email.split("-")[0],
        row.status,
      ]),
    );
    expect(status).toEqual({ capital: "blocklisted", small: "blocklisted", double: "enabled" });
  });
});

describe("Greek iota subscript search", () => {
  let f: QueryFixture;
  beforeAll(async () => {
    f = await queryFixture();
    expect(
      (
        await f.json("/api/subscribers", "POST", {
          email: "iota-s@example.test",
          name: "\u1F8C\u03B4\u03B7\u03C2",
        })
      ).status,
    ).toBe(200);
  });
  afterAll(async () => {
    await f.close();
  });

  test("ᾄ matches the single capital ᾌ in the list, export and bulk actions", async () => {
    const search = "\u1F84\u03B4\u03B7\u03C2";
    expect(emails((await f.json(`/api/subscribers?search=${q(search)}`)).body)).toEqual(["iota"]);
    const csv = await (await get(f, `/api/subscribers/export?search=${q(search)}`)).text();
    expect(csv).toContain("iota-s@example.test");
    expect((await f.json("/api/subscribers/query/blocklist", "PUT", { search })).status).toBe(200);
    const all = await f.json("/api/subscribers?per_page=all");
    expect(all.body.data.results[0].status).toBe("blocklisted");
  });
});

describe("raw-query allow-list", () => {
  let f: QueryFixture;
  beforeAll(async () => {
    f = await queryFixture();
    await f.json("/api/subscribers", "POST", {
      email: "vt-a@example.test",
      name: "Vt",
    });
  });
  afterAll(async () => {
    await f.close();
  });

  test("refuses pragma functions, dbstat and FTS shadow tables", async () => {
    for (const fragment of [
      "EXISTS (SELECT 1 FROM pragma_table_info('users'))",
      "EXISTS (SELECT 1 FROM pragma_table_list)",
      "EXISTS (SELECT 1 FROM dbstat WHERE name = 'users')",
      "EXISTS (SELECT 1 FROM subscribers_fts_data)",
      "EXISTS (SELECT 1 FROM subscribers_fts_config)",
    ]) {
      const response = await f.json(`/api/subscribers?query=${q(fragment)}`);
      expect([fragment, response.status]).toEqual([fragment, 400]);
      expect(response.body.message).toStartWith("Error preparing subscriber query:");
    }
  });

  test("still runs JSON table functions, search and the FTS index", async () => {
    for (const fragment of [
      "subscribers.id IN (SELECT value FROM json_each('[1,2,3]'))",
      "EXISTS (SELECT 1 FROM json_tree(subscribers.attribs))",
      "subscribers.id IN (SELECT rowid FROM subscribers_fts WHERE subscribers_fts MATCH 'vt')",
    ]) {
      const response = await f.json(`/api/subscribers?search=vt&query=${q(fragment)}`);
      expect([fragment, response.status, emails(response.body)]).toEqual([fragment, 200, ["vt"]]);
    }
  });
});
