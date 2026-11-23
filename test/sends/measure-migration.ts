// B117d (D139): the upgrade to schema 31 at a million sends with 2 KB payloads kept. `runner` times the
// whole production upgrade, runMigrations: the pre-migration VACUUM INTO snapshot, then 0031 in its own write
// transaction. `alter` times the two parts on the same database: that snapshot (VACUUM INTO, the runner's
// statement), then 0031's own statements from the production catalog, in one transaction, as the runner runs
// them. `backfill` is the control: the rejected draft that writes each existing send's names from its template
// and step, in one transaction, with no snapshot. Serial, opt-in, not a CI threshold. Results are stored in
// docs/perf/B117d-send-names.md.
// Usage: bun test/sends/measure-migration.ts [sends] [runner|alter|backfill]
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";

const [sendsArg, modeArg] = process.argv.slice(2);
const sends = Number(sendsArg ?? 1_000_000);
const mode = modeArg ?? "runner";
if (!["runner", "alter", "backfill"].includes(mode)) {
  throw new Error(`unknown mode ${mode}`);
}
const clock = createRealClock();
const root = mkdtempSync(join(tmpdir(), "iglo-send-names-migration-"));

const megabytes = (bytes: number) => Math.round(bytes / 1e6);
const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0);
const ms = (start: number) => Math.round(performance.now() - start);

// The rejected backfill, as the first draft of 0031 wrote it.
const backfill = `
ALTER TABLE sends ADD COLUMN template_name TEXT;
ALTER TABLE sends ADD COLUMN sequence_name TEXT;
UPDATE sends SET template_name = (SELECT t.name FROM templates t WHERE t.id = sends.template_id)
  WHERE template_id IS NOT NULL;
UPDATE sends SET sequence_name = (
  SELECT q.name FROM sequence_steps st JOIN sequences q ON q.id = st.sequence_id WHERE st.id = sends.step_id
) WHERE step_id IS NOT NULL;
`;

const dataDir = join(root, "data");
const path = join(dataDir, "iglo-email.db");
const db: Database = openDatabase(dataDir);
try {
  // Schema 30: the production migrations before this change.
  runMigrations(
    db,
    dataDir,
    clock,
    productionMigrations.filter((migration) => migration.version < 31),
  );
  db.transaction(() => {
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
       INSERT INTO templates (name, type, subject, body) SELECT 'Template ' || i, 'tx', 'Subject', '<p>x</p>' FROM n`,
    );
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5)
       INSERT INTO sequences (uuid, name, trigger) SELECT 'sequence-' || i, 'Sequence ' || i, '{"event":"measured"}' FROM n`,
    );
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
       INSERT INTO sequence_steps (uuid, sequence_id, position, wait, kind)
       SELECT 'step-' || i, ((i - 1) % 5) + 1, (i - 1) / 5, 'PT0S', 'transactional' FROM n`,
    );
    // Half the sends name a template and a step; every payload is kept (2 KB of HTML).
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO sends (uuid, source, kind, to_email, template_id, step_id, status, smtp_message_id, created_at, sent_at, payload)
       SELECT 'seed-' || i, 'tx', 'transactional', 'seed' || i || '@example.test', (i % 20) + 1,
         CASE WHEN i % 2 = 1 THEN (i % 50) + 1 ELSE NULL END, 'sent', '<seed-' || i || '@measure.test>',
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || (i % 300) || ' days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || (i % 300) || ' days'),
         json_object('message', json_object('subject', 'Subject ' || i, 'html', replace(printf('%2000s', ''), ' ', 'x')))
       FROM n`,
      [sends],
    );
  })();
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const before = { db: sizeOf(path), wal: sizeOf(`${path}-wal`) };

  const result: Record<string, unknown> = { sends, mode, before: { dbMB: megabytes(before.db) } };
  if (mode === "runner") {
    const start = performance.now();
    runMigrations(db, dataDir, clock, productionMigrations);
    result.totalMs = ms(start);
  } else if (mode === "alter") {
    const snapshotStart = performance.now();
    db.run("VACUUM INTO ?", [join(root, "snapshot.db")]);
    result.snapshotMs = ms(snapshotStart);
    const migration = productionMigrations.find((entry) => entry.version === 31);
    if (!migration) {
      throw new Error("no migration 31 in the production catalog");
    }
    const start = performance.now();
    db.transaction(() => {
      db.run(migration.sql);
      db.run("PRAGMA user_version = 31");
    })();
    result.alterMs = ms(start);
  } else {
    const start = performance.now();
    db.transaction(() => db.run(backfill))();
    result.backfillMs = ms(start);
  }
  const named = db
    .query<{ template: number; sequence: number; version: number }, []>(
      `SELECT count(template_name) AS template, count(sequence_name) AS sequence,
         (SELECT user_version FROM pragma_user_version) AS version FROM sends`,
    )
    .get()!;
  result.after = {
    dbMB: megabytes(sizeOf(path)),
    walMB: megabytes(sizeOf(`${path}-wal`)),
    walMBBefore: megabytes(before.wal),
    namedTemplates: Number(named.template),
    namedSequences: Number(named.sequence),
    userVersion: Number(named.version),
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.close(true);
  rmSync(root, { recursive: true, force: true });
}
