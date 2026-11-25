// B125 (D122): the private-target default. A new install refuses private webhook targets; a value
// the store already holds, false included, is kept when the store is opened again (a restart).
// B139 (D154): the key is an instance key, so this runs on the instance settings store over a real
// instance.db file, on the injected clock.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstanceDatabase } from "@/projects/instance";
import { createInstanceSettings } from "@/settings/instance";
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
  const clock = new TestClock();
  const db = openInstanceDatabase(directory, clock);
  const reopen = () => createInstanceSettings(db, clock);
  return { db, reopen };
}

test("a new install refuses private webhook targets by default", () => {
  const { reopen } = open();
  expect(reopen().read()[key]).toBe(true);
});

test("a stored false stays false when the store is opened again", () => {
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
