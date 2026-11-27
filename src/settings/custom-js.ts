// The unreviewed mark on a project's stored public custom JavaScript (D201, round 2). Not ported:
// listmonk serves the setting as stored. Migration 0039 places the mark on a non-empty script
// stored before the instance admin alone could write it; while it is there `/public/custom.js` is
// the empty script on every host. The instance admin's save of the script removes it. A row in the
// settings table that `defaults` does not name, like `restore.hold`, so the settings API neither
// shows nor writes it.
import type { Database } from "bun:sqlite";
import { storedValue } from "@/settings/stored";

const UNREVIEWED = "appearance.public.custom_js_unreviewed";

/** Fails closed: any row, whatever its value, holds the script back. */
export const customJsHeld = (db: Database): boolean => storedValue(db, UNREVIEWED) !== null;

/** The instance admin's review: called inside the write of the script, so both commit together. */
export function releaseCustomJs(db: Database): void {
  db.query("DELETE FROM settings WHERE key = ?").run(UNREVIEWED);
}
