// B143b (D162): the plan check for the forecast's `sends` start-time index. Not a CI threshold and
// not a test (plans are an implementation detail): `bun test/perf/projects/sends-started.ts [rows]`.
// It opens an instance (every project migration applied), seeds `rows` sends with every status and
// every mix of `attempted_at` and `sent_at` (NULLs included), then
//   1. prints EXPLAIN QUERY PLAN of the forecast's count and fails unless it is a search of
//      `idx_sends_started` alone (a covering index), and
//   2. fails unless the count equals the same statement forced to scan the table (`NOT INDEXED`),
//      for several `day`/`from` pairs.
// With `writes` after the row count, it then measures the index's own write cost (below).
// The statement is `sends.starts` in src/messaging/sends.ts, copied: keep the two the same.
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openInstance } from "@/projects/instance";
import { adminCredentials } from "@/test/projects/fixture";

const ROWS = Number(process.argv[2] ?? 100_000);
const starts = (table: string) =>
  `SELECT COUNT(*) AS day, SUM(coalesce(attempted_at, sent_at) > ?2) AS window FROM ${table}
   WHERE status IN ('sending', 'sent', 'unknown') AND coalesce(attempted_at, sent_at) > ?1`;

const stamp = () => new Date().toISOString();

const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-b143b-plan-"));
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
let failed = false;
try {
  await instance.close();
  const db = new Database(join(dataDir, "projects", "main", "iglo-email.db"));
  const now = Date.now();
  // Times over the last 48 hours; each column NULL in a third of the rows, independently of the
  // other and of the status (`i % 6`).
  const at = (block: number, salt: number) =>
    `CASE (i / ${block}) % 3 WHEN 0 THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', (${now} - 172800000.0 * ((i * ${salt}) % 9973) / 9973) / 1000.0, 'unixepoch') END`;
  db.run(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS})
    INSERT INTO sends (uuid, source, kind, to_email, status, created_at, attempted_at, sent_at)
    SELECT 'p-' || i, 'tx', CASE i % 2 WHEN 0 THEN 'marketing' ELSE 'transactional' END,
      'x@example.test',
      CASE i % 6 WHEN 0 THEN 'queued' WHEN 1 THEN 'sending' WHEN 2 THEN 'sent' WHEN 3 THEN 'failed'
        WHEN 4 THEN 'skipped' ELSE 'unknown' END,
      '2026-01-01T00:00:00Z', ${at(6, 7)}, ${at(18, 13)} FROM n`);
  const plan = db
    .query<{ detail: string }, [string, string]>(`EXPLAIN QUERY PLAN ${starts("sends")}`)
    .all("a", "b")
    .map((row) => row.detail);
  console.log(`plan: ${plan.join(" | ")}`);
  if (!plan.some((detail) => detail.includes("USING COVERING INDEX idx_sends_started"))) {
    console.error("the count does not search idx_sends_started alone");
    failed = true;
  }
  const iso = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  for (const [day, from] of [
    [24, 24],
    [24, 12],
    [24, 0.5],
    [48, 30],
    [0.25, 0.1],
  ] as const) {
    const indexed = db.query(starts("sends")).get(iso(day), iso(from));
    const scanned = db.query(starts("sends NOT INDEXED")).get(iso(day), iso(from));
    const same = JSON.stringify(indexed) === JSON.stringify(scanned);
    console.log(
      `day ${day} h, from ${from} h: ${JSON.stringify(indexed)} ${same ? "=" : "≠"} scan`,
    );
    failed ||= !same;
  }
  db.close();
  if (process.argv[3] === "writes") {
    const db = new Database(join(dataDir, "projects", "main", "iglo-email.db"));
    // The index's write cost on its own: WRITES queued rows inserted in transactions of 10 (an
    // enqueue), then claimed 10 at a time (`queued` → `sending` with `attempted_at`) and finished
    // one by one (`sent` with `sent_at`), as the outbox does. Rounds alternate with and without
    // the index, on the seeded table.
    const WRITES = 20_000;
    const rate = (ms: number) => Math.round((WRITES / ms) * 1000);
    let round = 0;
    const measure = (indexed: boolean) => {
      const insert = db.prepare<{ id: number }, [string]>(
        "INSERT INTO sends (uuid, source, kind, to_email, status) VALUES (?, 'tx', 'transactional', 'w@example.test', 'queued') RETURNING id",
      );
      const claim = db.prepare(
        "UPDATE sends SET status = 'sending', attempted_at = ?, attempts = attempts + 1 WHERE id = ?",
      );
      const finish = db.prepare("UPDATE sends SET status = 'sent', sent_at = ? WHERE id = ?");
      const ids: Array<number> = [];
      let t = performance.now();
      for (let batch = 0; batch < WRITES / 10; batch++) {
        db.transaction(() => {
          for (let i = 0; i < 10; i++) {
            ids.push(insert.get(`w-${round}-${batch}-${i}`)!.id);
          }
        })();
      }
      const inserted = performance.now() - t;
      t = performance.now();
      for (let batch = 0; batch < ids.length; batch += 10) {
        db.transaction(() => {
          for (const id of ids.slice(batch, batch + 10)) {
            claim.run(stamp(), id);
          }
        })();
      }
      const claimed = performance.now() - t;
      t = performance.now();
      for (const id of ids) {
        finish.run(stamp(), id);
      }
      const finished = performance.now() - t;
      round++;
      for (const statement of [insert, claim, finish]) {
        statement.finalize();
      }
      console.log(
        JSON.stringify({
          indexed,
          insertPerSecond: rate(inserted),
          claimPerSecond: rate(claimed),
          finishPerSecond: rate(finished),
        }),
      );
    };
    for (let i = 0; i < 3; i++) {
      for (const indexed of i % 2 ? [false, true] : [true, false]) {
        db.run("DROP INDEX IF EXISTS idx_sends_started");
        if (indexed) {
          db.run(
            "CREATE INDEX idx_sends_started ON sends(status, coalesce(attempted_at, sent_at))",
          );
        }
        measure(indexed);
      }
    }
    db.close();
  }
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
