// Opt-in disk-backed initialization and subscriber FTS cost; no production data.
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { writeTransaction } from "@/db/transaction";

const base = resolve(
  process.env.IGLO_EMAIL_PERF_DIR ?? join(import.meta.dir, "../../upstream/measurements"),
);
mkdirSync(base, { recursive: true });
const resolvedBase = realpathSync(base);
const filesystemType = Number(statfsSync(resolvedBase).type);
if ([0x01021994, 0x858458f6].includes(filesystemType))
  throw new Error("Storage evidence requires a disk-backed directory, not tmpfs or ramfs");
const root = mkdtempSync(join(resolvedBase, "iglo-schema-measure-"));
const clock = createRealClock();
const timestamp = clock.now().toISOString();
const rows = 2000;
const batch = 100;
function scalar(db: Database, sql: string): unknown {
  return Object.values(db.query<Record<string, unknown>, []>(sql).get() ?? {})[0];
}
function sizes(directory: string) {
  const path = join(directory, "iglo-email.db");
  return {
    dbBytes: statSync(path).size,
    walBytes: existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0,
  };
}
function integrity(db: Database) {
  assert.equal(scalar(db, "PRAGMA integrity_check"), "ok");
  assert.deepEqual(db.query("PRAGMA foreign_key_check").all(), []);
}
function initialize(mode: "empty" | "v1", repetition: number) {
  const directory = join(root, `init-${mode}-${repetition}`);
  const start = performance.now();
  let db = openDatabase(directory);
  const opened = performance.now();
  const catalog = mode === "v1" ? productionMigrations : [];
  runMigrations(db, directory, clock, catalog);
  const migrated = performance.now();
  integrity(db);
  assert.equal(scalar(db, "PRAGMA user_version"), mode === "v1" ? 3n : 0n);
  const tableCount = scalar(
    db,
    "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  );
  const validated = performance.now();
  const beforeCheckpoint = sizes(directory);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close(true);
  db = openDatabase(directory);
  integrity(db);
  const reopened = performance.now();
  const afterReopen = sizes(directory);
  runMigrations(db, directory, clock, catalog);
  const restarted = performance.now();
  assert.equal(existsSync(join(directory, "backups")), false);
  db.close(true);
  return {
    kind: "initialization",
    mode,
    repetition,
    tableCount: String(tableCount),
    openMs: opened - start,
    migrationMs: migrated - opened,
    validationMs: validated - migrated,
    checkpointReopenMs: reopened - validated,
    restartMs: restarted - reopened,
    beforeCheckpoint,
    afterReopen,
  };
}
function ftsCount(db: Database, term: string): bigint {
  return db
    .query<{ count: bigint }, [string]>(
      "SELECT count(*) AS count FROM subscribers_fts WHERE subscribers_fts MATCH ?",
    )
    .get(term)!.count;
}
function searchCheck(db: Database, enabled: boolean, seed: bigint, changed: bigint) {
  assert.equal(ftsCount(db, "seedtoken"), enabled ? seed : 0n);
  assert.equal(ftsCount(db, "changedtoken"), enabled ? changed : 0n);
  assert.equal(ftsCount(db, "rollbacktoken"), 0n);
}
function ftsWorkload(enabled: boolean, repetition: number) {
  const directory = join(root, `fts-${enabled ? "enabled" : "disabled"}-${repetition}`);
  let db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  if (!enabled)
    db.run(
      "DROP TRIGGER subscribers_fts_insert; DROP TRIGGER subscribers_fts_update; DROP TRIGGER subscribers_fts_delete",
    );
  integrity(db);
  searchCheck(db, enabled, 0n, 0n);
  const insert = db.prepare(
    "INSERT INTO subscribers(id,uuid,email,name,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  );
  const update = db.prepare("UPDATE subscribers SET name=?,email=?,updated_at=? WHERE id=?");
  const remove = db.prepare("DELETE FROM subscribers WHERE id=?");
  const started = performance.now();
  for (let first = 1; first <= rows; first += batch) {
    writeTransaction(db, () => {
      for (let id = first; id < first + batch; id++)
        insert.run(id, `sub-${id}`, `user${id}@example.test`, "seedtoken", timestamp, timestamp);
    });
  }
  const inserted = performance.now();
  searchCheck(db, enabled, 2000n, 0n);
  const updateStarted = performance.now();
  for (let first = 1; first <= 500; first += batch) {
    writeTransaction(db, () => {
      for (let id = first; id < first + batch; id++)
        update.run("changedtoken", `changed${id}@example.test`, timestamp, id);
    });
  }
  const updated = performance.now();
  searchCheck(db, enabled, 1500n, 500n);
  const deleteStarted = performance.now();
  for (let first = 1; first <= 250; first += batch) {
    writeTransaction(db, () => {
      for (let id = first; id < Math.min(first + batch, 251); id++) remove.run(id);
    });
  }
  const deleted = performance.now();
  const rollbackStarted = performance.now();
  try {
    writeTransaction(db, () => {
      for (let id = 251; id <= 350; id++)
        update.run("rollbacktoken", `rollback${id}@example.test`, timestamp, id);
      throw new Error("expected rollback");
    });
    throw new Error("rollback unexpectedly committed");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "expected rollback") throw error;
  }
  const rolledBack = performance.now();
  assert.equal(scalar(db, "SELECT count(*) FROM subscribers"), 1750n);
  searchCheck(db, enabled, 1500n, 250n);
  integrity(db);
  if (enabled)
    db.run("INSERT INTO subscribers_fts(subscribers_fts, rank) VALUES ('integrity-check', 1)");
  const validated = performance.now();
  const beforeCheckpoint = sizes(directory);
  insert.finalize();
  update.finalize();
  remove.finalize();
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close(true);
  db = openDatabase(directory);
  integrity(db);
  searchCheck(db, enabled, 1500n, 250n);
  if (enabled)
    db.run("INSERT INTO subscribers_fts(subscribers_fts, rank) VALUES ('integrity-check', 1)");
  const reopened = performance.now();
  const afterReopen = sizes(directory);
  db.close(true);
  return {
    kind: "fts",
    enabled,
    repetition,
    rows,
    batch,
    updates: 500,
    deletes: 250,
    rolledBackUpdates: 100,
    survivors: 1750,
    insertMs: inserted - started,
    updateMs: updated - updateStarted,
    deleteMs: deleted - deleteStarted,
    rollbackMs: rolledBack - rollbackStarted,
    validationMs: validated - rolledBack,
    checkpointReopenMs: reopened - validated,
    beforeCheckpoint,
    afterReopen,
    search: enabled ? "index matches content" : "triggers disabled; index intentionally empty",
  };
}
try {
  const db = openDatabase(join(root, "environment"));
  const sqlite = scalar(db, "SELECT sqlite_version()");
  db.close(true);
  console.log(
    JSON.stringify({
      kind: "environment",
      directory: resolvedBase,
      filesystemType: `0x${filesystemType.toString(16)}`,
      platform: platform(),
      release: release(),
      arch: arch(),
      cpus: cpus().length,
      cpu: cpus()[0]?.model,
      memoryBytes: totalmem(),
      bun: Bun.version,
      sqlite,
      timestamp,
    }),
  );
  for (let repetition = 1; repetition <= 3; repetition++) {
    console.log(JSON.stringify(initialize("empty", repetition)));
    console.log(JSON.stringify(initialize("v1", repetition)));
    for (const enabled of repetition % 2 ? [false, true] : [true, false])
      console.log(JSON.stringify(ftsWorkload(enabled, repetition)));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
