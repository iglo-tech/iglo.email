// A bounded native SQLite baseline. M0.4 adds the equivalent helper workload.
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "iglo-db-measure-"));
const rows = 10_000;
const batch = 100;
const repetitions = 3;
try {
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const directory = join(root, String(repetition));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(directory);
    const file = join(directory, "iglo-email.db");
    const db = new Database(file, { safeIntegers: true, strict: true });
    db.run(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000",
    );
    db.run("CREATE TABLE measurement (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO measurement (id, value) VALUES (?, ?)");
    const lookup = db.prepare<{ value: string }, [number]>(
      "SELECT value FROM measurement WHERE id = ?",
    );
    const started = performance.now();
    for (let first = 1; first <= rows; first += batch) {
      db.run("BEGIN IMMEDIATE");
      for (let id = first; id < first + batch; id++) insert.run(id, `value-${id}`);
      db.run("COMMIT");
    }
    const written = performance.now();
    for (let id = 1; id <= rows; id++) {
      if (lookup.get(id)?.value !== `value-${id}`) throw new Error("Incorrect lookup");
    }
    const read = performance.now();
    const snapshot = join(directory, "snapshot.db");
    db.run("VACUUM INTO ?", [snapshot]);
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
        mode: "native",
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
    lookup.finalize();
    insert.finalize();
    db.close(true);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
