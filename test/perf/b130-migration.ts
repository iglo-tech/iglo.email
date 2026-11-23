// B130 (D128): migration 0030 on the sample transactional template, timed alone. Each run is a fresh
// in-memory SQLite that holds the sample as the pre-B129 release seeded it and a second, unrelated row. Migration
// 0027 runs first, untimed, so the sample holds the B129 body that 0030 matches; then 0030 is timed. Run:
// bun test/perf/b130-migration.ts
import { Database } from "bun:sqlite";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const earlier = await Bun.file(
  join(root, "test/bootstrap/earlier-templates/sample-tx.tpl.txt"),
).text();
const migration27 = await Bun.file(join(root, "migrations/0027_remove_template_credit.sql")).text();
const migration30 = await Bun.file(join(root, "migrations/0030_sample_template_brand.sql")).text();
const runs = 30;

function fresh() {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE templates (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, body_source TEXT, is_default INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '')",
  );
  db.run(
    "INSERT INTO templates (name, type, body) VALUES ('Sample transactional template', 'tx', ?)",
    [earlier],
  );
  db.run(
    "INSERT INTO templates (name, type, body) VALUES ('Unrelated', 'tx', 'Hello {{ subscriber.name }}')",
  );
  db.exec(migration27);
  return db;
}

const timings: Array<number> = [];
for (let run = 0; run < runs; run += 1) {
  const db = fresh();
  const start = performance.now();
  db.exec(migration30);
  timings.push(performance.now() - start);
  const sample = db
    .query<{ body: string }, []>(
      "SELECT body FROM templates WHERE name = 'Sample transactional template'",
    )
    .get();
  const unrelated = db
    .query<{ body: string }, []>("SELECT body FROM templates WHERE name = 'Unrelated'")
    .get();
  if (
    !sample?.body.includes("{{ brand_accent }}") ||
    unrelated?.body !== "Hello {{ subscriber.name }}"
  ) {
    throw new Error("migration 0030 did not rewrite exactly the sample row");
  }
  db.close();
}
const sorted = [...timings].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)]!;
const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
console.log(
  `migration 0030: median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms over ${runs} runs`,
);
