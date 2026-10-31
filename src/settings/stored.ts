// Reads of the settings table that need no store: createSettings seeds on open, and a read-only
// snapshot cannot be seeded. Not ported: listmonk has no backup command.
import type { Database } from "bun:sqlite";
import { defaults } from "@/settings/defaults";
import { parseStoredJson } from "@/settings/json";

const UPLOAD_PATH = "upload.filesystem.upload_path";

export function storedValue(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as {
    value: string;
  } | null;
  return row?.value ?? null;
}

export function writeStoredValue(db: Database, key: string, value: unknown): void {
  db.query(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value));
}

export function storedUploadPath(db: Database): string {
  const value = storedValue(db, UPLOAD_PATH);
  const path = value === null ? defaults[UPLOAD_PATH] : parseStoredJson(value);
  return typeof path === "string" ? path : defaults[UPLOAD_PATH];
}

export const writeUploadPath = (db: Database, path: string) =>
  writeStoredValue(db, UPLOAD_PATH, path);
