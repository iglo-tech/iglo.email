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

describe("raw-query admission", () => {
  let f: QueryFixture;
  beforeAll(async () => {
    // A deadline far longer than this test: the children stay running while the test looks at them,
    // so the admission outcome does not depend on how fast the host is (B118a).
    f = await queryFixture({
      timeoutMs: 60_000,
      admissionMs: 200,
      command: [process.execPath, join(import.meta.dir, "stall-child.ts")],
    });
  });
  afterAll(async () => {
    await f.close();
  });

  test("a raw query past the two child slots is refused at admission and does not queue", async () => {
    const first = await get(f, `/api/subscribers/export?query=${q("1=1")}`);
    const second = await get(f, `/api/subscribers/export?query=${q("1=1")}`);
    try {
      expect([first.status, second.status]).toEqual([200, 200]);
      // The slots are held for the whole test. The third query is refused, and the bound below
      // only checks that it is answered at all: a queued query would stay pending.
      const third = await within(f.json(`/api/subscribers?query=${q("1=1")}`), 3000);
      expect(third).toEqual({
        status: 429,
        body: { message: "Too many subscriber queries in progress.", code: "rate_limited" },
      });
    } finally {
      await first.body?.cancel().catch(() => {});
      await second.body?.cancel().catch(() => {});
    }
  });
});

describe("raw-query deadline", () => {
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

  test("the deadline kills and reaps both children, and their unread responses end as failed", async () => {
    const before = childPids().length;
    // Both exports start, then nobody reads them. No step below needs the deadline to come after
    // another step: the test waits for the outcome of the deadline, and does not race it. The wait
    // is bounded far above the 1 s deadline, so a kill that never comes fails by name.
    const first = await get(f, `/api/subscribers/export?query=${q("1=1")}`);
    const second = await get(f, `/api/subscribers/export?query=${q("1=1")}`);
    try {
      // Both exports must start within the 1 s deadline: a second start after the kill would show
      // the deadline's outcome without the case it names (B118a r2). Mutation: cut the child slots
      // to one, and the second export is refused here.
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(await until(() => childPids().length === before, 15_000)).toBe(true);
      expect(
        await within(
          first.text().then(
            () => "ended",
            () => "failed",
          ),
          3000,
        ),
      ).toBe("failed");
      expect(
        await within(
          second.text().then(
            () => "ended",
            () => "failed",
          ),
          3000,
        ),
      ).toBe("failed");
      // Their large-selection slots were released too.
      expect((await f.json("/api/subscribers?per_page=all")).status).toBe(200);
    } finally {
      await first.body?.cancel().catch(() => {});
      await second.body?.cancel().catch(() => {});
    }
  }, 30_000);
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
