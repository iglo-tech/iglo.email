// B125 (D122) turned a stored false on once, in the install's one settings table. B139 (D154):
// `webhooks.block_private_addresses` is an instance key, so a project database holds no copy of it:
// migration 33 removes it with every other instance key, whatever an earlier schema stored, and the
// project's settings read the instance's value. Through the migrations and the stores on real SQLite
// files, reopened as a restart does, on the injected clock.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { defaults } from "@/settings/defaults";
import { instanceKeys } from "@/settings/keys";
import { createSettings } from "@/settings/store";
import { createTestInstanceSettings } from "@/test/settings/instance-fixture";
import { TestClock } from "@/test/server/fixture";
import { asBody } from "@/test/read-body";

const key = "webhooks.block_private_addresses";
const directories: Array<string> = [];
afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

/** A database as an earlier release left it: schema 23, every default seeded, this key false. */
function earlierRelease() {
  const path = mkdtempSync(join(tmpdir(), "b139-upgrade-"));
  directories.push(path);
  const clock = new TestClock();
  const db = openDatabase(path);
  runMigrations(db, path, clock, productionMigrations.slice(0, 23));
  for (const [name, value] of Object.entries(defaults)) {
    // Keys added after migration 33 (B150a's source keys) were never in an earlier release.
    if (name.startsWith("source.") || name.startsWith("sources.")) {
      continue;
    }
    db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", [
      name,
      JSON.stringify(value),
    ]);
  }
  db.run("UPDATE settings SET value = 'false' WHERE key = ?", [key]);
  return { path, clock, db };
}

const storedKeys = (db: ReturnType<typeof openDatabase>) =>
  asBody<Array<{ key: string }>>(db.query("SELECT key FROM settings").all()).map((row) => row.key);

test("the migrations leave a project database no instance key, and restore.hold stays", () => {
  const { path, clock, db } = earlierRelease();
  db.run(`INSERT INTO settings (key, value) VALUES ('restore.hold', '{"since":"2026-01-01"}')`);
  expect(storedKeys(db).filter((name) => instanceKeys.has(name)).length).toBeGreaterThan(0);
  runMigrations(db, path, clock, productionMigrations);
  expect(storedKeys(db).filter((name) => instanceKeys.has(name))).toEqual([]);
  expect(storedKeys(db)).toContain("restore.hold");
  expect(storedKeys(db)).toContain("app.site_name");
});

test("a project reads the instance's value, not the one an earlier schema stored", () => {
  const { path, clock, db } = earlierRelease();
  runMigrations(db, path, clock, productionMigrations);
  const instance = createTestInstanceSettings(clock);
  const project = createSettings(db, clock, "https://example.test", instance.reader);
  expect(project.read()[key]).toBe(true);
  // Opening the project store again seeds project keys only.
  createSettings(db, clock, "https://example.test", instance.reader);
  expect(storedKeys(db).filter((name) => instanceKeys.has(name))).toEqual([]);
  instance.update((current) => ({ ...current, [key]: false }));
  expect(project.read()[key]).toBe(false);
});
