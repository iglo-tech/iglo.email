// B117d (decision 3): the write cost of a sequence send at a million sends, with its names. The scheduler
// renders a step, then records it in one write transaction (`recordSequence`, the commit in
// src/scheduler/scheduler.ts). This script times that commit alone: each repetition prepares its sends
// first (outside the timing), then records each one in its own write transaction, one enrollment per send.
// The names callbacks are the statements the templates and sequences modules run for a send's labels
// (`template-names`, `step-labels`), so a queued send does the two primary-key lookups it does in production.
// Serial, opt-in, not a CI threshold. Results are stored in docs/perf/B117d-send-names.md.
// Usage: bun test/sends/measure-sequence-names.ts [sends] [batch] [repetitions]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { writeTransaction } from "@/db/transaction";
import { createListReferences } from "@/lists/references";
import { createSends } from "@/messaging/sends";
import type { Sends, StepLabel } from "@/messaging/sends";
import { createSubscriberStore } from "@/subscribers/store";

const [sendsArg, batchArg, repsArg] = process.argv.slice(2);
const sends = Number(sendsArg ?? 1_000_000);
const batch = Number(batchArg ?? 20_000);
const repetitions = Number(repsArg ?? 3);
const clock = createRealClock();
const root = mkdtempSync(join(tmpdir(), "iglo-sequence-names-"));

const median = (values: Array<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const rounded = (value: number) => Math.round(value);

const dataDir = join(root, "sequence");
const db = openDatabase(dataDir);
try {
  runMigrations(db, dataDir, clock, productionMigrations);
  const lists = createListReferences(db);
  const subscribers = createSubscriberStore(db, clock, lists);
  const templateNamesQuery = db.query<{ id: bigint; name: string }, [string]>(
    "SELECT id, name FROM templates WHERE id IN (SELECT value FROM json_each(?))",
  );
  const stepLabelsQuery = db.query<
    { id: bigint; sequence_id: bigint; sequence_name: string; position: bigint },
    [string]
  >(
    `SELECT st.id, st.sequence_id, s.name AS sequence_name, st.position
       FROM sequence_steps st JOIN sequences s ON s.id = st.sequence_id
       WHERE st.id IN (SELECT value FROM json_each(?))`,
  );
  const journal = createSends({
    db,
    clock,
    subscribers,
    rootUrl: () => "http://measure.test",
    templateNames: (ids) =>
      new Map(templateNamesQuery.all(`[${ids.join(",")}]`).map((row) => [row.id, row.name])),
    stepLabels: (ids) =>
      new Map(
        stepLabelsQuery.all(`[${ids.join(",")}]`).map((row) => [
          row.id,
          {
            sequence_id: row.sequence_id,
            sequence_name: row.sequence_name,
            position: row.position,
          } satisfies StepLabel,
        ]),
      ),
  });

  // One template, one sequence with one step, and the subscribers and enrollments the sequence sends name.
  // Each send has its own enrollment, so the (enrollment, step) pair is unique as in production.
  const subscriberCount = 20_000;
  const enrollments = repetitions * batch;
  const seedStart = performance.now();
  db.transaction(() => {
    db.run(
      "INSERT INTO templates (name, type, subject, body) VALUES ('Measured step template', 'tx', 'Subject', '<p>x</p>')",
    );
    db.run(
      `INSERT INTO sequences (uuid, name, trigger) VALUES ('measured-sequence', 'Measured sequence', '{"event":"measured"}')`,
    );
    db.run(
      `INSERT INTO sequence_steps (uuid, sequence_id, position, wait, kind, template_id)
       VALUES ('measured-step', (SELECT max(id) FROM sequences), 0, 'PT0S', 'transactional', (SELECT max(id) FROM templates))`,
    );
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO subscribers (uuid, email, name, status) SELECT 'sub-' || i, 'sub' || i || '@example.test', 'Sub ' || i, 'enabled' FROM n`,
      [subscriberCount],
    );
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO enrollments (sequence_id, subscriber_id, step_id, status)
       SELECT (SELECT max(id) FROM sequences), ((i - 1) % ?2) + 1, (SELECT max(id) FROM sequence_steps), 'completed' FROM n`,
      [enrollments, subscriberCount],
    );
    // The bulk of the journal: sent mail with its 2 KB payload kept.
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO sends (uuid, source, kind, to_email, status, smtp_message_id, created_at, sent_at, payload)
       SELECT 'seed-' || i, 'tx', 'transactional', 'seed' || i || '@example.test', 'sent',
         '<seed-' || i || '@measure.test>',
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || (i % 300) || ' days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || (i % 300) || ' days'),
         json_object('message', json_object('subject', 'Subject ' || i, 'html', replace(printf('%2000s', ''), ' ', 'x')))
       FROM n`,
      [sends],
    );
  })();
  const seeded = Math.round(performance.now() - seedStart);
  const templateId = db.query<{ id: bigint }, []>("SELECT max(id) AS id FROM templates").get()!.id;
  const stepId = db.query<{ id: bigint }, []>("SELECT max(id) AS id FROM sequence_steps").get()!.id;
  const enrollmentIds = db
    .query<{ id: bigint }, []>("SELECT id FROM enrollments ORDER BY id")
    .all()
    .map((row) => row.id);
  const subscriberRows = db
    .query<{ id: bigint; uuid: string; email: string }, [number]>(
      "SELECT id, uuid, email FROM subscribers WHERE id <= ?",
    )
    .all(subscriberCount);

  const timings: Array<number> = [];
  for (let rep = 0; rep < repetitions; rep++) {
    // Prepare outside the timing: the render and the payload are not the write this measures.
    const prepared: Array<ReturnType<Sends["prepareSequence"]>> = [];
    for (let j = 0; j < batch; j++) {
      const subscriber = subscriberRows[(rep * batch + j) % subscriberCount]!;
      prepared.push(
        journal.prepareSequence(
          {
            uuid: crypto.randomUUID(),
            source: "sequence",
            kind: "transactional",
            message: {
              from: "sender@example.test",
              to: [subscriber.email],
              subject: "Measured",
              contentType: "plain",
              body: Buffer.from("measured body"),
              headers: {},
            },
            subscriberId: subscriber.id,
            templateId,
            enrollmentId: enrollmentIds[rep * batch + j]!,
            stepId,
            listId: null,
          },
          subscriber.uuid,
        ),
      );
    }
    const start = performance.now();
    for (const send of prepared) {
      writeTransaction(db, () => journal.recordSequence({ prepared: send }));
    }
    timings.push(performance.now() - start);
  }
  console.log(
    JSON.stringify(
      {
        sends,
        batch,
        repetitions,
        seedMs: seeded,
        recordMs: {
          median: rounded(median(timings)),
          min: rounded(Math.min(...timings)),
          max: rounded(Math.max(...timings)),
        },
        perSendMicros: Math.round((median(timings) / batch) * 1000),
        runs: timings.map(rounded),
      },
      null,
      2,
    ),
  );
  journal.close();
  subscribers.close();
  lists.close();
} finally {
  db.close(true);
  rmSync(root, { recursive: true, force: true });
}
