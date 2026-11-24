// B127 r2 (D135): the write cost of migration 0028's status index, the two analytics reads that moved to
// it, and the cost of migration 0029's column, measured at a million sends. Two databases are built empty
// and migrated, one to schema 27 and one to schema 28, then filled with the same sends. Each repetition
// inserts a batch of queued sends in one transaction, claims each one (queued -> sending) and settles it
// (sending -> sent), one transaction per claim and per settle, as the send path does, with
// synchronous=FULL. The claim and the settle are the production `createSends` functions (`claim` and
// `finish`, B118g), and migration 0029 is timed with its production SQL. Serial, opt-in, not a CI
// threshold; the results are stored in
// docs/perf/B127-operator-views.md.
// Usage: bun test/sends/measure-status-index.ts [sends] [batch] [repetitions]
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAnalyticsStore } from "@/analytics/store";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { must } from "@/invariant";
import { createListReferences } from "@/lists/references";
import type { Outcome } from "@/messaging/email";
import { createSends } from "@/messaging/sends";
import { createSubscriberStore } from "@/subscribers/store";

const repository = resolve(import.meta.dir, "../..");
const analyticsText = readFileSync(join(repository, "src/analytics/queries.sql"), "utf-8");
const [sendsArg, batchArg, repsArg] = process.argv.slice(2);
const sends = Number(sendsArg ?? 1_000_000);
const batch = Number(batchArg ?? 20_000);
const repetitions = Number(repsArg ?? 3);
const clock = createRealClock();
const root = mkdtempSync(join(tmpdir(), "iglo-status-index-"));

const median = (values: Array<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const ms = (start: number) => Math.round(performance.now() - start);

type Database = ReturnType<typeof openDatabase>;

// The same sends for both schemas: 95% sent (5% of those keep a payload), 5% skipped, half tx and half
// sequence, spread over 5,000 subscribers and 300 days.
function populate(db: Database, count: number) {
  db.transaction(() => {
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
       INSERT INTO subscribers (uuid, email, name)
       SELECT 'sub-' || i, 'subscriber' || i || '@example.test', 'Subscriber ' || i FROM n`,
    );
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO sends (uuid, source, kind, subscriber_id, to_email, status, skip_reason,
         smtp_message_id, payload, created_at, sent_at)
       SELECT 'seed-' || i,
         CASE WHEN i % 2 = 0 THEN 'tx' ELSE 'sequence' END,
         CASE WHEN i % 3 = 0 THEN 'marketing' ELSE 'transactional' END,
         1 + i % 5000,
         'subscriber' || (i % 5000) || '@example.test',
         CASE WHEN i % 20 = 0 THEN 'skipped' ELSE 'sent' END,
         CASE WHEN i % 20 = 0 THEN 'frequency_cap' ELSE NULL END,
         'smtp-' || i,
         CASE WHEN i % 20 = 1 THEN '{}' ELSE NULL END,
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || (i % 300) || ' days'),
         CASE WHEN i % 20 = 0 THEN NULL
           ELSE strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || (i % 300) || ' days') END
       FROM n`,
      [count],
    );
  })();
}

