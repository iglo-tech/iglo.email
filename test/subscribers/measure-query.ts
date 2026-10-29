// Bounded M1.7 measurement: query, search, export and query-selected actions over a
// 100,000-subscriber synthetic database, plus a timed-out raw query. Prints JSON lines.
// Usage: bun test/subscribers/measure-query.ts [subscribers]
import { readdirSync, readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { createQueryRunner } from "@/subscribers/query-runner";
import { queryFixture } from "@/test/subscribers/fixture";

const count = Number(process.argv[2] ?? 100_000);
const f = await queryFixture({ timeoutMs: 2_000 });
let peak = 0;
const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
const report = (name: string, values: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ name, ...values })}\n`);
const cpuSeconds = (pid: number) => {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
  return (Number(fields[11]) + Number(fields[12])) / 100;
};
const children = () =>
  readdirSync("/proc").filter((entry) => {
    if (!/^\d+$/.test(entry)) return false;
    try {
      return new RegExp(`^PPid:\\s+${process.pid}$`, "m").test(
        readFileSync(`/proc/${entry}/status`, "utf8"),
      );
    } catch {
      return false;
    }
  }).length;
async function timed(name: string, path: string, init: RequestInit = {}) {
  Bun.gc(true);
  peak = process.memoryUsage().rss;
  const before = peak;
  const started = performance.now();
  const response = await f.request(path, init);
  // Consume and discard the body, sampling RSS per chunk: streamed pulls are microtasks that
  // can starve the interval sampler.
  let bytes = 0;
  const reader = response.body!.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    peak = Math.max(peak, process.memoryUsage().rss);
  }
  const ms = Math.round(performance.now() - started);
  report(name, {
    status: response.status,
    ms,
    bytes,
    rssBeforeMB: mb(before),
    rssPeakMB: mb(peak),
  });
  return response;
}
const admin = (await f.apiUser("measure", [
  "subscribers:get_all",
  "subscribers:manage",
  "subscribers:sql_query",
  "lists:get_all",
  "lists:manage_all",
])) as Record<string, string>;
const json = { ...admin, "content-type": "application/json" };
try {
  const listA = (await f.json("/api/lists", "POST", { name: "measure-a" })).body.data.id;
  const listB = (await f.json("/api/lists", "POST", { name: "measure-b" })).body.data.id;
  const seeded = performance.now();
  const insert = f.db.prepare(
    "INSERT INTO subscribers (uuid, email, name, status, attribs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const member = f.db.prepare(
    "INSERT INTO subscriber_lists (subscriber_id, list_id, status) VALUES (?, ?, ?)",
  );
  const cities = ["Bengaluru", "Paris", "Warsaw", "Lima"];
  f.db.transaction(() => {
    for (let i = 1; i <= count; i++) {
      const row = insert.get(
        crypto.randomUUID(),
        `user${i}@example${i % 50}.test`,
        `Synthetic User${i} ${cities[i % 4]}`,
        i % 10 === 0 ? "disabled" : "enabled",
        JSON.stringify({ city: cities[i % 4], n: i }),
        "2026-01-02T03:04:05.000Z",
        "2026-01-02T03:04:05.000Z",
      ) as unknown;
      void row;
      if (i % 2 === 0)
        member.run(BigInt(i), BigInt(listA), i % 4 === 0 ? "confirmed" : "unconfirmed");
    }
  })();
  insert.finalize();
  member.finalize();
  report("seed", { subscribers: count, ms: Math.round(performance.now() - seeded) });
  const get = { headers: admin };
  const city = encodeURIComponent("subscribers.attribs->>'city' = 'Paris'");
  await timed("query-default-page", "/api/subscribers", get);
  await timed("query-last-page", `/api/subscribers?page=${count / 20}`, get);
  await timed("query-order-email", "/api/subscribers?order_by=email&order=asc", get);
  await timed(
    "query-list-confirmed",
    `/api/subscribers?list_id=${listA}&subscription_status=confirmed`,
    get,
  );
  await timed("query-orphans", "/api/subscribers?subscription_status=none", get);
  await timed("search-word", "/api/subscribers?search=user54321", get);
  await timed("search-email", "/api/subscribers?search=user54321%40example21.test", get);
  await timed("search-common-token", "/api/subscribers?search=example7", get);
  await timed("search-every-row", "/api/subscribers?search=synthetic", get);
  await timed("search-no-token", "/api/subscribers?search=%40", get);
  await timed("search-accented", `/api/subscribers?search=${encodeURIComponent("Usér54321")}`, get);
  await timed("raw-trivial", `/api/subscribers?query=${encodeURIComponent("1=1")}`, get);
  await timed("raw-attribs", `/api/subscribers?query=${city}`, get);
  await timed("raw-attribs-search", `/api/subscribers?query=${city}&search=synthetic`, get);
  await timed("query-per-page-1000", "/api/subscribers?per_page=1000", get);
  await timed("query-per-page-all", "/api/subscribers?per_page=all", get);
  await timed("export-all", "/api/subscribers/export", get);
  await timed("export-all-gzip", "/api/subscribers/export", {
    headers: { ...admin, "accept-encoding": "gzip" },
  });
  await timed("export-raw-attribs", `/api/subscribers/export?query=${city}`, get);
  // Every ID of a raw selection is drained from the child into the parent.
  await timed("export-raw-all", `/api/subscribers/export?query=${encodeURIComponent("1=1")}`, get);
  // A query that never ends: stopped at the 2 s fixture limit, child killed, CPU idle after.
  const spin = encodeURIComponent(
    "(WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c) > 0",
  );
  const before = children();
  await timed("raw-timeout", `/api/subscribers?query=${spin}`, get);
  const cpu = cpuSeconds(process.pid);
  await Bun.sleep(1000);
  report("after-timeout", {
    childrenBefore: before,
    childrenAfter: children(),
    parentCpuSecondsInNextSecond: Math.round((cpuSeconds(process.pid) - cpu) * 100) / 100,
  });
  await timed(
    "raw-heap-limit",
    `/api/subscribers?query=${encodeURIComponent("length(randomblob(1000000000)) > 0")}`,
    get,
  );
  // Child start-up: source module versus the compiled executable (when dist/ is built).
  for (const [label, command] of [
    ["source", undefined],
    ...(existsSync("dist/iglo.email")
      ? [["compiled", ["dist/iglo.email", "__subscriber-query"]]]
      : []),
  ] as const) {
    const runner = createQueryRunner({
      path: f.db.filename,
      timeoutMs: 10_000,
      concurrency: 1,
      ...(command ? { command: [...command] } : {}),
    });
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      await runner.all([{ sql: "SELECT 1", args: [] }]);
      samples.push(Math.round(performance.now() - started));
    }
    report(`child-roundtrip-${label}`, { ms: samples });
  }
  const body = (value: unknown) => ({ method: "PUT", headers: json, body: JSON.stringify(value) });
  await timed(
    "bulk-add-raw",
    "/api/subscribers/query/lists",
    body({
      query: "subscribers.id % 3 = 0",
      action: "add",
      target_list_ids: [listB],
      status: "confirmed",
    }),
  );
  await timed(
    "bulk-unsubscribe-search",
    "/api/subscribers/query/lists",
    body({
      search: "Paris",
      action: "unsubscribe",
      target_list_ids: [listB],
    }),
  );
  await timed(
    "bulk-blocklist-raw",
    "/api/subscribers/query/blocklist",
    body({
      query: "subscribers.attribs->>'city' = 'Lima'",
    }),
  );
  await timed("bulk-delete-all", "/api/subscribers/query/delete", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ all: true }),
  });
  report("remaining", {
    subscribers: Number(
      (f.db.query("SELECT count(*) AS n FROM subscribers").get() as { n: bigint }).n,
    ),
  });
} finally {
  clearInterval(sampler);
  await f.close();
}
