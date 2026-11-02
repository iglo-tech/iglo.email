// Serial measurement for docs/perf/B6-send-media-safety.md: send lateness while an expired event
// backlog is purged, before (the standalone 500-row loop with no pause, as it was until B6) and
// after (the shared paced loop, D70). One message is journaled, claimed and finished every 20 ms
// on the same thread, as the server does. Opt-in, not a CI threshold.
// Usage: bun test/retention/measure-events.ts [events] [seconds] [idle|before|after]
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { writeTransaction } from "@/db/transaction";
import { createEventPurge } from "@/events/retention";
import { createEventStore } from "@/events/store";
import { createListReferences } from "@/lists/references";
import { startLoop } from "@/loops/loop";
import { startPurge } from "@/loops/purge";
import { createSends } from "@/messaging/sends";
import { createSubscriberStore } from "@/subscribers/store";

const repository = resolve(import.meta.dir, "../..");
const events = Number(process.argv[2] ?? 400_000);
const seconds = Number(process.argv[3] ?? 30);
const output = join(repository, "docs/perf/B6-results.jsonl");
const base = join(repository, "upstream/measurements");
mkdirSync(base, { recursive: true });
const head = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: repository })
  .stdout.toString()
  .trim();
const record = (entry: object) => {
  const line = JSON.stringify({ at: new Date().toISOString(), head, ...entry });
  console.log(line);
  appendFileSync(output, `${line}\n`);
};
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    n: values.length,
    p50: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
    p99: +at(0.99).toFixed(2),
    max: +(sorted.at(-1) ?? 0).toFixed(2),
  };
};
const day = 86_400_000;
const real = createRealClock();

async function run(variant: "idle" | "before" | "after") {
  const directory = mkdtempSync(join(base, "b6-events-"));
  const db = openDatabase(directory);
  runMigrations(db, directory, real, productionMigrations);
  const lists = createListReferences(db);
  const subscribers = createSubscriberStore(db, real, lists);
  const store = createEventStore(db, subscribers, { emailAllowed: () => true });
  const sends = createSends({
    db,
    clock: real,
    subscribers,
    rootUrl: () => "http://mail.example.test",
  });
  const subscriber = subscribers.create(
    { email: "events@example.test", name: "Events" },
    { all: true, ids: [] },
  );
  const old = new Date(Date.now() - 500 * day).toISOString();
  const insert = db.query(
    "INSERT INTO events(subscriber_id, name, data, occurred_at, created_at) VALUES (?, ?, '{\"a\":1}', ?, ?)",
  );
  for (let i = 0; i < events; i += 20_000)
    writeTransaction(db, () => {
      for (let j = i; j < Math.min(events, i + 20_000); j++)
        insert.run(subscriber.id, `event-${j % 50}`, old, old);
    });
  insert.finalize();
  // Let the seeding's checkpoint and file writes finish, so they are not counted as the purge's.
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  await Bun.sleep(5000);
  const left = () => (db.query("SELECT count(*) AS n FROM events").get() as { n: bigint }).n;
  const startCount = Number(left());

  const logger = { error: (error: unknown) => console.error(error) };
  const message = {
    from: "News <news@example.test>",
    to: ["person@example.test"],
    subject: "Hello",
    contentType: "html" as const,
    body: new TextEncoder().encode(`<p>${"x".repeat(4000)}</p>`),
    headers: {},
    attachments: [],
  };
  const started = performance.now();
  const loop =
    variant === "before"
      ? startLoop<bigint>({
          db,
          clock: real,
          logger,
          intervalMs: 3_600_000,
          leaseMs: 1,
          batchSize: 500,
          claim: (now, _lease, batchSize) =>
            store.purge(new Date(now.getTime() - 400 * day), batchSize),
          process: () => {},
        })
      : variant === "after"
        ? startPurge({ db, clock: real, logger, purges: [createEventPurge(store)] })
        : null;
  const lateness: number[] = [];
  const whole: number[] = [];
  const end = started + seconds * 1000;
  let next = performance.now();
  while (performance.now() < end) {
    const due = (next += 20);
    await Bun.sleep(Math.max(0, due - performance.now()));
    const begin = performance.now();
    lateness.push(begin - due);
    sends.enqueue({ source: "tx", kind: "transactional", message } as never);
    const claimed = writeTransaction(db, () => {
      const time = new Date();
      return sends.claimBatch(time, new Date(time.getTime() + 60_000), 1);
    });
    sends.finishAll(
      claimed.map(({ row }) => ({ row, outcome: { status: "accepted", rejected: [] } as never })),
    );
    whole.push(performance.now() - due);
  }
  const elapsed = (performance.now() - started) / 1000;
  await loop?.stop();
  const purged = startCount - Number(left());
  record({
    scenario: `event purge ${variant}`,
    events: startCount,
    purged,
    seconds: +elapsed.toFixed(1),
    rowsPerSecond: Math.round(purged / elapsed),
    lateness: stats(lateness),
    send: stats(whole),
  });
  sends.close();
  store.close();
  subscribers.close();
  lists.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
}

// One variant per process (argv[4]), so one run's heap and page cache do not shape the next.
const only = process.argv[4];
for (const variant of ["idle", "before", "after"] as const)
  if (!only || only === variant) await run(variant);
