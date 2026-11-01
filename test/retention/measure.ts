// Serial measurements for docs/perf/B2-retention.md; opt-in, not a CI threshold. A generated
// backlog of old sessions, finished deliveries and finished sends drains through the production
// retention loops while a send is written every 20 ms on the same thread, as the server does.
// Usage: bun test/retention/measure.ts [rowsPerTable] [sends] [idleSeconds] [purgeSeconds]
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRealClock, type Clock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { writeTransaction } from "@/db/transaction";
import { createListReferences } from "@/lists/references";
import { PURGE_INTERVAL_MS, startPurge, type Purge } from "@/loops/purge";
import { encodePayload } from "@/messaging/payload";
import { createSendCompaction } from "@/messaging/retention";
import { createSends } from "@/messaging/sends";
import { createRoles } from "@/roles/roles";
import { createSubscriberStore } from "@/subscribers/store";
import { createUserStore } from "@/users/store";
import { createWebhookStore } from "@/webhooks/store";
import retentionSql from "@/migrations/0014_retention.sql" with { type: "text" };

const repository = resolve(import.meta.dir, "../..");
const rows = Number(process.argv[2] ?? 1_000_000);
const sendRows = Number(process.argv[3] ?? 100_000);
const baselineSeconds = Number(process.argv[4] ?? 20);
const purgeSeconds = Number(process.argv[5] ?? 60);
const output = join(repository, "docs/perf/B2-results.jsonl");
const base = join(repository, "upstream/measurements");
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, "b2-"));
const day = 86_400_000;
const real = createRealClock();
const started = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const record = (entry: object) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }, (_key, value) =>
    typeof value === "bigint" ? Number(value) : value,
  );
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

const db = openDatabase(directory);
runMigrations(db, directory, real, productionMigrations.slice(0, 13));
const links = () => crypto.randomUUID();
/** A newsletter-sized HTML message with three tracked links, as `encodePayload` stores it. */
function payload(uuid: string) {
  const anchor = () =>
    `<a href="https://mail.example.test/m/${uuid}/link/${links()}">Read more</a>`;
  const paragraph =
    "<p>" + "Lorem ipsum dolor sit amet, consectetur adipiscing. ".repeat(12) + "</p>";
  const body = `<html><body>${paragraph.repeat(30)}${anchor()}${anchor()}${anchor()}</body></html>`;
  return encodePayload(
    {
      from: "News <news@example.test>",
      to: ["person@example.test"],
      subject: "Monthly newsletter",
      contentType: "html",
      body: new TextEncoder().encode(body),
      altBody: new TextEncoder().encode(paragraph),
      headers: {},
      attachments: [],
    } as never,
    null,
  );
}

