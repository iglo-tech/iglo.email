// B7: selections staged on disk. More IDs than one staging chunk, so batches span chunks, and
// no staged file outlives a success, a failure or an unread response.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STAGE_CHUNK } from "@/subscribers/id-stage";
import { queryFixture, type QueryFixture } from "@/test/subscribers/fixture";

const TOTAL = STAGE_CHUNK * 2 + 123;
const q = (fragment: string) => encodeURIComponent(fragment);
let f: QueryFixture;
const staged = () => {
  const dir = join(f.db.filename, "..", "stage");
  return existsSync(dir) ? readdirSync(dir) : [];
};

beforeAll(async () => {
  f = await queryFixture();
  f.db.run("BEGIN");
  const insert = f.db.prepare(
    "INSERT INTO subscribers (uuid, email, name, status, attribs, created_at, updated_at) VALUES (?, ?, ?, 'enabled', '{}', ?, ?)",
  );
  const now = new Date().toISOString();
  for (let i = 0; i < TOTAL; i++)
    insert.run(crypto.randomUUID(), `s${i}@example.test`, `s${i}`, now, now);
  f.db.run("COMMIT");
});
afterAll(async () => {
  await f.close();
});

describe("staged selections", () => {
  test("a raw page over the staging chunk returns every row, then leaves no file", async () => {
    const response = await f.json(`/api/subscribers?per_page=all&query=${q("1=1")}`);
    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(TOTAL);
    expect(response.body.data.results).toHaveLength(TOTAL);
    const ids = response.body.data.results.map((r: { id: number }) => r.id);
    expect(new Set(ids).size).toBe(TOTAL);
    expect(staged()).toEqual([]);
  });

  test("a built-in page over the chunk is complete and in order", async () => {
    const response = await f.json("/api/subscribers?per_page=all&order_by=id&order=desc");
    const ids: number[] = response.body.data.results.map((r: { id: number }) => r.id);
    expect(ids).toHaveLength(TOTAL);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(staged()).toEqual([]);
  });

  test("a raw bulk action over the chunk changes exactly the selected rows", async () => {
    const result = await f.json("/api/subscribers/query/blocklist", "PUT", {
      query: "subscribers.id % 2 = 0",
    });
    expect(result.status).toBe(200);
    const blocked = f.db
      .query("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'blocklisted'")
      .get() as { n: number };
    expect(Number(blocked.n)).toBe(Math.floor(TOTAL / 2));
    expect(staged()).toEqual([]);
  });

  test("a failed raw query and an abandoned response leave no file", async () => {
    const bad = await f.json("/api/subscribers/query/delete", "POST", { query: "nope(" });
    expect(bad.status).not.toBe(200);
    expect(staged()).toEqual([]);
    const response = await f.request(`/api/subscribers/export?query=${q("1=1")}`, {
      headers: f.sessionHeaders,
    });
    expect(response.status).toBe(200);
    await response.body!.cancel();
    const page = await f.request(`/api/subscribers?per_page=all`, { headers: f.sessionHeaders });
    await page.body!.cancel();
    await Bun.sleep(100);
    expect(staged()).toEqual([]);
  });

  test("files left by a killed server are removed when the runner starts", async () => {
    const { prepareStageDir } = await import("@/subscribers/id-stage");
    const dir = join(f.db.filename, "..", "stage");
    await Bun.write(join(dir, "q-1-abc-0-0"), "left behind");
    prepareStageDir(dir);
    expect(staged()).toEqual([]);
  });
});
