// B32 (D88): the settings read cache never serves a stale value, whoever writes the table.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createListReferences } from "@/lists/references";
import { createRoles } from "@/roles/roles";
import { placeRestoreHold, sendingHeld } from "@/settings/hold";
import { writeStoredValue } from "@/settings/stored";
import { createSettings } from "@/settings/store";
import { TestClock } from "@/test/server/fixture";

const directories: string[] = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function open() {
  const directory = mkdtempSync(join(tmpdir(), "b32-"));
  directories.push(directory);
  const db = openDatabase(directory);
  const clock = new TestClock();
  runMigrations(db, directory, clock, productionMigrations);
  const roles = createRoles(db, createListReferences(db));
  const settings = createSettings(db, clock, "https://example.test", roles);
  return { directory, db, settings };
}

test("reads see writes by update, the stored-value writer and another connection", () => {
  const { directory, db, settings } = open();
  expect(settings.read()["app.site_name"]).toBe(settings.read()["app.site_name"]);
  settings.update((current) => ({ ...current, "app.site_name": "one" }));
  expect(settings.read()["app.site_name"]).toBe("one");
  writeStoredValue(db, "app.site_name", "two");
  expect(settings.read()["app.site_name"]).toBe("two");
  const other = openDatabase(directory);
  writeStoredValue(other, "app.site_name", "three");
  other.close();
  expect(settings.read()["app.site_name"]).toBe("three");
});

test("the shared value cannot be mutated and the restore hold does not read through it", () => {
  const { db, settings } = open();
  const first = settings.read();
  expect(() => {
    (first as any)["app.site_name"] = "mutated";
  }).toThrow();
  expect(settings.read()["app.site_name"]).not.toBe("mutated");
  expect(sendingHeld(db)).toBe(false);
  placeRestoreHold(db, "2026-01-01T00:00:00.000Z");
  expect(sendingHeld(db)).toBe(true);
  expect(settings.read()["app.site_name"]).toBe(first["app.site_name"]);
});
