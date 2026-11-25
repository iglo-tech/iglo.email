// B149a (D164): the Projects page's "sent in 24 h" count before and after it moved to the start-time
// index. Not a test and not a CI threshold: `bun test/projects/measure-activity.ts [rows] [runs]`.
// It opens an instance (every project migration applied), seeds `rows` sent sends spread evenly
// over the last 30 days (about 1 in 30 in the window), a few in every other status, then for each
// statement prints EXPLAIN QUERY PLAN, its count, and the median and worst of `runs` timed reads.
// `before` is the statement B143a shipped, copied here; `after` is src/analytics/activity.ts's,
// read through createProjectActivity, the function the Projects page and its API call.
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectActivity } from "@/analytics/activity";
import { createRealClock } from "@/clock";
import { openInstance } from "@/projects/instance";
import { adminCredentials } from "@/test/projects/fixture";

const ROWS = Number(process.argv[2] ?? 1_000_000);
const RUNS = Number(process.argv[3] ?? 21);
const BEFORE = "SELECT count(*) AS total FROM sends WHERE status = 'sent' AND sent_at >= ?1";
const AFTER =
  "SELECT count(*) AS total FROM sends WHERE status = 'sent' AND coalesce(attempted_at, sent_at) >= ?1";

const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-b149a-activity-"));
try {
  const admin = await adminCredentials();
  const instance = await openInstance(
    {
      dataDir,
      rootUrl: "http://127.0.0.1",
      listen: { host: "127.0.0.1", port: 0 },
      seed: { admin: { user: admin.user, password: admin.password } },
    },
    createRealClock(),
  );
  await instance.close();
  const db = new Database(join(dataDir, "projects", "main", "iglo-email.db"));
  const now = Date.now();
  const at = (offset: number) =>
    `strftime('%Y-%m-%dT%H:%M:%fZ', (${now} - 2592000000.0 * ((i * 7919) % 100003) / 100003 - ${offset}) / 1000.0, 'unixepoch')`;
  // Sent rows: started (attempted_at) 2 s before they were delivered (sent_at); 1 in 50 has no
  // attempted_at, as a row sent before attempts were recorded.
  db.run(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS})
    INSERT INTO sends (uuid, source, kind, to_email, status, created_at, attempted_at, sent_at)
    SELECT 's-' || i, 'tx', CASE i % 2 WHEN 0 THEN 'marketing' ELSE 'transactional' END,
      'x@example.test', CASE i % 20 WHEN 0 THEN 'queued' WHEN 1 THEN 'failed' ELSE 'sent' END,
      ${at(4000)}, CASE i % 50 WHEN 7 THEN NULL ELSE ${at(2000)} END, ${at(0)} FROM n`);
  db.run("UPDATE sends SET sent_at = NULL, attempted_at = NULL WHERE status = 'queued'");
  const since = new Date(now - 24 * 3_600_000);
  const activity = createProjectActivity(db);
  const sides = [
    { name: "before", sql: BEFORE, read: () => db.query(BEFORE).get(since.toISOString()) },
    { name: "after", sql: AFTER, read: () => activity.read(since).sent },
  ];
  const plan = (sql: string) =>
    db
      .query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${sql}`)
      .all("x")
      .map((row) => row.detail)
      .join(" | ");
  console.log(
    `rows ${ROWS}, runs ${RUNS}, load ${(await Bun.file("/proc/loadavg").text()).trim()}`,
  );
  for (const side of sides) {
    side.read();
    const times: Array<number> = [];
    for (let run = 0; run < RUNS; run++) {
      const t = performance.now();
      side.read();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    console.log(
      `${side.name}: plan ${plan(side.sql)}; count ${JSON.stringify(side.read())}; ` +
        `median ${times[Math.floor(times.length / 2)]!.toFixed(2)} ms, worst ${times.at(-1)!.toFixed(2)} ms`,
    );
  }
  activity.close();
  db.close();
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
