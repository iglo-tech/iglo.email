// The sequence list's reads at scale for docs/perf/M5.5-sequences.md; opt-in, not a CI threshold.
// Generated rows in a temporary database, `count` enrollments over 20 sequences of 3 steps, with one
// send per enrollment and step. Usage: bun test/sequences/measure-counts.ts [enrollments] [runs].
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnalyticsStore } from "@/analytics/store";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";

const count = Number(process.argv[2] ?? 1_000_000);
const runs = Number(process.argv[3] ?? 5);
const directory = mkdtempSync(join(tmpdir(), "iglo-sequence-counts-"));
const db = openDatabase(directory);
try {
  runMigrations(db, directory, createRealClock(), productionMigrations);
  const ids = Array.from({ length: 20 }, (_, i) => i + 1);
  const statuses = ["active", "completed", "exited"];
  db.transaction(() => {
    db.run("INSERT INTO subscribers (uuid, email, name) VALUES ('m', 'm@example.test', 'M')");
    db.run("INSERT INTO templates (name, type, subject, body) VALUES ('t', 'tx', 's', 'b')");
    const step = db.prepare(
      "INSERT INTO sequence_steps (uuid, sequence_id, position, wait, kind, template_id) VALUES (?, ?, ?, 'PT0S', 'transactional', 1)",
    );
    for (const id of ids) {
      db.run("INSERT INTO sequences (uuid, name, status, trigger) VALUES (?, ?, 'active', '{}')", [
        `s${id}`,
        `Sequence ${id}`,
      ]);
      for (const position of [0, 1, 2]) step.run(`${id}-${position}`, id, position);
    }
  })();
  // Real active rows are unique per subscriber, so each enrollment has its own subscriber.
  const insert = db.prepare(
    "INSERT INTO enrollments (id, sequence_id, subscriber_id, status) VALUES (?, ?, ?, ?)",
  );
  const subscriber = db.prepare(
    "INSERT INTO subscribers (id, uuid, email, name) VALUES (?, ?, ?, 'M')",
  );
  const send = db.prepare(
    "INSERT INTO sends (uuid, source, kind, to_email, enrollment_id, step_id, status) VALUES (?, 'sequence', 'transactional', 'm@example.test', ?, ?, 'sent')",
  );
  const started = performance.now();
  for (let from = 0; from < count; from += 50_000)
    db.transaction(() => {
      for (let i = from; i < Math.min(count, from + 50_000); i += 1) {
        const id = i + 2;
        const sequence = (i % 20) + 1;
        subscriber.run(id, `u${id}`, `u${id}@example.test`);
        insert.run(id, sequence, id, statuses[i % 3]!);
        send.run(`e${id}`, id, (sequence - 1) * 3 + 1);
      }
    })();
  console.log(`seeded ${count} in ${Math.round(performance.now() - started)} ms`);
  const timed = (label: string, read: () => unknown) => {
    const times: number[] = [];
    for (let run = 0; run < runs; run += 1) {
      const at = performance.now();
      read();
      times.push(Math.round((performance.now() - at) * 10) / 10);
    }
    console.log(JSON.stringify({ label, ms: times }));
  };
  const store = createAnalyticsStore(db);
  const list = db.prepare(
    "SELECT id, (SELECT count(*) FROM enrollments WHERE sequence_id = sequences.id AND status = 'active' AND test = 0) AS active FROM sequences ORDER BY id DESC LIMIT 20",
  );
  const total = db.prepare("SELECT count(*) FROM enrollments");
  timed("server thread: sequence page with active counts", () => list.all());
  timed("server thread: explorer total, no filter", () => total.get());
  timed("reader child's query: counts of 20 sequences", () =>
    store.sequenceCounts(ids.map(String)),
  );
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
