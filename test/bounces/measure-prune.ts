// Serial timing for docs/perf/M3.4-bounces.md; opt-in, not a CI threshold. The write hold of one
// request's receipt pruning on a real file, over a seeded expired backlog.
// Usage: bun test/bounces/measure-prune.ts [rows]
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const rows = Number(process.argv[2] ?? 1_000_000);
const batch = 100;
const base = join(resolve(import.meta.dir, "../.."), "upstream/measurements");
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, "prune-"));
const db = new Database(join(directory, "receipts.db"));
const milliseconds = (run: () => void) => {
  const started = performance.now();
  db.transaction(run)();
  return +(performance.now() - started).toFixed(2);
};
try {
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE r (key TEXT PRIMARY KEY, expires_at TEXT NOT NULL) WITHOUT ROWID");
  db.run("CREATE INDEX r_expires ON r(expires_at)");
  const insert = db.query("INSERT INTO r VALUES (?, ?)");
  const expired = "2026-01-01T00:00:00.000Z",
    now = "2026-01-02T00:00:00.000Z";
  db.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(`event:${crypto.randomUUID()}`, expired);
  })();
  const bounded = db.query(`DELETE FROM r WHERE key IN
    (SELECT key FROM r WHERE expires_at <= ?1 ORDER BY expires_at LIMIT ?2)`);
  const times = Array.from({ length: 200 }, () => milliseconds(() => bounded.run(now, batch)));
  const sorted = times.toSorted((a, b) => a - b);
  const left = (db.query("SELECT count(*) AS n FROM r").get() as { n: number }).n;
  const whole = milliseconds(() => db.query("DELETE FROM r WHERE expires_at <= ?").run(now));
  process.stdout.write(
    `${JSON.stringify({
      rows,
      batch,
      bounded: { p50: sorted[100], p99: sorted[197], max: sorted.at(-1) },
      whole: { rows: left, ms: whole },
    })}\n`,
  );
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
