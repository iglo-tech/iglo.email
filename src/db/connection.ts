// Connection responsibility adapted from listmonk's cmd/init.go: initDB.
import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export function openDatabase(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "iglo-email.db"), {
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
 * Work that only a stopped server allows. EXCLUSIVE locking fails while any other connection has
 * the database open, which is how the server is told apart from nothing running, and holds until
 * this connection closes.
 */
export function withStoppedDatabase<T>(
  dataDir: string,
  supportedVersion: number,
  work: (db: Database) => T,
): T {
  const path = join(resolve(dataDir), "iglo-email.db");
  if (!statSync(path, { throwIfNoEntry: false })) throw new Error(`No database at ${path}`);
  const db = new Database(path, { readwrite: true, strict: true, safeIntegers: true });
  try {
    // Before the first read: a connection that has read keeps its shared-memory locking.
    db.run("PRAGMA busy_timeout = 0");
    db.run("PRAGMA locking_mode = EXCLUSIVE");
    try {
      db.run("BEGIN IMMEDIATE");
    } catch {
      throw new Error(`${path} is in use: stop the server first`);
    }
    const version = db.query<{ user_version: bigint }, []>("PRAGMA user_version").get();
    db.run("ROLLBACK");
    if (version?.user_version === 0n)
      throw new Error(`${path} has no schema yet; start the server once`);
    if (Number(version?.user_version) > supportedVersion)
      throw new Error(`Database version ${version?.user_version} is ahead of this executable`);
    return work(db);
  } finally {
    db.close(true);
  }
}
