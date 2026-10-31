// What the restore hold costs a sending loop and a backup. Run: bun test/backup/measure-hold.ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { placeRestoreHold, sendingHeld } from "@/settings/hold";
import { removeDirectory, seedSubscribers, temporaryDirectory } from "@/test/backup/fixture";

const ROUNDS = 1_000_000;
const SUBSCRIBERS = 300_000;
const directory = temporaryDirectory();
try {
  const dataDir = join(directory, "data");
  mkdirSync(dataDir);
  const db = openDatabase(dataDir);
  runMigrations(db, dataDir, createRealClock(), productionMigrations);
  const reads = (label: string) => {
    const started = performance.now();
    for (let i = 0; i < ROUNDS; i++) sendingHeld(db);
    console.log(`${label}: ${(((performance.now() - started) * 1000) / ROUNDS).toFixed(2)} us`);
  };
  reads("sendingHeld, no row");
  placeRestoreHold(db, new Date().toISOString());
  reads("sendingHeld, held");
  db.close(true);

  seedSubscribers(dataDir, SUBSCRIBERS);
  const source = new Database(join(dataDir, "iglo-email.db"));
  const snapshot = join(directory, "snapshot.db");
  source.run("VACUUM INTO ?", [snapshot]);
  source.close(true);
  const started = performance.now();
  const sealed = new Database(snapshot, { strict: true });
  sealed.run("PRAGMA journal_mode = DELETE");
  placeRestoreHold(sealed, new Date().toISOString());
  sealed.close(true);
  console.log(
    `sealing a snapshot of ${SUBSCRIBERS} subscribers: ${(performance.now() - started).toFixed(1)} ms`,
  );
} finally {
  removeDirectory(directory);
}
