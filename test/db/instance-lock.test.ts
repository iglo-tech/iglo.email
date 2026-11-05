// The instance lock through the stopped-database work and its start retry (D69), with real
// SQLite locks. A holder in another process is the lock's real contender; the retry is tested by
// releasing the holder from inside the wait between attempts, so no clock decides the result.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, withStoppedDatabase } from "@/db/connection";
import { holdDataDirectory } from "@/db/instance-lock";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function dataDir() {
  const base = mkdtempSync(join(tmpdir(), "iglo-instance-lock-"));
  directories.push(base);
  return join(base, "data");
}
/** A directory with a database that has a schema version, as a server leaves it. */
function stopped() {
  const dir = dataDir();
  const db = openDatabase(dir);
  db.run("PRAGMA user_version = 1");
  db.close(true);
  return dir;
}
const probe = resolve(import.meta.dir, "lock-probe.ts");
function otherProcess(dir: string) {
  const result = Bun.spawnSync([process.execPath, probe, dir], {
    env: { PATH: "" },
    cwd: resolve(import.meta.dir, "../.."),
  });
  return { exitCode: result.exitCode, output: result.stdout.toString() };
}

test("the lock is held for the whole of the stopped work and free afterwards", () => {
  const dir = stopped();
  expect(otherProcess(dir)).toEqual({ exitCode: 0, output: "held\n" });
  let during: ReturnType<typeof otherProcess> | undefined;
  const value = withStoppedDatabase(dir, 1, () => {
    during = otherProcess(dir);
    return "done";
  });
  expect(value).toBe("done");
  expect(during?.exitCode).toBe(1);
  expect(during?.output).toContain("is in use by another iglo.email process: stop it first");
  expect(otherProcess(dir)).toEqual({ exitCode: 0, output: "held\n" });
});

test("the lock is also released when the work throws", () => {
  const dir = stopped();
  expect(() =>
    withStoppedDatabase(dir, 1, () => {
      throw new Error("work failed");
    }),
  ).toThrow("work failed");
  expect(otherProcess(dir).exitCode).toBe(0);
});

test("a server holding the lock refuses the stopped work before it opens the database", () => {
  const dir = stopped();
  const server = holdDataDirectory(dir);
  try {
    let ran = false;
    expect(() =>
      withStoppedDatabase(dir, 1, () => {
        ran = true;
      }),
    ).toThrow("is in use by another iglo.email process: stop it first");
    expect(ran).toBe(false);
  } finally {
    server.release();
  }
});

test("a database that something else has open is refused with 'stop what has it open first', and the lock is let go", () => {
  const dir = stopped();
  const other = new Database(join(dir, "iglo-email.db"), { readwrite: true });
  other.run("BEGIN IMMEDIATE");
  try {
    let ran = false;
    expect(() =>
      withStoppedDatabase(dir, 1, () => {
        ran = true;
      }),
    ).toThrow("is in use: stop what has it open first");
    expect(ran).toBe(false);
    expect(otherProcess(dir).exitCode).toBe(0);
  } finally {
    other.run("ROLLBACK");
    other.close(true);
  }
  expect(withStoppedDatabase(dir, 1, () => "free")).toBe("free");
});

test("a contender that finds the lock busy only for a moment gets it on the retry", () => {
  const dir = dataDir();
  const holder = holdDataDirectory(dir);
  const waits: number[] = [];
  const taken = holdDataDirectory(dir, (milliseconds) => {
    waits.push(milliseconds);
    holder.release();
  });
  try {
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(1);
  } finally {
    taken.release();
  }
});

test("a holder that never lets go is refused after a bounded number of waits", () => {
  const dir = dataDir();
  const holder = holdDataDirectory(dir);
  const waits: number[] = [];
  try {
    expect(() => holdDataDirectory(dir, (milliseconds) => waits.push(milliseconds))).toThrow(
      "is in use by another iglo.email process: stop it first",
    );
    expect(waits).toHaveLength(4);
  } finally {
    holder.release();
  }
});
