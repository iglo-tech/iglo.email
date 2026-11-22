// Raw-query time limit, admission and large-selection limits through the HTTP API.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { childPids } from "@/test/host-processes";
import { queryFixture } from "@/test/subscribers/fixture";
import type { QueryFixture } from "@/test/subscribers/fixture";

const q = (fragment: string) => encodeURIComponent(fragment);

const get = (f: QueryFixture, path: string) => f.request(path, { headers: f.sessionHeaders });
/** The response, or "pending" if it has not arrived within `ms`. */
const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, Bun.sleep(ms).then(() => "pending" as const)]);
/** Poll a condition for up to `ms`; real child processes are involved, not the test clock. */
async function until(condition: () => boolean, ms: number) {
  const end = performance.now() + ms;
  while (!condition() && performance.now() < end) {
    await Bun.sleep(25);
  }
  return condition();
}

describe("raw-query time limit and admission", () => {
  let f: QueryFixture;
  beforeAll(async () => {
    f = await queryFixture({
      timeoutMs: 1000,
      admissionMs: 200,
      command: [process.execPath, join(import.meta.dir, "stall-child.ts")],
    });
  });
  afterAll(async () => {
    await f.close();
  });

  test("the deadline holds while the reader is paused and ends the response", async () => {
    const before = childPids().length;
    // Both exports start (their statements are validated), then nobody reads them.
    const first = await get(f, `/api/subscribers/export?query=${q("1=1")}`);
    const second = await get(f, `/api/subscribers/export?query=${q("1=1")}`);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(childPids().length).toBe(before + 2);
    // A third raw query does not queue indefinitely behind them.
    const started = performance.now();
    const third = await within(f.json(`/api/subscribers?query=${q("1=1")}`), 3000);
    expect(third).toEqual({
      status: 429,
      body: { message: "Too many subscriber queries in progress.", code: "rate_limited" },
    });
    expect(performance.now() - started).toBeLessThan(900);
    // At the deadline both children are killed and reaped without any read.
    const reaped = await until(() => childPids().length === before, 3000);
    try {
      expect(reaped).toBe(true);
      expect(
        await within(
          first.text().then(
            () => "ended",
            () => "failed",
          ),
          1000,
        ),
      ).toBe("failed");
      expect(
        await within(
          second.text().then(
            () => "ended",
            () => "failed",
          ),
          1000,
        ),
      ).toBe("failed");
      // Their large-selection slots were released too.
      expect((await f.json("/api/subscribers?per_page=all")).status).toBe(200);
    } finally {
      await first.body?.cancel().catch(() => {});
      await second.body?.cancel().catch(() => {});
    }
  });
});

describe("large selections and unread responses", () => {
  let f: QueryFixture;
  beforeAll(async () => {
    f = await queryFixture();
    for (const name of ["a", "b", "c"]) {
      await f.json("/api/subscribers", "POST", {
        email: `${name}-l@example.test`,
        name,
      });
    }
  });
  afterAll(async () => {
    await f.close();
  });

  test("unread raw exports release their child slots when the children exit", async () => {
    const before = childPids().length;
    const first = await get(f, `/api/subscribers/export?query=${q("1=1")}`);
    const second = await get(f, `/api/subscribers/export?query=${q("1=1")}`);
    try {
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(await until(() => childPids().length === before, 3000)).toBe(true);
      // Child slots are free: a raw page query runs at once.
      const page = await within(f.json(`/api/subscribers?query=${q("1=1")}`), 3000);
      expect(page === "pending" ? page : [page.status, page.body.data.total]).toEqual([200, 3]);
      // Large-selection slots are still held by the two unread exports.
      const third = await within(get(f, `/api/subscribers/export?query=${q("1=1")}`), 3000);
      expect(third === "pending" ? third : third.status).toBe(429);
    } finally {
      await first.body?.cancel();
      await second.body?.cancel();
    }
    const after = await get(f, `/api/subscribers/export?query=${q("1=1")}`);
    expect(after.status).toBe(200);
    expect((await after.text()).split("\n").length).toBe(5);
  });

  test("full pages, exports and raw bulk actions share a bounded pool", async () => {
    const held = [
      await get(f, "/api/subscribers?per_page=all"),
      await get(f, "/api/subscribers/export"),
    ];
    try {
      expect(held.map((r) => r.status)).toEqual([200, 200]);
      for (const path of [
        "/api/subscribers?per_page=all",
        "/api/subscribers?per_page=-5",
        "/api/subscribers?per_page=5000",
        "/api/subscribers/export",
      ]) {
        const response = await f.json(path);
        expect([path, response.status]).toEqual([path, 429]);
      }
      const bulk = await f.json("/api/subscribers/query/delete", "POST", {
        query: "1=0",
      });
      expect(bulk.status).toBe(429);
      // Ordinary pages and built-in bulk selections are not large.
      expect((await f.json("/api/subscribers?per_page=1000")).body.data.total).toBe(3);
      expect(
        (
          await f.json("/api/subscribers/query/blocklist", "PUT", {
            search: "nobody",
          })
        ).status,
      ).toBe(200);
    } finally {
      for (const response of held) {
        await response.body?.cancel();
      }
    }
    expect((await f.json("/api/subscribers?per_page=all")).body.data.results).toHaveLength(3);
    expect(await f.json("/api/subscribers/query/delete", "POST", { query: "1=0" })).toEqual({
      status: 200,
      body: { data: true },
    });
  });
});