// Migration 0029's column, timed on a million enrollment rows: the production migration's own SQL
// (`productionMigrations`, version 29), run on the schema-28 database. The foreign keys are off while
// the rows load, since their parents do not matter to the time of adding a column.
function enrollments(db: Database, count: number) {
  db.run("PRAGMA foreign_keys = OFF");
  db.transaction(() => {
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO enrollments (sequence_id, subscriber_id, status, exit_reason, created_at,
         updated_at, finished_at)
       SELECT 1, 1 + i % 5000, 'exited', 'condition', '2026-01-01T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z' FROM n`,
      [count],
    );
  })();
  db.run("PRAGMA foreign_keys = ON");
  const migration = productionMigrations.find((candidate) => candidate.version === 29);
  const start = performance.now();
  db.exec(must(migration, "migration 0029").sql);
  return ms(start);
}

// The statement of an analytics query, by its name in src/analytics/queries.sql.
function statement(name: string) {
  const block = analyticsText.split("-- name: ").find((part) => part.startsWith(`${name}\n`));
  return (block ?? "").replace(/^[^\n]*\n/, "");
}

function measure(version: number) {
  const dataDir = join(root, `schema-${version}`);
  const db = openDatabase(dataDir);
  try {
    runMigrations(db, dataDir, clock, productionMigrations.slice(0, version));
    const loadStart = performance.now();
    populate(db, sends);
    const load = ms(loadStart);

    const insert = db.query(
      `INSERT INTO sends (uuid, source, kind, subscriber_id, to_email, status, smtp_message_id,
         payload, created_at)
       VALUES (?1, 'tx', 'transactional', ?2, ?3, 'queued', ?4, '{}', ?5)`,
    );
    // The send path's own claim and settle (src/messaging/sends.ts): `claim` takes the lowest due
    // row, and `finish` journals an accepted outcome, so the writes measured are the production ones.
    const journal = createSends({
      db,
      clock,
      subscribers: createSubscriberStore(db, clock, createListReferences(db)),
      rootUrl: () => "http://measure.test",
    });
    const accepted: Outcome = {
      messageId: "measure",
      status: "accepted",
      stage: "smtp-complete",
      accepted: [],
      rejected: [],
    };
    const timings = {
      insert: [] as Array<number>,
      claim: [] as Array<number>,
      settle: [] as Array<number>,
    };
    for (let rep = 0; rep < repetitions; rep++) {
      const now = clock.now().toISOString();
      const insertStart = performance.now();
      db.transaction(() => {
        for (let i = 0; i < batch; i++) {
          insert.run(
            `queued-${version}-${rep}-${i}-${now}`,
            1 + (i % 5000),
            `q${i}@example.test`,
            `q-${i}`,
            now,
          );
        }
      })();
      timings.insert.push(ms(insertStart));

      const claimed: Array<Parameters<typeof journal.finish>[0]> = [];
      const time = clock.now();
      const lease = new Date(time.getTime() + 60_000);
      const claimStart = performance.now();
      for (let i = 0; i < batch; i++) {
        db.transaction(() => {
          claimed.push(...journal.claim(time, lease));
        })();
      }
      timings.claim.push(ms(claimStart));

      const settleStart = performance.now();
      for (const row of claimed) {
        db.transaction(() => journal.finish(row, accepted))();
      }
      timings.settle.push(ms(settleStart));
    }

    // After the write timings, so the enrollment rows do not change them.
    const alter = version === 28 ? enrollments(db, sends) : null;

    const range = { from: "2025-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" };
    const analytics = createAnalyticsStore(db);
    const byTemplate: Array<number> = [];
    const byStep: Array<number> = [];
    for (let run = 0; run < 7; run++) {
      const templateStart = performance.now();
      analytics.sends("template", range);
      byTemplate.push(ms(templateStart));
      const stepStart = performance.now();
      analytics.sends("step", range);
      byStep.push(ms(stepStart));
    }
    const spread = (values: Array<number>) => ({
      median: median(values),
      min: Math.min(...values),
      max: Math.max(...values),
    });
    const plan = (sql: string) =>
      db
        .query<{ detail: string }, Array<string>>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(range.from, range.to)
        .map((row) => row.detail)
        .join(" | ");
    return {
      version,
      load,
      alter,
      timings,
      reads: { byTemplate: spread(byTemplate), byStep: spread(byStep) },
      plans: {
        byTemplate: plan(statement("sends-by-template")),
        byStep: plan(statement("sends-by-step")),
      },
    };
  } finally {
    db.close(true);
  }
}

try {
  const results = [27, 28].map((version) => measure(version));
  for (const result of results) {
    console.log(JSON.stringify(result, null, 2));
  }
  console.log(`medians of ${repetitions} repetitions, ${sends} sends, batch ${batch} (ms):`);
  for (const result of results) {
    const summary = Object.fromEntries(
      Object.entries(result.timings).map(([phase, values]) => [phase, median(values)]),
    );
    console.log(`schema ${result.version}: ${JSON.stringify(summary)}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
