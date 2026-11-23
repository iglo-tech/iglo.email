// B130 (D128): the enrollment exits of the unsubscribe paths, planned and timed on the production schema
// (every migration in the catalog, no ANALYZE) with about 600k active enrollments. Per statement it prints
// EXPLAIN QUERY PLAN for one subscriber and the median of 9 single-subscriber runs, each inside a transaction
// that is rolled back, after one warm-up run. The data: 200k subscribers; the scoped list (id 1) has three
// sequences (transactional, mixed, marketing) with 1,000 active enrollments each; the other list (id 2) has
// three sequences with 200k active enrollments each. Run: bun test/perf/b130-enrollment-exits.ts
import { Database } from "bun:sqlite";
import { productionMigrations } from "@/db/migrations";
import { prepareNamedQueries } from "@/db/queries";
import enrollmentQueries from "@/sequences/enrollments.sql" with { type: "text" };

const subscribers = 200_000;
const otherListEnrollments = 200_000;
const scopedEnrollments = 1000;
const runs = 9;

const db = new Database(":memory:");
db.run("PRAGMA foreign_keys = ON");
for (const migration of productionMigrations) {
  db.exec(migration.sql);
}

db.run(
  `INSERT INTO lists (id, uuid, name, type) VALUES (1, 'list-news', 'News', 'public'), (2, 'list-other', 'Other', 'public')`,
);
// Scoped list 1: transactional (step 1), mixed (steps 2 and 3), marketing (step 4).
// Other list 2: transactional (step 5), mixed (steps 6 and 7), marketing (step 8).
db.run(`INSERT INTO sequences (id, uuid, name, status, trigger, list_id) VALUES
  (1, 'seq-1', 'Scoped tx', 'active', '{"event":"ev"}', 1),
  (2, 'seq-2', 'Scoped mixed', 'active', '{"event":"ev"}', 1),
  (3, 'seq-3', 'Scoped marketing', 'active', '{"event":"ev"}', 1),
  (4, 'seq-4', 'Other tx', 'active', '{"event":"ev"}', 2),
  (5, 'seq-5', 'Other mixed', 'active', '{"event":"ev"}', 2),
  (6, 'seq-6', 'Other marketing', 'active', '{"event":"ev"}', 2)`);
db.run(`INSERT INTO sequence_steps (id, uuid, sequence_id, position, wait, kind) VALUES
  (1, 'st-1', 1, 1, 'PT1H', 'transactional'),
  (2, 'st-2', 2, 1, 'PT1H', 'transactional'),
  (3, 'st-3', 2, 2, 'PT1H', 'marketing'),
  (4, 'st-4', 3, 1, 'PT1H', 'marketing'),
  (5, 'st-5', 4, 1, 'PT1H', 'transactional'),
  (6, 'st-6', 5, 1, 'PT1H', 'transactional'),
  (7, 'st-7', 5, 2, 'PT1H', 'marketing'),
  (8, 'st-8', 6, 1, 'PT1H', 'marketing')`);
db.run(
  `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
   INSERT INTO subscribers (uuid, email, name) SELECT 'sub-' || i, 'sub' || i || '@example.test', 'Sub ' || i FROM n`,
  [subscribers],
);
/** `count` active enrollments of one sequence, on subscribers 1 to `count`, waiting on one step. */
function enroll(sequenceId: number, stepId: number, count: number) {
  db.run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
     INSERT INTO enrollments (sequence_id, subscriber_id, step_id, due_at, status) SELECT ?1, i, ?3, '2026-01-01T00:00:00.000Z', 'active' FROM n`,
    [sequenceId, count, stepId],
  );
}
enroll(1, 1, scopedEnrollments);
enroll(2, 2, scopedEnrollments);
enroll(3, 4, scopedEnrollments);
enroll(4, 5, otherListEnrollments);
enroll(5, 6, otherListEnrollments);
enroll(6, 8, otherListEnrollments);
const active = db
  .query<{ count: number }, []>("SELECT count(*) AS count FROM enrollments WHERE status = 'active'")
  .get();
console.log(`active enrollments: ${active?.count}`);

const queries = prepareNamedQueries(db, [
  { name: "sequences/enrollments", sql: enrollmentQueries },
]);
const timed = [
  {
    name: "exit-by-lists",
    args: (subscriber: number) => [
      "2026-02-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      JSON.stringify([subscriber]),
      JSON.stringify([1]),
    ],
  },
  {
    name: "exit-marketing-by-subscriber",
    args: (subscriber: number) => [
      "2026-02-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      subscriber,
    ],
  },
  {
    name: "exit-by-subscribers",
    args: (subscriber: number) => [
      "2026-02-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      JSON.stringify([subscriber]),
    ],
  },
];

function median(values: Array<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

// The statement text of a named query, as the file holds it (its marker line and the statement).
function namedSql(source: string, name: string): string {
  const block = source.split(/^-- name: /m).find((part) => part.startsWith(`${name}\n`));
  if (block === undefined) {
    throw new Error(`no named query ${name}`);
  }
  return block.slice(name.length + 1);
}

for (const statement of timed) {
  const prepared = queries.get(statement.name);
  const plan = db
    .query<{ detail: string }, Array<string | number>>(
      `EXPLAIN QUERY PLAN ${namedSql(enrollmentQueries, statement.name)}`,
    )
    .all(...statement.args(1))
    .map((row) => row.detail);
  console.log(`${statement.name} plan: ${plan.join(" | ")}`);
  const times: Array<number> = [];
  for (let run = 0; run <= runs; run += 1) {
    const subscriber = (run % runs) + 1;
    db.run("BEGIN");
    const start = performance.now();
    prepared.run(...statement.args(subscriber));
    const elapsed = performance.now() - start;
    db.run("ROLLBACK");
    if (run > 0) {
      times.push(elapsed);
    }
  }
  console.log(
    `${statement.name}: median ${median(times).toFixed(3)} ms over ${runs} runs (min ${Math.min(...times).toFixed(3)}, max ${Math.max(...times).toFixed(3)})`,
  );
}
queries.close();
db.close();
