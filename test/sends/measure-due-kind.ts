// B149b (B141 r1, D165): migration 0034's index `idx_sends_due_kind (status, kind, next_attempt_at,
// id)`, measured in isolation. Two databases are migrated to the current schema and filled with the
// same history; in one, the index is dropped again, which is the claim path as it was before 0034.
// Per database:
// - `claim`: one outbox loop item's claim of one kind (`claimBatch`, 10 rows, one write
//   transaction, synchronous=FULL), with a backlog of queued rows of the other kind waiting: the
//   transactional claim behind marketing rows, and the marketing claim behind transactional rows.
// - `writes`: the index's write cost: a batch of queued sends inserted in one transaction, claimed by
//   the outbox's own claim, and settled by `finishAll`, as measure-status-index.ts does.
// - `migration`: 0034's own SQL on the filled database without the index, and the file growth.
// Serial, opt-in, not a CI threshold; the results are stored in docs/perf/projects-B149b.md.
// Usage: bun test/sends/measure-due-kind.ts [history] [backlog] [repetitions] [dir]
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { writeTransaction } from "@/db/transaction";
import { must } from "@/invariant";
import { createListReferences } from "@/lists/references";
import type { Outcome } from "@/messaging/email";
import { encodePayload } from "@/messaging/payload";
import { createSends } from "@/messaging/sends";
import type { Claimed, SendKind } from "@/messaging/sends";
import { createSubscriberStore } from "@/subscribers/store";

const [historyArg, backlogArg, repsArg, dirArg] = process.argv.slice(2);
const history = Number(historyArg ?? 1_000_000);
const backlog = Number(backlogArg ?? 100_000);
const repetitions = Number(repsArg ?? 3);
/** The outbox's batch size (src/messaging/outbox.ts `batchSize`). */
const outboxBatch = 10;
/** Claims timed per kind and repetition. */
const claims = 200;
/** Rows inserted, claimed and settled per repetition of `writes`. */
const writeBatch = 20_000;
const clock = createRealClock();
const root = mkdtempSync(join(dirArg ?? tmpdir(), "iglo-due-kind-"));
const latest = Math.max(...productionMigrations.map((migration) => migration.version));
const dueKind = must(
  productionMigrations.find((migration) => migration.version === 34),
  "migration 0034",
);

type Database = ReturnType<typeof openDatabase>;
const ms = (start: number) => performance.now() - start;
const round = (value: number) => Math.round(value * 1000) / 1000;
const quantile = (values: Array<number>, q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
};
const median = (values: Array<number>) => quantile(values, 0.5);

/** 5,000 subscribers, then `history` settled sends of both kinds over 300 days. */
function populate(db: Database) {
  db.transaction(() => {
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
       INSERT INTO subscribers (uuid, email, name)
       SELECT 'sub-' || i, 'subscriber' || i || '@example.test', 'Subscriber ' || i FROM n`,
    );
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO sends (uuid, source, kind, subscriber_id, to_email, status, smtp_message_id,
         created_at, sent_at)
       SELECT 'seed-' || i, 'tx',
         CASE WHEN i % 3 = 0 THEN 'marketing' ELSE 'transactional' END,
         1 + i % 5000, 'subscriber' || (1 + i % 5000) || '@example.test', 'sent', 'smtp-' || i,
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || (i % 300) || ' days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || (i % 300) || ' days')
       FROM n`,
      [history],
    );
  })();
}

/** `count` queued rows of `kind`, with payloads, in one transaction. */
function enqueue(
  db: Database,
  kind: SendKind,
  count: number,
  tag: string,
  payloads: Array<Buffer>,
) {
  const insert = db.query(
    `INSERT INTO sends (uuid, source, kind, subscriber_id, to_email, status, smtp_message_id,
       payload, created_at)
     VALUES (?1, 'tx', ?2, ?3, ?4, 'queued', ?5, ?6, ?7)`,
  );
  const now = clock.now().toISOString();
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const subscriber = 1 + (i % 5000);
      insert.run(
        `${tag}-${i}`,
        kind,
        subscriber,
        `subscriber${subscriber}@example.test`,
        `${tag}-${i}`,
        payloads[subscriber - 1]!,
        now,
      );
    }
  })();
}

