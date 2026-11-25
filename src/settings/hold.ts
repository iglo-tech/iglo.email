// The restore hold (D67). Not ported: listmonk has no backup command. A row in the settings table
// that `defaults` does not name, so the settings API neither shows nor writes it and every schema
// a backup can hold has its table. It is placed in the snapshot itself, by `backup` and by the
// migration runner: a restored database starts held however it was copied. The server reads it and
// never changes it; only the stopped-server release does (src/backup/snapshot.ts). The hold is per
// database (D158): a project database's holds that project, and instance.db's holds every project.
import type { Database } from "bun:sqlite";
import { HttpError } from "@/server/response";
import { parseStoredJson } from "@/settings/json";
import { storedValue, writeStoredValue } from "@/settings/stored";

const HOLD = "restore.hold";

export interface RestoreHold {
  /** When the snapshot that started the hold was taken. */
  since: string;
  reason: string;
}
/** The stored state: a hold, or the time an operator released one. */
export interface HoldRecord {
  since: string;
  releasedAt: string | null;
}

/** Fails closed: a row that cannot be read is a hold of unknown age, not a release. */
export function holdRecord(db: Database): HoldRecord | null {
  const value = storedValue(db, HOLD);
  if (value === null) {
    return null;
  }
  try {
    const parsed = parseStoredJson(value) as {
      since?: unknown;
      released_at?: unknown;
    };
    if (typeof parsed.since === "string") {
      return {
        since: parsed.since,
        releasedAt: typeof parsed.released_at === "string" ? parsed.released_at : null,
      };
    }
  } catch {
    /* Below. */
  }
  return { since: "unknown", releasedAt: null };
}

/**
 * The instance hold (D158), on a project's own connection: a TEMP table, which lives only as long as
 * that connection, is never in the project's file and is never copied by `VACUUM INTO`. The instance
 * places it when it wires a project and a restored instance.db is held; only the stopped-server
 * release of instance.db ends it, so it holds for the whole run.
 */
const INSTANCE_HOLD = "restore_instance_hold";

function instanceHoldSince(db: Database): string | null {
  const table = db
    .query("SELECT name FROM temp.sqlite_schema WHERE type = 'table' AND name = ?")
    .get(INSTANCE_HOLD);
  if (!table) {
    return null;
  }
  const row = db.query(`SELECT since FROM temp.${INSTANCE_HOLD}`).get() as {
    since: string;
  } | null;
  return row?.since ?? null;
}

/**
 * Holds a project's sending while `instance` (instance.db) has an unreleased hold (14-projects
 * section 12, D158). Writes nothing to either database file.
 */
export function holdForInstance(project: Database, instance: Database): void {
  const record = holdRecord(instance);
  if (!record || record.releasedAt !== null) {
    return;
  }
  project.run(`CREATE TEMP TABLE IF NOT EXISTS ${INSTANCE_HOLD} (since TEXT NOT NULL)`);
  project.run(`DELETE FROM temp.${INSTANCE_HOLD}`);
  project.query(`INSERT INTO temp.${INSTANCE_HOLD} (since) VALUES (?)`).run(record.since);
}

/** The database's own hold first, then the instance's (D158). */
export function restoreHold(db: Database): RestoreHold | null {
  const record = holdRecord(db);
  if (record && record.releasedAt === null) {
    return {
      since: record.since,
      reason:
        `Restored from a backup taken at ${record.since}: deliveries and opt-outs after it are ` +
        "not on record. Sending stays stopped until an operator reconciles them and releases it.",
    };
  }
  const since = instanceHoldSince(db);
  if (since === null) {
    return null;
  }
  return {
    since,
    reason:
      `The instance database was restored from a backup taken at ${since}. Sending stays stopped ` +
      "in every project until an operator reviews it and releases the instance hold.",
  };
}

/** The one check of every sending path. A loop asks it before it claims. */
export const sendingHeld = (db: Database): boolean => restoreHold(db) !== null;

/** The same check for a request or a direct send, which get a clear error. */
export function refuseWhileHeld(db: Database): void {
  const hold = restoreHold(db);
  if (hold) {
    throw new HttpError(503, `Sending is held. ${hold.reason}`, {}, "held");
  }
}

/** Into a snapshot. A hold already there stays as it is: its gap began at that older moment. */
export function placeRestoreHold(db: Database, since: string): void {
  if (!sendingHeld(db)) {
    writeStoredValue(db, HOLD, { since });
  }
}

export function releaseRestoreHold(db: Database, record: HoldRecord, at: string): void {
  writeStoredValue(db, HOLD, { since: record.since, released_at: at });
}
