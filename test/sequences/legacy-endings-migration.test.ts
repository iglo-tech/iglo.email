// B22 (D83): migration 17 turns the old scheduler's canceled blocklisted/sequence_archived
// endings into exited, seen through GET /api/enrollments?status=.
import { afterEach, expect, test } from "bun:test";
import { sequencesFixture, type SequencesFixture } from "@/test/sequences/fixture";

const fixtures: SequencesFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

test("legacy canceled endings by blocklist or archive are exited; manual cancels stay", async () => {
  const stamp = "2026-01-01T00:00:00.000Z";
  const f = await sequencesFixture({
    legacy(db) {
      db.run(
        `INSERT INTO sequences (id, uuid, name, trigger) VALUES (1, 's1', 'S', '{"event":"x"}')`,
      );
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
    },
  });
  fixtures.push(f);
  const list = async (status: string) => {
    const response = await f.json(`/api/enrollments?status=${status}&per_page=50`);
    expect(response.status).toBe(200);
    return response.body.data.results as { id: number; updated_at: string; finished_at: string }[];
  };
  const exited = await list("exited");
  expect(exited.map((e) => e.id).sort()).toEqual([1, 2, 4]);
  expect((await list("canceled")).map((e) => e.id)).toEqual([3]);
  // The ending times are untouched.
  for (const e of exited) expect([e.updated_at, e.finished_at]).toEqual([stamp, stamp]);
});