function seed() {
  const at = Date.now();
  const age = (i: number) => iso(started - (60 + (i % 40)) * day);
  const inserts = {
    sessions: db.query("INSERT INTO sessions(id, data, created_at) VALUES (?, ?, ?)"),
    deliveries: db.query(
      `INSERT INTO webhook_deliveries (uuid, webhook_id, event, payload, status, attempts, created_at, updated_at)
       VALUES (?, 1, 'send.failed', ?, ?, 1, ?, ?)`,
    ),
    sends: db.query(
      `INSERT INTO sends(uuid, source, kind, to_email, status, smtp_message_id, payload, created_at, sent_at)
       VALUES (?, 'tx', 'transactional', 'person@example.test', 'sent', ?, ?, ?, ?)`,
    ),
  };
  db.run(
    `INSERT INTO webhooks (id, url, secret, events, enabled, created_at, updated_at)
     VALUES (1, 'http://r.test/', 'secret', '["send.failed"]', 0, '${iso(started)}', '${iso(started)}')`,
  );
  const body = JSON.stringify({
    subscriber: { id: 1, uuid: "u", email: "", external_id: null },
    list_ids: [1, 2, 3],
    pad: "x".repeat(400),
  });
  const batches = (count: number, size: number, one: (i: number) => void) => {
    for (let i = 0; i < count; i += size)
      writeTransaction(db, () => {
        for (let j = i; j < Math.min(count, i + size); j++) one(j);
      });
  };
  batches(rows, 20_000, (i) => {
    const old = age(i);
    inserts.sessions.run(
      crypto.randomUUID(),
      JSON.stringify({
        user_id: "1",
        csrf: "c".repeat(43),
        expires_at: Date.parse(old) + 7 * day,
      }),
      old,
    );
    inserts.deliveries.run(crypto.randomUUID(), body, i % 10 ? "delivered" : "failed", old, old);
  });
  batches(sendRows, 5_000, (i) => {
    const uuid = crypto.randomUUID();
    const old = age(i);
    inserts.sends.run(uuid, `<${uuid}@x>`, payload(uuid), old, old);
  });
  // Rows a pass must leave, and rows that keep the tables from draining to nothing.
  batches(1000, 1000, (i) => {
    inserts.sessions.run(
      `valid-${i}`,
      JSON.stringify({
        user_id: "1",
        csrf: "c".repeat(43),
        expires_at: started + 90 * day,
      }),
      iso(started),
    );
  });
  for (const insert of Object.values(inserts)) insert.finalize();
  return (Date.now() - at) / 1000;
}

const seconds = seed();
const size = () => {
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const pages = (name: string) =>
    Number((db.query(`PRAGMA ${name}`).get() as Record<string, bigint>)[name]);
  return {
    fileMiB: +(statSync(join(directory, "iglo-email.db")).size / 2 ** 20).toFixed(1),
    freeMiB: +((pages("freelist_count") * pages("page_size")) / 2 ** 20).toFixed(1),
  };
};
const sizeRow = (where: string) =>
  db
    .query(
      `SELECT count(*) AS rows, avg(octet_length(payload)) AS payload, max(octet_length(payload)) AS max_payload,
        avg(coalesce(octet_length(tracked_links), 0)) AS links FROM sends WHERE ${where}`,
    )
    .get();
db.run("ALTER TABLE sends ADD COLUMN tracked_links TEXT");
record({
  step: "seeded",
  rows,
  sendRows,
  seconds,
  ...size(),
  sends: sizeRow("1"),
});
db.run("ALTER TABLE sends DROP COLUMN tracked_links");

// The migration on this history, split from the writes it later adds.
const migrate = performance.now();
db.transaction(() => db.run(retentionSql))();
record({ step: "migration", ms: +(performance.now() - migrate).toFixed(0) });
db.run("PRAGMA user_version = 14");

const lists = createListReferences(db);
const roles = createRoles(db, lists);
const users = createUserStore(db, real, roles);
const webhooks = createWebhookStore(db, real);
const subscribers = createSubscriberStore(db, real, lists);
const sends = createSends({
  db,
  clock: real,
  subscribers,
  rootUrl: () => "http://mail.example.test",
});
const message = () => ({
  from: "News <news@example.test>",
  to: ["person@example.test"],
  subject: "Hello",
  contentType: "html" as const,
  body: new TextEncoder().encode(`<p>${"x".repeat(4000)}</p>`),
  headers: {},
  attachments: [],
});

