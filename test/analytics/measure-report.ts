// Does a large report fit the reader's limits? Every ID gets one view in every hour of a year,
// the densest result 20 and 50 IDs can return, and the compiled child reports its peak memory.
// Below the million-row sizes on purpose: the result's size is what is measured. Not a CI
// threshold. Also times the sends filter on 100,000 sends.
import { mkdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { analyticsChildArgument, createAnalyticsReader } from "@/analytics/reader";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";

const directory = resolve(process.env.ANALYTICS_MEASURE_DIR ?? "dist/analytics-report");
const compiled = resolve("dist/iglo.email");
const report = (values: object) => process.stdout.write(`${JSON.stringify(values)}\n`);
const series = (count: number) =>
  `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})`;
const start = Date.parse("2025-10-30T00:00:00.000Z") / 1000;
const hours = 8760;
const ids = 50;
const sends = 100_000;
const at = (seconds: string) =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', ${start} + ${seconds}, 'unixepoch')`;
const range = {
  from: "2025-10-30T00:00:00.000Z",
  to: "2026-10-31T00:00:00.000Z",
};
rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });
const db = openDatabase(directory);
try {
  runMigrations(db, directory, createRealClock(), productionMigrations);
  db.transaction(() => {
    db.run(`${series(ids)} INSERT INTO campaigns (id, uuid, name, subject, from_email, body, messenger)
      SELECT i, 'c-' || i, 'C', 's', 'a@example.test', 'b', 'email' FROM n`);
    db.run(`${series(ids)} INSERT INTO lists (id, uuid, name, type, optin)
      SELECT i, 'l-' || i, 'L', 'public', 'single' FROM n`);
    db.run(`${series(ids)} INSERT INTO campaign_lists (campaign_id, list_id, list_name)
      SELECT i, i, 'L' FROM n`);
    db.run(`${series(hours * ids)} INSERT INTO campaign_views (campaign_id, created_at)
      SELECT 1 + i % ${ids}, ${at(`(i / ${ids}) * 3600.0`)} FROM n`);
    db.run(`INSERT INTO templates (id, name, type, subject, body) VALUES (1, 'T', 'tx', 's', 'b')`);
    db.run(`${series(sends)} INSERT INTO sends (id, uuid, source, kind, to_email, template_id, status, created_at, sent_at)
      SELECT i, 's-' || i, 'tx', 'transactional', 'a@example.test', 1, 'sent', ${at(`i * 315.0`)}, ${at(`i * 315.0 + 60`)} FROM n`);
  })();
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  report({
    views: hours * ids,
    sends,
    db_mib: statSync(db.filename).size >> 20,
  });

  const peak = async (method: string, args: unknown[]) => {
    const child = Bun.spawn([compiled, analyticsChildArgument], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    child.stdin.write(JSON.stringify({ path: db.filename, method, args }));
    await child.stdin.end();
    let bytes = 0;
    for await (const chunk of child.stdout) bytes += chunk.length;
    await child.exited;
    return {
      output_mib: +(bytes / 1048576).toFixed(1),
      peak_rss_mib: child.resourceUsage()!.maxRSS >> 20,
    };
  };
  const reader = createAnalyticsReader({
    path: db.filename,
    command: [compiled, analyticsChildArgument],
  });
  for (const count of [20, 50]) {
    const list = Array.from({ length: count }, (_, i) => String(i + 1));
    for (const method of ["campaignCounts", "listCounts"] as const) {
      const args = ["total_views", list, range, "hour"] as const;
      const before = performance.now();
      const outcome = await reader.read(method, [...args]).then(
        (body) => `served ${body.length >> 20} MiB`,
        (error: { kind: string }) => `refused: ${error.kind}`,
      );
      report({
        name: `${method}, ${count} IDs, a year by hour`,
        ms: Math.round(performance.now() - before),
        outcome,
        ...(await peak(method, [...args])),
      });
    }
  }
  await reader.close();

  // The sent CTE alone, before (created_at, by index) and after (sent_at, by status).
  const narrow = ["2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z"];
  for (const column of ["created_at", "sent_at"]) {
    const query = db.query(
      `SELECT template_id, COUNT(*) FROM sends WHERE status = 'sent' AND ${column} >= ? AND ${column} <= ? GROUP BY template_id`,
    );
    const times: number[] = [];
    for (let run = 0; run < 5; run++) {
      const before = performance.now();
      query.all(...narrow);
      times.push(performance.now() - before);
    }
    times.sort((a, b) => a - b);
    report({
      name: `sends filter on ${column}, one day`,
      median_ms: +times[2]!.toFixed(1),
    });
  }
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
