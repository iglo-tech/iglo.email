// B125 (D122): the private-target default. A new install refuses private webhook targets; a value
// the store already holds, false included, is kept when the store is opened again (an upgrade or a
// restart). Through the settings store on a real SQLite file, on the injected clock.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createListReferences } from "@/lists/references";
import { createRoles } from "@/roles/roles";
import { createSettings } from "@/settings/store";
import { TestClock } from "@/test/server/fixture";

const directories: Array<string> = [];
afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

const key = "webhooks.block_private_addresses";

function open() {
  const directory = mkdtempSync(join(tmpdir(), "b125-"));
  directories.push(directory);
  const db = openDatabase(directory);
  const clock = new TestClock();
  runMigrations(db, directory, clock, productionMigrations);
  const reopen = () => {
    const roles = createRoles(db, createListReferences(db));
    return createSettings(db, clock, "https://example.test", roles);
  };
  return { db, reopen };
}

test("a new install refuses private webhook targets by default", () => {
  const { reopen } = open();
  expect(reopen().read()[key]).toBe(true);
});

test("a stored false stays false when the store is opened again (the upgrade itself is in private-target-upgrade.test.ts)", () => {
  const { reopen } = open();
  // An install that had turned the blocking off keeps that choice.
  reopen().update((current) => ({ ...current, [key]: false }));
  expect(reopen().read()[key]).toBe(false);
});

test("an operator's true survives a restart", () => {
  const { reopen } = open();
  reopen().update((current) => ({ ...current, [key]: true }));
  expect(reopen().read()[key]).toBe(true);
});
