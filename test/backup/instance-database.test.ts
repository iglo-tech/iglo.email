// B167 (D195, 14-projects section 12 "CLI"): `backup --verify` reads a bare instance.db, such as a
// pre-migration snapshot `backups/pre-migration/instance-…`, as instance.db: told by its schema,
// checked against the instance schema version and printed with the instance wording and no uploads
// line. A whole backup whose instance.db lacks its projects table is refused by name. On the
// compiled executable.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { instanceMigrations, productionMigrations, runMigrations } from "@/db/migrations";
import { openInstanceDatabase } from "@/projects/instance";
import {
  buildExecutable,
  removeDirectory,
  runBackup,
  temporaryDirectory,
} from "@/test/backup/fixture";

setDefaultTimeout(60_000);

const INSTANCE_HOLD = "a restored instance sends nothing in any project until released";
const PROJECT_HOLD = "a restored server sends nothing until released";

let build = "";
let executable = "";
let base = "";

beforeAll(async () => {
  build = temporaryDirectory();
  executable = await buildExecutable(build);
}, 120_000);
afterAll(() => removeDirectory(build));
afterEach(() => {
  if (base) {
    removeDirectory(base);
  }
  base = "";
});

/** instance.db in `dataDir`, migrated to `version` of the instance schema. */
function instanceAt(dataDir: string, version: number): string {
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(dataDir, "instance.db");
  try {
    runMigrations(db, dataDir, createRealClock(), instanceMigrations.slice(0, version));
  } finally {
    db.close();
  }
  return join(dataDir, "instance.db");
}

/** A whole backup, written by the executable, of a stopped data directory with project `main`. */
async function wholeBackup(): Promise<string> {
  const clock = createRealClock();
  const data = join(base, "data");
  const instance = openDatabase(data, "instance.db");
  try {
    runMigrations(instance, data, clock, instanceMigrations);
    instance.run(
      "INSERT INTO projects (slug, name, created_at, is_primary) VALUES ('main', 'main', ?, 1)",
      [clock.now().toISOString()],
    );
  } finally {
    instance.close();
  }
  const directory = join(data, "projects", "main");
  mkdirSync(join(directory, "uploads"), { recursive: true });
  const db = openDatabase(directory);
  try {
    runMigrations(db, directory, clock, productionMigrations);
  } finally {
    db.close();
  }
  const whole = join(base, "whole");
  const made = await runBackup(executable, ["--data-dir", data, "--output", whole]);
  expect(made.exitCode, made.stderr).toBe(0);
  return whole;
}

function setVersion(path: string, version: number): void {
  const db = new Database(path);
  try {
    db.run(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

/** Replaces a database with an empty one, at the given version and with no table. */
function replaceDatabase(path: string, version: number): void {
  rmSync(path);
  const db = new Database(path, { create: true });
  try {
    db.run(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

test("this executable's instance schema is version 5, which the cases below are written for", () => {
  expect(instanceMigrations.length).toBe(5);
});

test("a pre-migration instance snapshot verifies as instance.db and migrates to the instance version", async () => {
  base = temporaryDirectory();
  const data = join(base, "data");
  instanceAt(data, 3);
  // A start of this executable migrates it from 3 to 5 and leaves the snapshot of version 3.
  openInstanceDatabase(data, createRealClock()).close();
  const folder = join(data, "backups", "pre-migration");
  const snapshots = readdirSync(folder).filter((name) => name.startsWith("instance-"));
  expect(snapshots).toHaveLength(1);
  const snapshot = join(folder, snapshots[0] ?? "");

  const verified = await runBackup(executable, ["--verify", snapshot]);
  expect(verified.exitCode, verified.stderr).toBe(0);
  expect(verified.stdout).toContain("Schema version: 3\n");
  expect(verified.stdout).not.toContain("Uploads:");
  expect(verified.stdout).toContain(INSTANCE_HOLD);
  expect(verified.stdout).not.toContain(PROJECT_HOLD);
  expect(verified.stdout).toContain(
    "Integrity: ok; the server migrates this backup to version 5\n",
  );
});

test("a current bare instance.db verifies with the instance wording and no uploads line", async () => {
  base = temporaryDirectory();
  const whole = await wholeBackup();
  const bare = join(base, "instance.db");
  copyFileSync(join(whole, "instance.db"), bare);

  const verified = await runBackup(executable, ["--verify", bare]);
  expect(verified.exitCode, verified.stderr).toBe(0);
  expect(verified.stdout).toContain("Schema version: 5\n");
  expect(verified.stdout).not.toContain("Uploads:");
  expect(verified.stdout).toContain(INSTANCE_HOLD);
  expect(verified.stdout).not.toContain(PROJECT_HOLD);
  expect(verified.stdout).toEndWith("Integrity: ok\n");
});

test("a bare instance.db ahead of this executable is refused as ahead", async () => {
  base = temporaryDirectory();
  const bare = instanceAt(join(base, "data"), 5);
  setVersion(bare, 6);

  const verified = await runBackup(executable, ["--verify", bare]);
  expect(verified.exitCode, verified.stdout).toBe(1);
  expect(verified.stderr).toContain(
    "Database version 6 is ahead of this executable, which supports 5: restore it with a newer one",
  );
  expect(verified.stdout).not.toContain("Integrity: ok");
});

test("a bare instance.db at version 1, before its settings table, verifies", async () => {
  base = temporaryDirectory();
  const bare = instanceAt(join(base, "data"), 1);

  const verified = await runBackup(executable, ["--verify", bare]);
  expect(verified.exitCode, verified.stderr).toBe(0);
  expect(verified.stdout).toContain("Schema version: 1\n");
  expect(verified.stdout).not.toContain("Uploads:");
  expect(verified.stdout).toContain(
    "Integrity: ok; the server migrates this backup to version 5\n",
  );
});

test("a bare project database still verifies as a project's", async () => {
  base = temporaryDirectory();
  const whole = await wholeBackup();
  const bare = join(whole, "projects", "main", "iglo-email.db");

  const verified = await runBackup(executable, ["--verify", bare]);
  expect(verified.exitCode, verified.stderr).toBe(0);
  expect(verified.stdout).toContain(`Schema version: ${productionMigrations.length}\n`);
  expect(verified.stdout).toContain("Uploads: 0 files, 0 bytes\n");
  expect(verified.stdout).toContain(PROJECT_HOLD);
  expect(verified.stdout).toEndWith("Integrity: ok\n");
});

test("a whole backup whose instance.db has no projects table is refused by name", async () => {
  base = temporaryDirectory();
  const whole = await wholeBackup();
  const instance = join(whole, "instance.db");
  for (const version of [1, 2]) {
    replaceDatabase(instance, version);
    const verified = await runBackup(executable, ["--verify", whole]);
    expect(verified.exitCode, verified.stdout).toBe(1);
    expect(verified.stderr).toContain(
      `${instance} has no projects table at schema version ${version}: not a backup`,
    );
    expect(verified.stderr).not.toContain("no such table");
    expect(verified.stdout).not.toContain("Integrity: ok");
  }
});
