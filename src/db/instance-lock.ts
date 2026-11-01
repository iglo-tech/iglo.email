// One process per data directory (D69). Not ported: listmonk has no such lock.
//
// The lock is SQLite's own file lock on a small file of its own, which holds no data. It is an
// fcntl lock: the kernel drops it when the process dies however that happens, no child inherits it,
// and it belongs to the file, so every path to one directory meets the same lock. The main database
// cannot carry it, since the read-only helpers (D62) and `backup` must keep reading that file.
import { Database } from "bun:sqlite";
import { mkdirSync, truncateSync } from "node:fs";
import { join, resolve } from "node:path";

const LOCK = "iglo-email.lock";
/**
 * Two processes starting together can each make the other's attempt fail, with neither holding the
 * lock. A short retry leaves one holder. A real holder keeps refusing, only these milliseconds later.
 */
const BUSY_RETRIES = 4;
const BUSY_RETRY_MS = 10;

export interface InstanceLock {
  release(): void;
}

/**
 * The journal stays in memory, so a kill leaves no file to recover, and there is no sync, since
 * nothing here must survive. Exclusive locking keeps the lock past the COMMIT, until the connection
 * closes. The write is what proves the lock: SQLite falls back to a read-only open of a file this
 * process cannot write, and there BEGIN EXCLUSIVE succeeds and holds nothing.
 */
function takeLock(path: string): Database {
  const lock = new Database(path, { create: true, strict: true });
  try {
    lock.run("PRAGMA busy_timeout = 0");
    const { journal_mode: journal } = lock
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode = MEMORY")
      .get()!;
    if (journal !== "memory") throw new Error(`journal mode is ${journal}`);
    lock.run("PRAGMA locking_mode = EXCLUSIVE");
    lock.run("PRAGMA synchronous = OFF");
    lock.run("BEGIN EXCLUSIVE");
    lock.run("PRAGMA user_version = 1");
    lock.run("COMMIT");
    return lock;
  } catch (error) {
    lock.close(true);
    throw error;
  }
}

/**
 * Takes the data directory for this process, or throws if another one has it. Every process that
 * writes the database calls this before opening it. The caller keeps the result until it is done:
 * the lock lasts as long as this connection does.
 */
export function holdDataDirectory(dataDir: string): InstanceLock {
  const directory = resolve(dataDir);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, LOCK);
  let emptied = false;
  for (let busy = 0; ;) {
    try {
      const lock = takeLock(path);
      return { release: () => lock.close(true) };
    } catch (error) {
      const { code, message } = error as { code?: string; message: string };
      if (code === "SQLITE_BUSY") {
        if (busy++ === BUSY_RETRIES)
          throw new Error(`${directory} is in use by another iglo.email process: stop it first`);
        Bun.sleepSync(1 + Math.random() * BUSY_RETRY_MS);
        continue;
      }
      // The file's content means nothing, and a holder never reads it again, so a damaged one is
      // emptied where it stands. Removing it instead could give two processes two locks.
      if (emptied || (code !== "SQLITE_NOTADB" && code !== "SQLITE_CORRUPT"))
        throw new Error(`Cannot lock ${path}: ${message}`);
      emptied = true;
      try {
        truncateSync(path);
      } catch (truncation) {
        throw new Error(`Cannot lock ${path}: ${(truncation as Error).message}`);
      }
    }
  }
}
