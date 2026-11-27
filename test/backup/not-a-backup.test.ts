// B165 (D193, 14-projects section 12 "CLI"): `backup --verify` refuses, by name and with a non-zero
// exit, what is not a backup: a database with no schema or a negative schema version (bare, as a
// project's backup or in a whole backup), a whole backup whose project is a file, and a database at a version that has the
// settings table but lacks it. A valid backup still verifies. On the compiled executable.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { instanceMigrations, productionMigrations, runMigrations } from "@/db/migrations";
import {
  buildExecutable,
  removeDirectory,
  runBackup,
  temporaryDirectory,
} from "@/test/backup/fixture";

setDefaultTimeout(60_000);

const DATABASE = "iglo-email.db";

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

/** A stopped data directory at this executable's schemas, with the primary project `main`. */
function dataDir(path: string): void {
  const clock = createRealClock();
  const instance = openDatabase(path, "instance.db");
  try {
    runMigrations(instance, path, clock, instanceMigrations);
    instance.run(
      "INSERT INTO projects (slug, name, created_at, is_primary) VALUES ('main', 'main', ?, 1)",
      [clock.now().toISOString()],
    );
    instance.run(
      "INSERT INTO hostnames (hostname, project, kind) VALUES ('127.0.0.1', 'main', 'main')",
    );
  } finally {
    instance.close();
  }
  const directory = join(path, "projects", "main");
  mkdirSync(join(directory, "uploads"), { recursive: true });
  const db = openDatabase(directory);
  try {
    runMigrations(db, directory, clock, productionMigrations);
  } finally {
    db.close();
  }
}

/** A whole backup and a backup of `main`, written by the executable. */
async function backups(): Promise<{ whole: string; project: string }> {
  base = temporaryDirectory();
  const data = join(base, "data");
  dataDir(data);
  const whole = join(base, "whole");
  const project = join(base, "project");
  for (const [output, args] of [
    [whole, []],
    [project, ["--project", "main"]],
  ] as const) {
    const made = await runBackup(executable, ["--data-dir", data, "--output", output, ...args]);
    expect(made.exitCode, made.stderr).toBe(0);
  }
  return { whole, project };
}

/** Replaces a database with an empty one, at the given version and with no table. */
function replaceDatabase(path: string, version = 0): void {
  rmSync(path);
  const db = new Database(path, { create: true });
  try {
    db.run(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

async function refused(path: string, message: string): Promise<void> {
  const verified = await runBackup(executable, ["--verify", path]);
  expect(verified.exitCode, verified.stdout).toBe(1);
  expect(verified.stderr).toContain(message);
  expect(verified.stderr).not.toContain("no such table");
  expect(verified.stdout).not.toContain("Integrity: ok");
}

test("a valid whole backup and a project's backup still verify", async () => {
  const { whole, project } = await backups();
  for (const path of [whole, project, join(project, DATABASE)]) {
    const verified = await runBackup(executable, ["--verify", path]);
    expect(verified.exitCode, verified.stderr).toBe(0);
    expect(verified.stdout).toContain("Integrity: ok\n");
  }
});

test("--verify refuses a database with no schema, bare, as a project's backup or in a whole backup", async () => {
  const { whole, project } = await backups();
  const bare = join(base, "bare.db");
  new Database(bare, { create: true }).close();
  await refused(bare, `${bare} has no schema: not a backup`);

  const projectDatabase = join(project, DATABASE);
  replaceDatabase(projectDatabase);
  await refused(project, `${projectDatabase} has no schema: not a backup`);

  const wholeProject = join(whole, "projects", "main", DATABASE);
  replaceDatabase(wholeProject);
  await refused(whole, `${wholeProject} has no schema: not a backup`);
});

test("--verify refuses a database at a negative schema version, bare, as a project's backup or in a whole backup", async () => {
  const { whole, project } = await backups();
  const bare = join(base, "bare.db");
  new Database(bare, { create: true }).close();
  replaceDatabase(bare, -1);
  await refused(bare, `${bare} has invalid schema version -1: not a backup`);

  const projectDatabase = join(project, DATABASE);
  replaceDatabase(projectDatabase, -1);
  await refused(project, `${projectDatabase} has invalid schema version -1: not a backup`);

  // The project's database first: instance.db is read before it.
  const wholeProject = join(whole, "projects", "main", DATABASE);
  replaceDatabase(wholeProject, -2_147_483_648);
  await refused(whole, `${wholeProject} has invalid schema version -2147483648: not a backup`);

  const instance = join(whole, "instance.db");
  replaceDatabase(instance, -1);
  await refused(whole, `${instance} has invalid schema version -1: not a backup`);
});

test("--verify refuses a whole backup whose project is a file, not a directory", async () => {
  const { whole } = await backups();
  const directory = join(whole, "projects", "main");
  const moved = join(base, "main");
  renameSync(directory, moved);
  copyFileSync(join(moved, DATABASE), directory);
  await refused(whole, `${directory} is not a directory: not a backup`);
});

test("--verify refuses a database without its settings table at a version that has one", async () => {
  const { whole, project } = await backups();
  const bare = join(base, "bare.db");
  new Database(bare, { create: true }).close();
  replaceDatabase(bare, 5);
  await refused(bare, `${bare} has no settings table at schema version 5: not a backup`);

  const projectDatabase = join(project, DATABASE);
  replaceDatabase(projectDatabase, productionMigrations.length);
  await refused(
    project,
    `${projectDatabase} has no settings table at schema version ${productionMigrations.length}: not a backup`,
  );

  const instance = join(whole, "instance.db");
  replaceDatabase(instance, instanceMigrations.length);
  await refused(
    whole,
    `${instance} has no settings table at schema version ${instanceMigrations.length}: not a backup`,
  );
});
