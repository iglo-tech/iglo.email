// What a project delete's final-snapshot copy costs (B155a item 3, D176): the snapshot used to be a
// hard link of the database and is now its own file. Run: bun test/projects/measure-delete-copy.ts
// [base directory] (default: the OS temporary directory; pass a directory on disk to measure disk).
import { link, statfs, stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { archiveDeleted } from "@/projects/deleted";
import { removeDirectory, seedSubscribers, temporaryDirectory } from "@/test/backup/fixture";

const SUBSCRIBERS = 300_000;
const ROUNDS = 5;
const base = process.argv[2];
const clock = createRealClock();

/** A data directory whose primary project holds `SUBSCRIBERS` subscribers. */
function seeded(directory: string) {
  const dataDir = join(directory, "data");
  const project = join(dataDir, "projects", "main");
  mkdirSync(project, { recursive: true });
  const db = openDatabase(project);
  runMigrations(db, project, clock, productionMigrations);
  db.close(true);
  seedSubscribers(dataDir, SUBSCRIBERS);
  return { dataDir, database: join(project, "iglo-email.db") };
}

const median = (values: Array<number>) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;
const linked: Array<number> = [];
const archived: Array<number> = [];
let bytes = 0;
let filesystem = "";
for (let round = 0; round < ROUNDS; round++) {
  const directory = temporaryDirectory(base);
  try {
    const { dataDir, database } = seeded(directory);
    bytes = (await stat(database)).size;
    filesystem = `0x${(await statfs(directory)).type.toString(16)}`;
    // Before: the claim was one hard link.
    let started = performance.now();
    await link(database, join(directory, "linked.db"));
    linked.push(performance.now() - started);
    // After: the whole archive step, the copy included (no uploads, so no tarball).
    started = performance.now();
    await archiveDeleted(dataDir, "main", clock);
    archived.push(performance.now() - started);
  } finally {
    removeDirectory(directory);
  }
}
console.log(
  `${SUBSCRIBERS} subscribers, database ${(bytes / 1024 / 1024).toFixed(1)} MiB, filesystem ${filesystem}, ${ROUNDS} rounds`,
);
console.log(`hard link (before): median ${median(linked).toFixed(2)} ms`);
console.log(`archiveDeleted with the copy (after): median ${median(archived).toFixed(1)} ms`);
