// Connection responsibility adapted from listmonk's cmd/init.go: initDB.
import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { holdDataDirectory } from "@/db/instance-lock";
import { primaryProjectDirectory } from "@/projects/registry";

/**
 * Opens `file` in `directory` with the required pragmas: a project's `iglo-email.db` by default,
 * or the instance's `instance.db` (14-projects section 1: the same pragmas for both).
 */
export function openDatabase(directory: string, file = "iglo-email.db"): Database {
  mkdirSync(directory, { recursive: true });
  const db = new Database(join(directory, file), {
    create: true,
    strict: true,
    safeIntegers: true,
  });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const journal = db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL")
      .get()?.journal_mode;
    db.run("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
    const foreignKeys = db
      .query<{ foreign_keys: bigint }, []>("PRAGMA foreign_keys")
      .get()?.foreign_keys;
    const synchronous = db
      .query<{ synchronous: bigint }, []>("PRAGMA synchronous")
      .get()?.synchronous;
    const busyTimeout = db.query<{ timeout: bigint }, []>("PRAGMA busy_timeout").get()?.timeout;
    if (
      journal?.toLowerCase() !== "wal" ||
      foreignKeys !== 1n ||
      synchronous !== 2n ||
      busyTimeout !== 5000n
    ) {
      throw new Error(
        "SQLite did not apply the required WAL, foreign key, synchronous or busy timeout settings",
      );
    }
    return db;
  } catch (error) {
    db.close(true);
    throw error;
  }
}

/**
 * Work that only a stopped server allows. The instance lock refuses a server and keeps one from
 * starting meanwhile. EXCLUSIVE locking also fails while any other connection has the database
 * open, such as a running backup, and holds until this connection closes.
 *
 * The database is the primary project's (D151), until these commands learn about projects (B140,
 * B144); the lock stays the data directory's one lock.
 */
export function withStoppedDatabase<T>(
  dataDir: string,
  supportedVersion: number,
  work: (db: Database) => T,
): T {
  const path = join(primaryProjectDirectory(dataDir), "iglo-email.db");
  if (!statSync(path, { throwIfNoEntry: false })) {
    throw new Error(`No database at ${path}`);
  }
  const instance = holdDataDirectory(dataDir);
  try {
    const db = new Database(path, { readwrite: true, strict: true, safeIntegers: true });
    try {
      // Before the first read: a connection that has read keeps its shared-memory locking.
      db.run("PRAGMA busy_timeout = 0");
      db.run("PRAGMA locking_mode = EXCLUSIVE");
      try {
        db.run("BEGIN IMMEDIATE");
      } catch {
        throw new Error(`${path} is in use: stop what has it open first`);
      }
      const version = db.query<{ user_version: bigint }, []>("PRAGMA user_version").get();
      db.run("ROLLBACK");
      if (version?.user_version === 0n) {
        throw new Error(`${path} has no schema yet; start the server once`);
      }
      if (Number(version?.user_version) > supportedVersion) {
        throw new Error(`Database version ${version?.user_version} is ahead of this executable`);
      }
      return work(db);
    } finally {
      db.close(true);
    }
  } finally {
    instance.release();
  }
}
