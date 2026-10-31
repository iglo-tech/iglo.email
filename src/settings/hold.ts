// The restore hold (D67). Not ported: listmonk has no backup command. A row in the settings table
// that `defaults` does not name, so the settings API neither shows nor writes it and every schema
// a backup can hold has its table. It is placed in the snapshot itself, by `backup` and by the
// migration runner: a restored database starts held however it was copied. The server reads it and
// never changes it; only the stopped-server release does (src/backup/snapshot.ts).
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
  if (value === null) return null;
  try {
    const parsed = parseStoredJson(value) as { since?: unknown; released_at?: unknown };
    if (typeof parsed.since === "string")
      return {
        since: parsed.since,
        releasedAt: typeof parsed.released_at === "string" ? parsed.released_at : null,
      };
  } catch {
    /* Below. */
  }
  return { since: "unknown", releasedAt: null };
}

export function restoreHold(db: Database): RestoreHold | null {
  const record = holdRecord(db);
  if (!record || record.releasedAt !== null) return null;
  return {
    since: record.since,
    reason:
      `Restored from a backup taken at ${record.since}: deliveries and opt-outs after it are ` +
      "not on record. Sending stays stopped until an operator reconciles them and releases it.",
  };
}

/** The one check of every sending path. A loop asks it before it claims. */
export const sendingHeld = (db: Database): boolean => restoreHold(db) !== null;

/** The same check for a request or a direct send, which get a clear error. */
export function refuseWhileHeld(db: Database): void {
  const hold = restoreHold(db);
  if (hold) throw new HttpError(503, `Sending is held. ${hold.reason}`);
}

/** Into a snapshot. A hold already there stays as it is: its gap began at that older moment. */
export function placeRestoreHold(db: Database, since: string): void {
  if (!sendingHeld(db)) writeStoredValue(db, HOLD, { since });
}

export function releaseRestoreHold(db: Database, record: HoldRecord, at: string): void {
  writeStoredValue(db, HOLD, { since: record.since, released_at: at });
}
