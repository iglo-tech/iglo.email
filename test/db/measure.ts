// Compare a bounded native SQLite workload with the same work through M0.4 helpers.
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { runMigrations } from "@/db/migrations";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";

const base = resolve(
  process.env.IGLO_EMAIL_PERF_DIR ?? join(import.meta.dir, "../../upstream/measurements"),
);
mkdirSync(base, { recursive: true });
const filesystemType = Number(statfsSync(base).type);
if ([0x01021994, 0x858458f6].includes(filesystemType))
  throw new Error(
    "Storage measurements cannot use tmpfs/ramfs; set IGLO_EMAIL_PERF_DIR to disk-backed storage",
  );
console.log(
  JSON.stringify({
    kind: "environment",
    directory: base,
    filesystemType: `0x${filesystemType.toString(16)}`,
    platform: platform(),
    release: release(),
    arch: arch(),
  }),
);
const root = mkdtempSync(join(base, "iglo-db-measure-"));
const rows = 10_000;
const batch = 100;
const repetitions = 3;
try {
  for (const mode of ["native", "helper"] as const) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const directory = join(root, `${mode}-${repetition}`);
      mkdirSync(directory);
      const file = join(directory, "iglo-email.db");
      const db =
        mode === "native"
          ? new Database(file, { safeIntegers: true, strict: true })
          : openDatabase(directory);
      if (mode === "native")
        db.run(
          "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000",
        );
      db.run("CREATE TABLE measurement (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      const named =
        mode === "helper"
          ? prepareNamedQueries(db, [
              {
                name: "measurement",
                sql: "-- name: insert\nINSERT INTO measurement (id, value) VALUES (?, ?);\n-- name: lookup\nSELECT value FROM measurement WHERE id = ?;",
              },
            ])
          : undefined;
      const insert = named
        ? named.get("insert")
        : db.prepare("INSERT INTO measurement (id, value) VALUES (?, ?)");
      const lookup = named
        ? named.get("lookup")
        : db.prepare("SELECT value FROM measurement WHERE id = ?");
      const started = performance.now();
      for (let first = 1; first <= rows; first += batch) {
        const work = () => {
          for (let id = first; id < first + batch; id++) insert.run(id, `value-${id}`);
        };
        if (mode === "helper") writeTransaction(db, work);
        else {
          db.run("BEGIN IMMEDIATE");
          work();
          db.run("COMMIT");
        }
      }
      const written = performance.now();
      for (let id = 1; id <= rows; id++) {
        if ((lookup.get(id) as { value: string } | null)?.value !== `value-${id}`)
          throw new Error("Incorrect lookup");
      }
      const read = performance.now();
      let snapshot: string;
      if (mode === "helper") {
        runMigrations(db, directory, createRealClock(), [
          { version: 1, sql: "CREATE TABLE measurement_revision (id INTEGER PRIMARY KEY);" },
        ]);
        snapshot = join(directory, "backups", readdirSync(join(directory, "backups"))[0]!);
      } else {
        snapshot = join(directory, "snapshot.db");
        db.run("VACUUM INTO ?", [snapshot]);
      }
      const backedUp = performance.now();
      const backup = new Database(snapshot, { readonly: true, safeIntegers: true });
      const count = backup
        .query<{ count: bigint; sum: bigint }, []>(
          "SELECT count(*) AS count, sum(id) AS sum FROM measurement",
        )
        .get();
      if (count?.count !== 10_000n || count.sum !== 50_005_000n)
        throw new Error("Incorrect snapshot");
      const sqlite = db
        .query<{ version: string }, []>("SELECT sqlite_version() AS version")
        .get()?.version;
      console.log(
        JSON.stringify({
          mode,
          repetition,
          bun: Bun.version,
          sqlite,
          rows,
          batch,
          insertMs: written - started,
          readMs: read - written,
          snapshotMs: backedUp - read,
          dbBytes: statSync(file).size,
          walBytes: statSync(`${file}-wal`).size,
          snapshotBytes: statSync(snapshot).size,
          count: String(count.count),
          sum: String(count.sum),
        }),
      );
      backup.close(true);
      if (named) named.close();
      else {
        lookup.finalize();
        insert.finalize();
      }
      db.close(true);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
