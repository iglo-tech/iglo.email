// Ordered migration responsibility compared with listmonk's cmd/install.go and cmd/upgrade.go.
import { Database } from "bun:sqlite";
import { linkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "@/clock";
import { maskSql } from "@/db/sql";
import { writeTransaction } from "@/db/transaction";

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

// M1.1 supplies version 1, the real v1 schema. No runtime directory discovery.
export const productionMigrations: readonly Migration[] = [];

function validateCatalog(catalog: readonly Migration[]): void {
  for (const [index, migration] of catalog.entries()) {
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version !== index + 1 ||
      migration.version > 2_147_483_647
    ) {
      throw new Error("Migration versions must be unique, positive, ordered and contiguous from 1");
    }
    const masked = maskSql(migration.sql);
    if (!masked.replaceAll(";", "").trim()) throw new Error(`Empty migration ${migration.version}`);
    validateMigrationBody(masked, migration.version);
  }
}

function validateMigrationBody(masked: string, version: number): void {
  const tokens = masked.match(/[A-Za-z_][A-Za-z_0-9$]*|[^\s]/g) ?? [];
  let start = true;
  let create = false;
  let trigger = false;
  let body = false;
  let caseDepth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.toUpperCase();
    if (start && token !== ";") {
      if (
        [
          "BEGIN",
          "COMMIT",
          "END",
          "ROLLBACK",
          "SAVEPOINT",
          "RELEASE",
          "VACUUM",
          "ATTACH",
          "DETACH",
        ].includes(token)
      ) {
        throw new Error(
          `Migration ${version} may not control transactions or database connections`,
        );
      }
      if (token === "PRAGMA")
        throw new Error(`Migration ${version} may not change connection settings or user_version`);
      create = token === "CREATE";
      start = false;
    } else if (create && !body && token === "TRIGGER") trigger = true;
    if (trigger && token === "BEGIN") body = true;
    else if (body && token === "CASE") caseDepth++;
    else if (body && token === "END") {
      if (caseDepth) caseDepth--;
      else body = false;
    }
    if (token === ";" && !body) {
      start = true;
      create = false;
      trigger = false;
    }
  }
}

function userVersion(db: Database): number {
  const value = db.query<{ user_version: bigint }, []>("PRAGMA user_version").get()?.user_version;
  if (value === undefined || value < 0n || value > 2_147_483_647n)
    throw new Error("Invalid SQLite user_version");
  return Number(value);
}

function createSnapshot(db: Database, dataDir: string, clock: Clock, version: number): string {
  const backups = join(dataDir, "backups");
  mkdirSync(backups, { recursive: true });
  const timestamp = clock.now().toISOString().replaceAll(":", "-");
  const attempt = mkdtempSync(join(backups, ".partial-"));
  const temporary = join(attempt, "snapshot.db");
  const destination = join(backups, `iglo-email-${timestamp}-${crypto.randomUUID()}.db`);
  try {
    db.run("VACUUM INTO ?", [temporary]);
    const snapshot = new Database(temporary, { readonly: true, safeIntegers: true });
    try {
      const integrity = snapshot
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get()?.integrity_check;
      if (integrity !== "ok" || userVersion(snapshot) !== version)
        throw new Error("Migration snapshot verification failed");
    } finally {
      snapshot.close(true);
    }
    // Hard linking publishes without replacing any existing file; the partial directory stays distinguishable on a crash.
    linkSync(temporary, destination);
    return destination;
  } finally {
    rmSync(attempt, { recursive: true, force: true });
  }
}

export function runMigrations(
  db: Database,
  dataDir: string,
  clock: Clock,
  catalog: readonly Migration[],
): void {
  validateCatalog(catalog);
  const version = userVersion(db);
  if (version > catalog.length)
    throw new Error(`Database version ${version} is ahead of this executable`);
  if (version === catalog.length) return;
  const objects = db
    .query<{ count: bigint }, []>(
      "SELECT count(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
    )
    .get()?.count;
  if (version > 0 || (objects ?? 0n) > 0n) createSnapshot(db, dataDir, clock, version);
  for (const migration of catalog.slice(version)) {
    writeTransaction(db, () => {
      db.run(migration.sql);
      db.run(`PRAGMA user_version = ${migration.version}`);
    });
  }
}
