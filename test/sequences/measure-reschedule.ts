// Rescheduling a large waiting set for docs/perf/B5-reschedule.md; opt-in, not a CI threshold.
// In-process on a real file: N enrollments wait on a step whose wait then changes. "Before" is the
// whole set in one statement and one transaction; "after" is the endpoint's bounded batches. A
// scheduler-like loop claims and releases a due row in its own write transaction on every turn of
// the event loop meanwhile, so the longest gap between its turns is the longest it waits for the
// write lock. With `other` > 0 the sequence has a second step holding that many more waiting
// enrollments, which a batch of the first step must not pay for.
// Usage: bun test/sequences/measure-reschedule.ts [N] [runs] [other].
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeTransaction } from "@/db/transaction";
import { sequencesFixture } from "@/test/sequences/fixture";

const repository = resolve(import.meta.dir, "../..");
const base = resolve(process.env.IGLO_EMAIL_PERF_DIR ?? join(repository, "upstream/measurements"));
mkdirSync(base, { recursive: true });
if (/tmpfs|ramfs/.test(Bun.spawnSync(["stat", "-f", "-c", "%T", base]).stdout.toString()))
  throw new Error("Refusing a memory-backed measurement directory");
process.env.TMPDIR = base;
const total = Number(process.argv[2] ?? 100_000);
const runs = Number(process.argv[3] ?? 3);
const other = Number(process.argv[4] ?? 0);
const hour = 3_600_000;

async function once(mode: "before" | "after") {
  const f = await sequencesFixture();
  try {
    // MEASURE_NO_INDEX=1 drops migration 15's index, which is the schema before B5's fix.
    if (process.env.MEASURE_NO_INDEX) f.db.run("DROP INDEX idx_enrollments_step_active");
    const tx = await f.template();
    const made = await f.json("/api/sequences", "POST", {
      name: "Measure",
      status: "active",
      trigger: { event: "x" },
      exit_on: [],
      reentry: "never",
      steps: [
        { wait: "PT1H", kind: "transactional", template_id: tx },
        { wait: "PT1H", kind: "transactional", template_id: tx },
      ],
    });
    const seq = made.body.data as { id: number; steps: { id: number }[] };
    const now = f.clock.now();
    f.db.run("BEGIN");
    f.db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO subscribers (uuid, email, name, status) SELECT lower(hex(randomblob(16))), 'm' || i || '@example.test', 'x', 'enabled' FROM n`,
      [total + other],
    );
    f.db.run(
      `INSERT INTO enrollments (sequence_id, subscriber_id, step_id, due_at, status, created_at, updated_at, test)
       SELECT ?, id, CASE WHEN id <= ? THEN ? ELSE ? END, ?, 'active', ?, ?, 0 FROM subscribers WHERE email LIKE 'm%@example.test'`,
      [
        seq.id,
        total,
        seq.steps[0]!.id,
        seq.steps[1]!.id,
        new Date(now.getTime() + hour).toISOString(),
        now.toISOString(),
        now.toISOString(),
      ],
    );
    f.db.run("COMMIT");
    const full = (await f.json(`/api/sequences/${seq.id}`)).body.data;
    full.steps[0].wait = "PT3H";
    delete full.status;
    expectOK(await f.json(`/api/sequences/${seq.id}`, "PUT", full));

    // The scheduler-like loop: one short write per turn.
    const gaps: number[] = [];
    let running = true;
    const loop = (async () => {
      let last = performance.now();
      while (running) {
        await new Promise((resolve) => setImmediate(resolve));
        writeTransaction(f.db, () =>
          f.db.run("UPDATE enrollments SET claimed_until = NULL WHERE id = 1"),
        );
        const at = performance.now();
        gaps.push(at - last);
        last = at;
      }
    })();
    const started = performance.now();
    let holds: number[] = [];
    if (mode === "before") {
      const t0 = performance.now();
      writeTransaction(f.db, () =>
        f.db.run(
          "UPDATE enrollments SET due_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+3 hours') WHERE step_id = ? AND status = 'active'",
          [seq.steps[0]!.id],
        ),
      );
      holds = [performance.now() - t0];
    } else {
      // The same batches as the endpoint, timed one by one.
      let cursor = 0n;
      for (;;) {
        const t0 = performance.now();
        const batch = writeTransaction(f.db, () =>
          f.enrollments.rescheduleBatch(BigInt(seq.id), BigInt(seq.steps[0]!.id), cursor, 500),
        );
        holds.push(performance.now() - t0);
        if (batch === "missing" || batch.next === null) break;
        cursor = batch.next;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    const elapsed = performance.now() - started;
    running = false;
    await loop;
    const sorted = [...holds].sort((a, b) => a - b);
    return {
      mode,
      total,
      other,
      elapsedMs: Math.round(elapsed),
      writes: holds.length,
      holdP50Ms: +sorted[Math.floor(sorted.length / 2)]!.toFixed(1),
      holdMaxMs: +sorted.at(-1)!.toFixed(1),
      schedulerGapMaxMs: +Math.max(...gaps).toFixed(1),
    };
  } finally {
    await f.close();
  }
}
function expectOK(r: { status: number; body: unknown }) {
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
}
for (const mode of ["before", "after"] as const)
  for (let i = 0; i < runs; i++) console.log(JSON.stringify(await once(mode)));
