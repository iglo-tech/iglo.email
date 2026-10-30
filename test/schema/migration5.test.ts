// Migration 5 (deleted-step cursors) on a populated version-4 database: tombstones left by v4
// saves are converted once, enrollments waiting on them reach the right step through the real
// scheduler, the pre-migration snapshot keeps the v4 data, and a second startup changes nothing.
// Data is generated and arranged in the v4 shape with SQL; mail goes to a loopback sink only.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { startRuntime } from "@/test/scheduler/runtime";
import { startSink } from "@/test/tx/sink";

/** Arrange data as v4 saves left it: deleted steps keep their pre-save position. */
function seedVersion4(directory: string) {
  const db = openDatabase(directory);
  try {
    runMigrations(db, directory, createRealClock(), productionMigrations.slice(0, 4));
    expect(version(db)).toBe(4);
    const due = new Date(Date.now() - 60_000).toISOString();
    const template = db
      .query<{ id: number }, []>(
        "INSERT INTO templates(name, type, subject, body) VALUES ('m5', 'tx', 'unused', '<p>{{ subscriber.email }}</p>') RETURNING id",
      )
      .get()!.id;
    const sequence = (name: string) =>
      db
        .query<{ id: number }, [string, string]>(
          `INSERT INTO sequences(uuid, name, status, trigger) VALUES (?, ?, 'active', '{"event":"m5"}') RETURNING id`,
        )
        .get(crypto.randomUUID(), name)!.id;
    const step = (seq: number, position: number, subject: string, deletedAt?: string) =>
      db
        .query<{ id: number }, [string, number, number, number, string, string, string]>(
          `INSERT INTO sequence_steps(uuid, sequence_id, position, wait, kind, template_id, subject, status, updated_at)
           VALUES (?, ?, ?, 'PT0S', 'transactional', ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          crypto.randomUUID(),
          seq,
          position,
          template,
          subject,
          deletedAt ? "deleted" : "active",
          deletedAt ?? "2026-10-01T00:00:00.000Z",
        )!.id;
    const enroll = (seq: number, stepId: number, email: string) => {
      const subscriber = db
        .query<{ id: number }, [string, string]>(
          "INSERT INTO subscribers(uuid, email, name) VALUES (?, ?, 'M5') RETURNING id",
        )
        .get(crypto.randomUUID(), email)!.id;
      return db
        .query<{ id: number }, [number, number, number, string]>(
          "INSERT INTO enrollments(sequence_id, subscriber_id, step_id, due_at) VALUES (?, ?, ?, ?) RETURNING id",
        )
        .get(seq, subscriber, stepId, due)!.id;
    };
    const save1 = "2026-10-02T00:00:00.000Z",
      save2 = "2026-10-03T00:00:00.000Z";

    // One save deleted B and C of A0 B1 C2 D3: kept steps renumbered to A0 D1.
    const one = sequence("one save");
    step(one, 0, "one A");
    const oneB = step(one, 1, "one B", save1);
    const oneC = step(one, 2, "one C", save1);
    step(one, 1, "one D");
    // Separate saves: B deleted (A0 C1 D2), later C deleted (A0 D1).
    const two = sequence("two saves");
    const twoA = step(two, 0, "two A");
    const twoB = step(two, 1, "two B", save1);
    const twoC = step(two, 1, "two C", save2);
    step(two, 1, "two D");
    // The last step deleted.
    const last = sequence("last deleted");
    step(last, 0, "last A");
    const lastB = step(last, 1, "last B", save1);

    const enrollments = {
      oneB: enroll(one, oneB, "one-b@m5.test"),
      oneC: enroll(one, oneC, "one-c@m5.test"),
      twoA: enroll(two, twoA, "two-a@m5.test"),
      twoB: enroll(two, twoB, "two-b@m5.test"),
      twoC: enroll(two, twoC, "two-c@m5.test"),
      lastB: enroll(last, lastB, "last-b@m5.test"),
    };
    return { steps: { oneB, oneC, twoB, twoC, lastB }, enrollments };
  } finally {
    db.close(true);
  }
}

const positions = (db: Database, ids: number[]) =>
  ids.map((id) =>
    Number(
      db
        .query<{ position: number }, [number]>("SELECT position FROM sequence_steps WHERE id = ?")
        .get(id)!.position,
    ),
  );
const statuses = (db: Database) =>
  db
    .query<{ id: number; status: string }, []>("SELECT id, status FROM enrollments ORDER BY id")
    .all()
    .map((e) => ({ id: Number(e.id), status: e.status }));
const version = (db: Database) =>
  Number(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version);
const backups = async (directory: string) =>
  (await readdir(join(directory, "backups"))).filter((name) => name.endsWith(".db"));

async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(25);
  }
}

test("migration 5 converts populated v4 tombstones once and waiting enrollments reach the right step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iglo-migration5-"));
  const sink = await startSink();
  try {
    const seeded = seedVersion4(directory);
    const deleted = Object.values(seeded.steps);

    // First startup: one snapshot, then the scheduler runs on the converted cursors.
    let runtime = startRuntime({
      dataDir: directory,
      smtpPort: sink.port,
      clock: createRealClock(),
    });
    try {
      expect(version(runtime.db)).toBe(productionMigrations.length);
      // one: B and C (same save) both point at D's position; two: B and C (separate saves) at D.
      expect(positions(runtime.db, deleted)).toEqual([1, 1, 1, 1, 1]);
      await until(
        () => sink.messages.length >= 6 && statuses(runtime.db).every((e) => e.status !== "active"),
        "waiting enrollments finish",
      );
      await Bun.sleep(200);
    } finally {
      await runtime.close();
    }
    const received = sink.messages.map((m) => [m.to[0], /^Subject: (.*)$/m.exec(m.data)?.[1]]);
    expect(received.sort()).toEqual(
      [
        ["one-b@m5.test", "one D"],
        ["one-c@m5.test", "one D"],
        ["two-a@m5.test", "two A"],
        ["two-a@m5.test", "two D"],
        ["two-b@m5.test", "two D"],
        ["two-c@m5.test", "two D"],
      ].sort(),
    );
    const snapshots = await backups(directory);
    expect(snapshots).toHaveLength(1);

    // The snapshot is the untouched v4 database with the old tombstone positions.
    const snapshot = new Database(join(directory, "backups", snapshots[0]!), { readonly: true });
    try {
      expect(version(snapshot)).toBe(4);
      expect(positions(snapshot, deleted)).toEqual([1, 2, 1, 1, 1]);
      expect(statuses(snapshot).every((e) => e.status === "active")).toBe(true);
      expect(
        Number(snapshot.query<{ n: number }, []>("SELECT count(*) AS n FROM sends").get()!.n),
      ).toBe(0);
    } finally {
      snapshot.close();
    }

    // Repeated startup: no new snapshot, cursors unchanged, nothing sent again.
    runtime = startRuntime({ dataDir: directory, smtpPort: sink.port, clock: createRealClock() });
    let before: ReturnType<typeof statuses>;
    try {
      before = statuses(runtime.db);
      expect(positions(runtime.db, deleted)).toEqual([1, 1, 1, 1, 1]);
      await Bun.sleep(500);
      expect(statuses(runtime.db)).toEqual(before);
      expect(Object.fromEntries(before.map((e) => [e.id, e.status]))).toEqual({
        [seeded.enrollments.oneB]: "completed",
        [seeded.enrollments.oneC]: "completed",
        [seeded.enrollments.twoA]: "completed",
        [seeded.enrollments.twoB]: "completed",
        [seeded.enrollments.twoC]: "completed",
        [seeded.enrollments.lastB]: "completed",
      });
    } finally {
      await runtime.close();
    }
    expect(sink.messages).toHaveLength(6);
    expect(await backups(directory)).toHaveLength(1);
  } finally {
    await sink.close();
    await rm(directory, { recursive: true, force: true });
  }
});
