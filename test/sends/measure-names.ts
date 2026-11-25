// B117d (D139): the write cost of writing a send's template and sequence names at queue time, measured
// at a million sends through the journal's own functions, as the send path calls them. The database is
// filled with sent sends, then each repetition queues a batch with the production request path
// (`enqueueRequest`, 1,000 recipients per request), claims each one (`claimBatch`, one claim per
// transaction, as the outbox's batch of one) and settles it (`finishAll`, one transaction each). The
// names callbacks are the statements the templates and sequences modules run (`template-names`,
// `step-labels`); the journal calls them only where the send names a template or a step.
// Serial, opt-in, not a CI threshold. Results are stored in docs/perf/B117d-send-names.md.
// Usage: bun test/sends/measure-names.ts [sends] [batch] [repetitions]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createListReferences } from "@/lists/references";
import type { Outcome } from "@/messaging/email";
import { createSends } from "@/messaging/sends";
import { createSubscriberStore } from "@/subscribers/store";

const [sendsArg, batchArg, repsArg] = process.argv.slice(2);
const sends = Number(sendsArg ?? 1_000_000);
const batch = Number(batchArg ?? 20_000);
const repetitions = Number(repsArg ?? 3);
const clock = createRealClock();
const root = mkdtempSync(join(tmpdir(), "iglo-send-names-"));

const median = (values: Array<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const ms = (start: number) => Math.round(performance.now() - start);
const accepted = (messageId: string): Outcome => ({
  messageId,
  status: "accepted",
  stage: "smtp-complete",
  accepted: ["recipient@example.test"],
  rejected: [],
});

const dataDir = join(root, "names");
const db = openDatabase(dataDir);
try {
  runMigrations(db, dataDir, clock, productionMigrations);
  const lists = createListReferences(db);
  const subscribers = createSubscriberStore(db, clock, lists);
  const templateNames = db.query<{ id: bigint; name: string }, [string]>(
    "SELECT id, name FROM templates WHERE id IN (SELECT value FROM json_each(?))",
  );
  const journal = createSends({
    db,
    clock,
    subscribers,
    rootUrl: () => "http://measure.test",
    templateNames: (ids) =>
      new Map(templateNames.all(`[${ids.join(",")}]`).map((row) => [row.id, row.name])),
  });

  // One template for the queued sends, and the bulk of the journal as sent mail with its 2 KB payload kept.
  db.run(
    "INSERT INTO templates (name, type, subject, body) VALUES ('Measured template', 'tx', 'Subject', '<p>x</p>')",
  );
  const templateId = db.query<{ id: bigint }, []>("SELECT max(id) AS id FROM templates").get()!.id;
  const seedStart = performance.now();
  db.transaction(() => {
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
  const seeded = ms(seedStart);

  const timings = {
    insert: [] as Array<number>,
    claim: [] as Array<number>,
    settle: [] as Array<number>,
  };
  for (let rep = 0; rep < repetitions; rep++) {
    const requests = Math.ceil(batch / 1000);
    const insertStart = performance.now();
    let queuedIds: Array<bigint> = [];
    for (let r = 0; r < requests; r++) {
      const count = Math.min(1000, batch - r * 1000);
      const result = journal.enqueueRequest({
        sends: Array.from({ length: count }, (_, i) => ({
          send: {
            source: "tx" as const,
            kind: "transactional" as const,
            templateId,
            message: {
              from: "sender@example.test",
              to: [`queued${rep}-${r}-${i}@example.test`],
              subject: "Measured",
              contentType: "plain" as const,
              body: Buffer.from("measured body"),
              headers: {},
            },
          },
          subscriberUuid: null,
        })),
      });
      queuedIds = queuedIds.concat(result.queued);
    }
    timings.insert.push(ms(insertStart));

    const now = clock.now();
    const lease = new Date(now.getTime() + 60_000);
    const claimed = [];
    const claimStart = performance.now();
    for (let i = 0; i < queuedIds.length; i++) {
      const [claim] = journal.claimBatch(now, lease, 1, "transactional");
      if (claim) {
        claimed.push(claim);
      }
    }
    timings.claim.push(ms(claimStart));

    const settleStart = performance.now();
    for (const claim of claimed) {
      journal.finishAll([{ row: claim.row, outcome: accepted(claim.row.smtp_message_id) }]);
    }
    timings.settle.push(ms(settleStart));
  }
  const spread = (values: Array<number>) => ({
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  });
  console.log(
    JSON.stringify(
      {
        sends,
        batch,
        repetitions,
        seedMs: seeded,
        timings: {
          insert: spread(timings.insert),
          claim: spread(timings.claim),
          settle: spread(timings.settle),
        },
        runs: timings,
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
