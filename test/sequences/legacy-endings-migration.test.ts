// B22 (D83): migration 17 turns the old scheduler's canceled blocklisted/sequence_archived
// endings into exited, seen through the enrollment list filter.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createEnrollments } from "@/sequences/enrollments";

const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("legacy canceled endings by blocklist or archive are exited; manual cancels stay", () => {
  const dir = mkdtempSync(join(tmpdir(), "iglo-b22-"));
  directories.push(dir);
  const db = openDatabase(dir);
  const clock = createRealClock();
  runMigrations(db, dir, clock, productionMigrations.slice(0, 16));
  const stamp = "2026-01-01T00:00:00.000Z";
  db.run(`INSERT INTO sequences (id, uuid, name, trigger) VALUES (1, 's1', 'S', '{"event":"x"}')`);
  for (let id = 1; id <= 4; id++)
    db.run("INSERT INTO subscribers (id, uuid, email, name) VALUES (?, ?, ?, 'S')", [
      id,
      `u${id}`,
      `s${id}@example.test`,
    ]);
  for (const [id, status, reason] of [
    [1, "canceled", "blocklisted"],
    [2, "canceled", "sequence_archived"],
    [3, "canceled", "manual"],
    [4, "exited", "blocklisted"],
  ] as const)
    db.run(
      `INSERT INTO enrollments (id, sequence_id, subscriber_id, status, exit_reason, created_at, updated_at, finished_at)
       VALUES (?1, 1, ?1, ?2, ?3, ?4, ?4, ?4)`,
      [id, status, reason, stamp],
    );
  runMigrations(db, dir, clock, productionMigrations);
  const enrollments = createEnrollments(db, clock);
  const ids = (status: string) =>
    enrollments
      .list({ status, page: 1, perPage: 50 })
      .results.map((e) => e.id)
      .sort();
  expect(ids("exited")).toEqual([1, 2, 4]);
  expect(ids("canceled")).toEqual([3]);
  const row = db.query("SELECT updated_at, finished_at FROM enrollments WHERE id = 1").get();
  expect(row).toEqual({ updated_at: stamp, finished_at: stamp } as never);
  db.close(true);
});
