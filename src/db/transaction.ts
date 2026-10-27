import type { Database } from "bun:sqlite";

/** One synchronous write, without savepoints or automatic callback replay. */
export function writeTransaction<T>(
  db: Database,
  callback: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
  if (db.inTransaction) throw new Error("Nested write transactions are not supported");
  if (Object.prototype.toString.call(callback) === "[object AsyncFunction]") {
    throw new TypeError("Write transaction callback must be synchronous");
  }
  db.run("BEGIN IMMEDIATE");
  try {
    const result = callback();
    if (
      ((typeof result === "object" && result !== null) || typeof result === "function") &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      if (result instanceof Promise) void result.catch(() => undefined);
      throw new TypeError(
        "Write transaction callback must be synchronous, not a promise or thenable",
      );
    }
    db.run("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) {
      try {
        db.run("ROLLBACK");
      } catch {
        /* Preserve the callback or commit error. */
      }
    }
    throw error;
  }
}
