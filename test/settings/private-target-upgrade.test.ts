// B125 (D122, lead decisions): the upgrade turns a stored false on, once. Through the migrations and
// the settings store on a real SQLite file, reopened as a restart does, on the injected clock.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createListReferences } from "@/lists/references";
import { createRoles } from "@/roles/roles";
import { createSettings } from "@/settings/store";
import { migrationTurnsOn } from "@/webhooks/upgrade";
import { TestClock } from "@/test/server/fixture";

const key = "webhooks.block_private_addresses";
const directories: string[] = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

/** One data directory; `connect` opens it again, as a restart does. */
function directory() {
  const path = mkdtempSync(join(tmpdir(), "b125-upgrade-"));
  directories.push(path);
  const clock = new TestClock();
  const connect = () => {
    const db = openDatabase(path);
    const reopen = () =>
      createSettings(db, clock, "https://example.test", createRoles(db, createListReferences(db)));
    return { db, reopen };
  };
  return { path, clock, connect };
}

/** A database as an earlier release left it: schema 23, every default seeded, this key false. */
function earlierRelease() {
  const { path, clock, connect } = directory();
  const first = connect();
  runMigrations(first.db, path, clock, productionMigrations.slice(0, 23));
  first.reopen();
  first.db.run("UPDATE settings SET value = 'false' WHERE key = ?", [key]);
  return { path, clock, connect, db: first.db };
}

test("an upgrade from an earlier release turns a stored false on, once", () => {
  const { path, clock, connect, db } = earlierRelease();
  expect(migrationTurnsOn(db)).toBe(true);
  runMigrations(db, path, clock, productionMigrations);
  expect(migrationTurnsOn(db)).toBe(false);
  const again = connect();
  expect(again.reopen().read()[key]).toBe(true);
});

test("a later operator's false survives a restart, and the migration does not run again", () => {
  const { path, clock, connect, db } = earlierRelease();
  runMigrations(db, path, clock, productionMigrations);
  db.close();
  const after = connect();
  after.reopen().update((current) => ({ ...current, [key]: false }));
  after.db.close();
  // A restart: the migrations find schema 24 and change nothing.
  const restarted = connect();
  runMigrations(restarted.db, path, clock, productionMigrations);
  expect(restarted.reopen().read()[key]).toBe(false);
});

test("an earlier release's stored true is not an upgrade change", () => {
  const { path, clock, connect, db } = earlierRelease();
  db.run("UPDATE settings SET value = 'true' WHERE key = ?", [key]);
  expect(migrationTurnsOn(db)).toBe(false);
  runMigrations(db, path, clock, productionMigrations);
  expect(connect().reopen().read()[key]).toBe(true);
});

test("a fresh install has no upgrade to notice and stores true", () => {
  const { path, clock, connect } = directory();
  const first = connect();
  expect(migrationTurnsOn(first.db)).toBe(false);
  runMigrations(first.db, path, clock, productionMigrations);
  expect(first.reopen().read()[key]).toBe(true);
});
