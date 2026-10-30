// Serial measurements for docs/perf/M3.3-analytics.md; not a CI threshold. Generates the
// database under dist/ (not the tmpfs /tmp), reports each read, and removes it afterwards.
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createRealClock } from "@/clock";
import { analyticsChildArgument, createAnalyticsReader } from "@/analytics/reader";
import { createAnalyticsStore } from "@/analytics/store";
import { createSummaries } from "@/analytics/summaries";
import { createCampaignStore } from "@/campaigns/store";
import { writeTransaction } from "@/db/transaction";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createListCounts } from "@/subscribers/list-counts";
import { seed } from "@/test/analytics/seed";

const directory = resolve(process.env.ANALYTICS_MEASURE_DIR ?? "dist/analytics-measure");
const size = {
  subscribers: Number(process.env.ANALYTICS_SUBSCRIBERS ?? 1_000_000),
  views: Number(process.env.ANALYTICS_VIEWS ?? 1_000_000),
  clicks: Number(process.env.ANALYTICS_CLICKS ?? 500_000),
  sends: Number(process.env.ANALYTICS_SENDS ?? 100_000),
};
const runs = Number(process.env.ANALYTICS_RUNS ?? 5);
rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });
const db = openDatabase(directory);
try {
  runMigrations(db, directory, createRealClock(), productionMigrations);
  const started = performance.now();
  seed(db, size);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  process.stdout.write(
    `${JSON.stringify({ seed_ms: Math.round(performance.now() - started), db_mib: Math.round(statSync(resolve(directory, "iglo-email.db")).size / 1048576), ...size })}\n`,
  );
  const store = createAnalyticsStore(db);
  const counts = createListCounts(db);
  const year = { from: "2025-10-30T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" };
  const month = { from: "2026-09-30T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" };
  const big = ["90"];
  const all = Array.from({ length: 20 }, (_, i) => String(i + 1));
  const cases: [string, () => unknown][] = [
    ["dashboard/counts", () => store.dashboardCounts()],
    ["dashboard/charts", () => store.dashboardCharts()],
    ["lists counts.all", () => counts.all()],
    ["summary", () => store.summary()],
    ["campaign views year day", () => [...store.campaignCounts("total_views", big, year, "day")]],
    ["campaign views month hour", () => [...store.campaignCounts("total_views", big, month, "hour")]],
    ["campaign views unique year", () => [...store.campaignCounts("views", big, year, "day")]],
    ["campaign clicks year", () => [...store.campaignCounts("total_clicks", big, year, "day")]],
    ["campaign clicks unique year", () => [...store.campaignCounts("clicks", big, year, "day")]],
    ["campaign bounces year", () => [...store.campaignCounts("bounces", big, year, "day")]],
    ["campaign links year", () => store.links("campaign", big, year, false)],
    ["campaign links distinct", () => store.links("campaign", big, year, true)],
    ["list views 20 lists", () => [...store.listCounts("total_views", all, year, "day")]],
    ["list views unique 20 lists", () => [...store.listCounts("views", all, year, "day")]],
    ["list links 20 lists", () => store.links("list", all, year, false)],
    ["list subscriptions 20 lists", () => [...store.listCounts("subscriptions", all, year, "month")]],
    ["list unsubscriptions 20", () => [...store.listCounts("unsubscriptions", all, year, "month")]],
    ["sends by template year", () => store.sends("template", year)],
    ["sends by step year", () => store.sends("step", year)],
  ];
  const report = (values: object) => process.stdout.write(`${JSON.stringify(values)}\n`);
  const stats = (times: number[]) => {
    const sorted = [...times].sort((a, b) => a - b);
    return {
      median_ms: +sorted[sorted.length >> 1]!.toFixed(1),
      max_ms: +sorted.at(-1)!.toFixed(1),
    };
  };
  for (const [name, read] of cases) {
    const times: number[] = [];
    for (let run = 0; run < runs; run++) {
      const before = performance.now();
      read();
      times.push(performance.now() - before);
    }
    report({ name, in_process: true, ...stats(times) });
  }

  // What the routes run: the same reads in a child, through the compiled executable if built.
  const compiled = resolve("dist/iglo.email");
  const reader = createAnalyticsReader({
    path: db.filename,
    ...(existsSync(compiled) ? { command: [compiled, analyticsChildArgument] } : {}),
  });
  const timed = async (read: () => Promise<unknown>) => {
    const times: number[] = [];
    for (let run = 0; run < runs; run++) {
      const before = performance.now();
      await read();
      times.push(performance.now() - before);
    }
    return stats(times);
  };
  for (const [name, read] of [
    ["dashboard/counts", () => reader.read("dashboardCounts", [])],
    ["dashboard/charts", () => reader.read("dashboardCharts", [])],
    [
      "campaign views year day",
      () => reader.read("campaignCounts", ["total_views", big, year, "day"]),
    ],
    ["list views unique 20 lists", () => reader.read("listCounts", ["views", all, year, "day"])],
    ["sends by template year", () => reader.read("sends", ["template", year])],
  ] as [string, () => Promise<unknown>][])
    report({ name, in_child: true, compiled: existsSync(compiled), ...(await timed(read)) });

  // Summary refresh: the child's read, then the only part that holds the write lock.
  const clock = createRealClock();
  const summaries = createSummaries(db, clock, reader);
  const holds: number[] = [];
  const refreshes: number[] = [];
  for (let run = 0; run < runs; run++) {
    const before = performance.now();
    await summaries.refresh();
    refreshes.push(performance.now() - before);
    const body = await reader.read("summary", []);
    const hold = performance.now();
    const { data } = JSON.parse(new TextDecoder().decode(body)) as { data: Record<string, unknown> };
    writeTransaction(db, () => {
      for (const [name, value] of Object.entries(data))
        db.query("UPDATE analytics_summaries SET data = ?, updated_at = ? WHERE name = ?").run(
          JSON.stringify(value),
          clock.now().toISOString(),
          name,
        );
    });
    holds.push(performance.now() - hold);
  }
  report({ name: "summary refresh total", ...stats(refreshes) });
  report({ name: "summary write hold (includes FULL commit)", ...stats(holds) });

  // The hot path while a read runs: a pixel-sized insert on this thread every millisecond.
  const insertView = db.query(
    "INSERT INTO campaign_views (campaign_id, subscriber_id, created_at) VALUES (90, 1, ?)",
  );
  const lagDuring = async (read: () => Promise<unknown> | unknown) => {
    const gaps: number[] = [];
    let done = false;
    const work = (async () => {
      await Bun.sleep(5);
      await read();
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
    };
  };
  report({
    name: "pixel inserts during unique list read, in process",
    ...(await lagDuring(() => [...store.listCounts("views", all, year, "day")])),
  });
  report({
    name: "pixel inserts during unique list read, in child",
    ...(await lagDuring(() => reader.read("listCounts", ["views", all, year, "day"]))),
  });
  report({
    name: "pixel inserts during summary refresh",
    ...(await lagDuring(() => summaries.refresh())),
  });

  // Dashboard campaigns stay in process: they are six rows.
  const campaignStore = createCampaignStore(db, clock, {
    templateExists: () => false,
    defaultTemplate: () => null,
    listName: () => null,
  });
  const scope = { all: true, ids: [] };
  const filter = { query: "", tags: [], type: "" };
  const board: number[] = [];
  for (let run = 0; run < runs; run++) {
    const before = performance.now();
    campaignStore.query({ ...filter, statuses: ["scheduled"] }, scope, "created_at", "desc", 0, 6);
    campaignStore.query(
      { ...filter, statuses: ["draft", "running", "paused", "finished", "cancelled"] },
      scope,
      "created_at",
      "desc",
      0,
      6,
    );
    board.push(performance.now() - before);
  }
  report({ name: "dashboard/campaigns in process", ...stats(board) });
  campaignStore.close();
  summaries.close();
  await reader.close();
  counts.close();
  store.close();
} finally {
  db.close();
  if (process.env.ANALYTICS_KEEP !== "1") rmSync(directory, { recursive: true, force: true });
}