function measure(withIndex: boolean) {
  const dataDir = join(root, withIndex ? "with-index" : "without-index");
  const db = openDatabase(dataDir);
  try {
    runMigrations(db, dataDir, clock, productionMigrations);
    if (!withIndex) {
      db.run("DROP INDEX idx_sends_due_kind");
    }
    populate(db);
    const payloads = Array.from({ length: 5000 }, (_, k) =>
      Buffer.from(
        encodePayload(
          {
            from: "Measure <noreply@measure.test>",
            to: [`subscriber${k + 1}@example.test`],
            subject: "Measure",
            contentType: "plain",
            body: new TextEncoder().encode("Measure"),
          },
          `sub-${k + 1}`,
        ),
      ),
    );
    const journal = createSends({
      db,
      clock,
      subscribers: createSubscriberStore(db, clock, createListReferences(db)),
      rootUrl: () => "http://measure.test",
    });
    const accepted: Outcome = {
      messageId: "measure",
      status: "accepted",
      stage: "smtp-complete",
      accepted: [],
      rejected: [],
    };
    const lease = () => new Date(clock.now().getTime() + 60_000);

    /** Claims of `kind` with `backlog` queued rows of the other kind waiting, 10 rows each. */
    const claimBehind = (kind: SendKind, other: SendKind, rep: number) => {
      enqueue(db, other, backlog, `backlog-${kind}-${rep}`, payloads);
      enqueue(db, kind, claims * outboxBatch, `claim-${kind}-${rep}`, payloads);
      const times: Array<number> = [];
      let claimed = 0;
      for (let i = 0; i < claims; i++) {
        const start = performance.now();
        const rows = writeTransaction(db, () =>
          journal.claimBatch(clock.now(), lease(), outboxBatch, kind),
        );
        times.push(ms(start));
        claimed += rows.length;
      }
      if (claimed !== claims * outboxBatch) {
        throw new Error(`claimed ${claimed} ${kind} rows of ${claims * outboxBatch}`);
      }
      // The claimed rows and the backlog leave the queue, so the next repetition starts the same.
      db.run(
        "UPDATE sends SET status = 'sent', claimed_until = NULL WHERE status IN ('queued', 'sending')",
      );
      return times;
    };

    const timings = {
      txBehindMarketing: [] as Array<number>,
      marketingBehindTx: [] as Array<number>,
      insert: [] as Array<number>,
      claimBatch: [] as Array<number>,
      finishAll: [] as Array<number>,
    };
    for (let rep = 0; rep < repetitions; rep++) {
      timings.txBehindMarketing.push(...claimBehind("transactional", "marketing", rep));
      timings.marketingBehindTx.push(...claimBehind("marketing", "transactional", rep));

      const insertStart = performance.now();
      enqueue(db, "transactional", writeBatch, `write-${rep}`, payloads);
      timings.insert.push(ms(insertStart));
      const claimed: Array<Array<Claimed>> = [];
      const claimStart = performance.now();
      for (;;) {
        const rows = writeTransaction(db, () =>
          journal.claimBatch(clock.now(), lease(), outboxBatch, "transactional"),
        );
        if (rows.length === 0) {
          break;
        }
        claimed.push(rows);
      }
      timings.claimBatch.push(ms(claimStart));
      const settleStart = performance.now();
      for (const rows of claimed) {
        journal.finishAll(rows.map(({ row }) => ({ row, outcome: accepted })));
      }
      timings.finishAll.push(ms(settleStart));
    }

    let migration: { ms: number; growthMB: number } | null = null;
    if (!withIndex) {
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      const before = statSync(join(dataDir, "iglo-email.db")).size;
      const start = performance.now();
      db.exec(dueKind.sql);
      const took = ms(start);
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      const after = statSync(join(dataDir, "iglo-email.db")).size;
      migration = { ms: Math.round(took), growthMB: round((after - before) / 1e6) };
    }
    const plan = (kind: SendKind) =>
      db
        .query<{ detail: string }, [string, string]>(
          `EXPLAIN QUERY PLAN SELECT min(id) FROM sends WHERE status='queued' AND kind=?2 AND next_attempt_at IS NULL`,
        )
        .all(clock.now().toISOString(), kind)
        .map((row) => row.detail)
        .join(" | ");
    return {
      index: withIndex,
      claims: {
        txBehindMarketing: {
          p50: median(timings.txBehindMarketing),
          p99: quantile(timings.txBehindMarketing, 0.99),
        },
        marketingBehindTx: {
          p50: median(timings.marketingBehindTx),
          p99: quantile(timings.marketingBehindTx, 0.99),
        },
      },
      writes: {
        insert: median(timings.insert),
        claimBatch: median(timings.claimBatch),
        finishAll: median(timings.finishAll),
      },
      migration,
      plan: withIndex ? plan("transactional") : null,
    };
  } finally {
    db.close(true);
  }
}

try {
  const load = (await Bun.file("/proc/loadavg").text()).split(" ")[0];
  const results = [false, true].map((withIndex) => measure(withIndex));
  console.log(
    JSON.stringify({ schema: latest, history, backlog, repetitions, root, load, results }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
