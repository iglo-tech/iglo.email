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
