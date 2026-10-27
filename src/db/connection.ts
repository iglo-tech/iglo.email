// Connection responsibility adapted from listmonk's cmd/init.go: initDB.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
