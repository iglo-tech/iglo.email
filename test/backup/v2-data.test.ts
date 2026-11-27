// B164 (D192, 14-projects sections 12 and 15 "CLI"): the backup CLI on a data directory and a whole
// backup written by v2.0.0, before instance migration 4 (`several_projects`, D165) and production
// migrations 36 to 38. `backup` of the stopped directory, `--verify` of its backup and
// `--release-hold` on the restored directory each read the registry of an older instance.db, on the
// compiled executable; and an instance.db with no schema is refused by name.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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

// What v2.0.0 shipped: instance migrations 1 to 3 and production migrations 1 to 35.
const V2_INSTANCE = 3;
const V2_PROJECT = 35;

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

/** A stopped data directory as v2.0.0 left it: the primary `main` and a second project `b`. */
function v2DataDir(dataDir: string): void {
  const clock = createRealClock();
  const instance = openDatabase(dataDir, "instance.db");
  try {
    runMigrations(instance, dataDir, clock, instanceMigrations.slice(0, V2_INSTANCE));
    for (const [slug, host, primary] of [
      ["main", "127.0.0.1", 1],
      ["b", "b.example.test", 0],
    ] as const) {
      instance.run(
        "INSERT INTO projects (slug, name, created_at, is_primary) VALUES (?, ?, ?, ?)",
        [slug, slug, clock.now().toISOString(), primary],
      );
      instance.run("INSERT INTO hostnames (hostname, project, kind) VALUES (?, ?, 'main')", [
        host,
        slug,
      ]);
    }
  } finally {
    instance.close();
  }
  for (const slug of ["main", "b"]) {
    const directory = join(dataDir, "projects", slug);
    mkdirSync(join(directory, "uploads"), { recursive: true });
    const db = openDatabase(directory);
    try {
      runMigrations(db, directory, clock, productionMigrations.slice(0, V2_PROJECT));
    } finally {
      db.close();
    }
  }
}

test("backup, --verify and --release-hold work on a v2.0.0 data directory and its backup", async () => {
  base = temporaryDirectory();
  const dataDir = join(base, "data");
  v2DataDir(dataDir);

  const output = join(base, "backup");
  const backup = await runBackup(executable, ["--data-dir", dataDir, "--output", output]);
  expect(backup.exitCode, backup.stderr).toBe(0);
  expect(backup.stdout).toContain(`instance.db\n  Schema version: ${V2_INSTANCE}\n`);
  expect(backup.stdout).toContain(`projects/main\n  Schema version: ${V2_PROJECT}\n`);

  const verified = await runBackup(executable, ["--verify", output]);
  expect(verified.exitCode, verified.stderr).toBe(0);
  expect(verified.stdout).toContain(
    `Integrity: ok; the server migrates this backup to version ` +
      `${instanceMigrations.length} (instance.db), ` +
      `${productionMigrations.length} (projects/b), ` +
      `${productionMigrations.length} (projects/main)\n`,
  );

  // Restored as the operations guide says: the backup's databases become the data directory.
  const restored = join(base, "restored");
  mkdirSync(restored);
  cpSync(join(output, "instance.db"), join(restored, "instance.db"));
  cpSync(join(output, "projects"), join(restored, "projects"), { recursive: true });
  const release = (...args: Array<string>) =>
    runBackup(executable, [
      "--release-hold",
      "--consent-reconciled",
      "--data-dir",
      restored,
      ...args,
    ]);
  const instance = await release();
  expect(instance.exitCode, instance.stderr).toBe(3);
  expect(instance.stdout).toMatch(/^Hold released on instance.db at \S+\n/);
  expect(instance.stdout).toContain("Still held: project b, project main");
  expect((await release("--project", "b")).exitCode).toBe(3);
  const last = await release("--project", "main");
  expect(last.exitCode, last.stderr).toBe(0);
  expect(last.stdout).toContain("Nothing is held; sending starts with the server");
  // Nothing was migrated: the server does that when it starts.
  const db = new Database(join(restored, "instance.db"), { readonly: true });
  try {
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(
      V2_INSTANCE,
    );
  } finally {
    db.close();
  }
});

test("--verify refuses a whole backup whose instance.db has no schema, by name", async () => {
  base = temporaryDirectory();
  const output = join(base, "backup");
  mkdirSync(output);
  new Database(join(output, "instance.db"), { create: true }).close();
  writeFileSync(join(output, "iglo-email-backup.json"), `${JSON.stringify({ projects: [] })}\n`);

  const verified = await runBackup(executable, ["--verify", output]);
  expect(verified.exitCode).toBe(1);
  expect(verified.stderr).toContain(`${join(output, "instance.db")} has no schema: not a backup`);
  expect(verified.stderr).not.toContain("no such table");
  expect(readdirSync(output).sort()).toEqual(["iglo-email-backup.json", "instance.db"]);
});