/** One message every 20 ms: journal it, claim it, record the outcome, three short commits. */
async function writer(until: () => boolean) {
  const whole: number[] = [];
  const lateness: number[] = [];
  let next = performance.now();
  while (!until()) {
    const due = (next += 20);
    await Bun.sleep(Math.max(0, due - performance.now()));
    const begin = performance.now();
    lateness.push(begin - due);
    sends.enqueue({
      source: "tx",
      kind: "transactional",
      message: message(),
    } as never);
    const claimed = writeTransaction(db, () => {
      const time = new Date();
      return sends.claimBatch(time, new Date(time.getTime() + 60_000), 1);
    });
    sends.finishAll(
      claimed.map(({ row }) => ({
        row,
        outcome: { status: "accepted", rejected: [] } as never,
      })),
    );
    whole.push(performance.now() - due);
  }
  return { send: stats(whole), lateness: stats(lateness) };
}
/** Every pass of one loop: the time from a yield's end to the next yield, and the count left. */
function timed(now: () => Date) {
  const passes: number[] = [];
  let begin = performance.now();
  let idle = false;
  const clock: Clock = {
    now,
    sleep(milliseconds, signal) {
      passes.push(performance.now() - begin);
      if (milliseconds >= PURGE_INTERVAL_MS) idle = true;
      return real.sleep(milliseconds, signal).then(() => {
        begin = performance.now();
      });
    },
  };
  return { clock, passes, isIdle: () => idle };
}
const logger = { error: (error: unknown) => console.error(error) };
const owners: Record<string, Purge> = {
  sessions: users.purgeSessions,
  deliveries: webhooks.purge,
  sends: createSendCompaction(db),
};
const count = {
  sessions: () => db.query("SELECT count(*) AS n FROM sessions").get() as { n: bigint },
  deliveries: () =>
    db.query("SELECT count(*) AS n FROM webhook_deliveries").get() as {
      n: bigint;
    },
  sends: () =>
    db
      .query(
        `SELECT count(*) AS n FROM sends INDEXED BY idx_sends_compactable
           WHERE payload IS NOT NULL AND status IN ('sent','failed','skipped','unknown')
             AND created_at < '${iso(started)}'`,
      )
      .get() as { n: bigint },
};
async function drain(step: string, names: (keyof typeof count)[]) {
  const before = names.map((name) => Number(count[name]().n));
  const at = performance.now();
  const time = timed(() => new Date());
  const loop = startPurge({
    db,
    clock: time.clock,
    logger,
    purges: names.map((name) => owners[name]!),
  });
  const end = performance.now() + purgeSeconds * 1000;
  const latency = await writer(() => performance.now() > end || time.isIdle());
  const ms = performance.now() - at;
  await loop.stop();
  names.forEach((name, i) => {
    const taken = before[i]! - Number(count[name]().n);
    record({
      step,
      owner: name,
      rows: taken,
      seconds: +(ms / 1000).toFixed(1),
      left: Number(count[name]().n),
      rowsPerSecond: Math.round(taken / (ms / 1000)),
    });
  });
  record({ step, pass: stats(time.passes), ...latency, ...size() });
}

// Before: this schema without the three indexes, no purge. After: with them, no purge.
const indexes = ["idx_sends_compactable", "idx_webhook_deliveries_finished", "idx_sessions_expiry"];
const quiet = async (step: string) => {
  const end = performance.now() + baselineSeconds * 1000;
  record({ step, ...(await writer(() => performance.now() > end)) });
};
await quiet("idle with new indexes");
await real.sleep(500);
const saved = db
  .query(`SELECT sql FROM sqlite_master WHERE name IN (${indexes.map(() => "?").join()})`)
  .all(...indexes) as { sql: string }[];
for (const name of indexes) db.run(`DROP INDEX ${name}`);
await quiet("idle before (no new indexes)");
for (const { sql } of saved) db.run(sql);
await quiet("idle with new indexes, again");

// Each owner alone for a fixed time over its backlog, then all three at once, as the first start
// of an upgraded server does.
await drain("sessions alone", ["sessions"]);
await drain("deliveries alone", ["deliveries"]);
await drain("sends alone", ["sends"]);
await drain("first start, all three", ["sessions", "deliveries", "sends"]);
await quiet("idle after");
record({ step: "end", sends: sizeRow("1"), ...size() });

users.close();
webhooks.close();
subscribers.close();
roles.close();
lists.close();
db.close();
rmSync(directory, { recursive: true, force: true });
