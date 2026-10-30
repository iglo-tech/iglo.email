// Serial measurement of GET /api/dashboard/campaigns for docs/perf/M3.3-analytics.md: the six
// newest campaigns are finished and hold every campaign event. Not a CI threshold.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { analyticsChildArgument, createAnalyticsReader } from "@/analytics/reader";
import { createRealClock } from "@/clock";
import { createCampaignStore } from "@/campaigns/store";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { seed } from "@/test/analytics/seed";

const directory = resolve(process.env.ANALYTICS_MEASURE_DIR ?? "dist/analytics-card");
const runs = Number(process.env.ANALYTICS_RUNS ?? 5);
const report = (values: object) => process.stdout.write(`${JSON.stringify(values)}\n`);
const stats = (times: number[]) => {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    median_ms: +sorted[sorted.length >> 1]!.toFixed(1),
    max_ms: +sorted.at(-1)!.toFixed(1),
  };
};
rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });
const db = openDatabase(directory);
try {
  const clock = createRealClock();
  runMigrations(db, directory, clock, productionMigrations);
  seed(db, {
    subscribers: 1_000_000,
    views: 1_000_000,
    clicks: 500_000,
    sends: 0,
    recentLarge: true,
  });
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const store = createCampaignStore(db, clock, {
    templateExists: () => false,
    defaultTemplate: () => null,
    listName: () => null,
    mediaFilename: () => null,
  });
  const scope = { all: true, ids: [] };
  const filter = { query: "", tags: [], type: "" };
  const newest = (statuses: string[]) =>
    store.query({ ...filter, statuses }, scope, "created_at", "desc", 0, 6).rows;
  const card = () => {
    newest(["scheduled"]);
    return newest(["draft", "running", "paused", "finished", "cancelled"]);
  };
  const times: number[] = [];
  for (let run = 0; run < runs; run++) {
    const before = performance.now();
    const rows = card();
    times.push(performance.now() - before);
    if (run === 0)
      report({
        rows: rows.map((row) => ({
          id: Number(row.id),
          status: row.status,
          views: Number(row.views),
          clicks: Number(row.clicks),
        })),
      });
  }
  report({ name: "dashboard/campaigns in process", ...stats(times) });

  const compiled = resolve("dist/iglo.email");
  const reader = createAnalyticsReader({
    path: db.filename,
    ...(existsSync(compiled) ? { command: [compiled, analyticsChildArgument] } : {}),
  });
  const read = () => reader.read("dashboardCampaigns", [true, []]);
  const children: number[] = [];
  for (let run = 0; run < runs; run++) {
    const before = performance.now();
    await read();
    children.push(performance.now() - before);
  }
  report({
    name: "dashboard/campaigns in child",
    compiled: existsSync(compiled),
    ...stats(children),
  });

  // A pixel-sized insert on this thread every millisecond while the card loads repeatedly.
  const insertView = db.query(
    "INSERT INTO campaign_views (campaign_id, subscriber_id, created_at) VALUES (100, 1, ?)",
  );
  const lagDuring = async (load: () => Promise<unknown> | unknown) => {
    const gaps: number[] = [];
    let done = false;
    const work = (async () => {
      for (let run = 0; run < runs; run++) {
        await Bun.sleep(5);
        await load();
      }
      done = true;
    })();
    let last = performance.now();
    while (!done) {
      await Bun.sleep(1);
      insertView.run(new Date().toISOString());
      const at = performance.now();
      gaps.push(at - last);
      last = at;
    }
    await work;
    gaps.sort((a, b) => a - b);
    return {
      views_written: gaps.length,
      p50_gap_ms: +gaps[gaps.length >> 1]!.toFixed(1),
      p99_gap_ms: +gaps[Math.floor(gaps.length * 0.99)]!.toFixed(1),
      max_gap_ms: +gaps.at(-1)!.toFixed(1),
      largest_ms: gaps.slice(-3).map((gap) => +gap.toFixed(1)),
    };
  };
  // The control: the first commits after seeding pay for the file, not for any read.
  const idle = async () => Bun.sleep(100);
  report({ name: "pixel inserts, no read", ...(await lagDuring(idle)) });
  report({ name: "pixel inserts, no read, again", ...(await lagDuring(idle)) });
  report({
    name: "pixel inserts during card, in process",
    ...(await lagDuring(card)),
  });
  report({
    name: "pixel inserts during card, in child",
    ...(await lagDuring(read)),
  });
  await reader.close();
  store.close();
} finally {
  db.close();
  if (process.env.ANALYTICS_KEEP !== "1") rmSync(directory, { recursive: true, force: true });
}
