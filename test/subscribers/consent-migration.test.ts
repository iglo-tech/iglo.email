// B19 (D81): migration 16 repairs databases written by the older blocklist paths.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";

const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a blocklisted subscriber's live memberships become unsubscribed, nothing else changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "iglo-b19-"));
  directories.push(dir);
  const db = openDatabase(dir);
  const clock = createRealClock();
  runMigrations(db, dir, clock, productionMigrations.slice(0, 15));
  const stamp = "2026-01-01T00:00:00.000Z";
  db.run("INSERT INTO lists (uuid, name, type, optin) VALUES ('l1', 'L', 'public', 'single')");
  for (const [id, status] of [
    [1, "blocklisted"],
    [2, "enabled"],
  ] as const)
    db.run("INSERT INTO subscribers (id, uuid, email, name, status) VALUES (?, ?, ?, 'S', ?)", [
      id,
      `u${id}`,
      `s${id}@example.test`,
      status,
    ]);
  db.run(
    `INSERT INTO subscriber_lists (subscriber_id, list_id, status, created_at, updated_at)
     VALUES (1, 1, 'confirmed', ?1, ?1), (2, 1, 'confirmed', ?1, ?1)`,
    [stamp],
  );
  runMigrations(db, dir, clock, productionMigrations);
  const rows = db
    .query("SELECT subscriber_id AS id, status, updated_at FROM subscriber_lists ORDER BY 1")
    .all();
  expect(rows).toEqual([
    { id: 1n, status: "unsubscribed", updated_at: stamp },
    { id: 2n, status: "confirmed", updated_at: stamp },
  ] as never);
  db.close(true);
});
