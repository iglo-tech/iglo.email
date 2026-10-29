// Bounded M5.2 measurement: compile and evaluate typical conditions on a synthetic
// 100,000-subscriber / 1,000,000-event database, with EXPLAIN QUERY PLAN for each statement.
// Prints JSON lines. The database lives in TMPDIR and is removed at the end.
// Usage: TMPDIR=/var/tmp bun test/conditions/measure.ts [subscribers] [events]
import { statSync } from "node:fs";
import { compile } from "@/conditions/compile";
import type { Condition } from "@/conditions/types";
import { validate } from "@/conditions/validate";
import { conditionsFixture } from "@/test/conditions/fixture";

const subscribers = Number(process.argv[2] ?? 100_000);
const events = Number(process.argv[3] ?? 1_000_000);
const f = await conditionsFixture({ timeoutMs: 10_000 });
const report = (name: string, values: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ name, ...values })}\n`);
const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
const round = (ms: number) => Math.round(ms * 1000) / 1000;
let peak = 0;
const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);

try {
  const started = performance.now();
  for (const name of ["one", "two", "three"]) f.addList(name);
  f.db.run("BEGIN");
  f.db.run(
    `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?)
     INSERT INTO subscribers (uuid, email, name, attribs, status)
     SELECT lower(hex(randomblob(16))), 'm' || x || '@example.test', 'M ' || x,
       json_object('plan', CASE x % 3 WHEN 0 THEN 'subscription' WHEN 1 THEN 'prepaid' ELSE 'free' END,
                   'credits', x % 200, 'country', CASE x % 4 WHEN 0 THEN 'PL' WHEN 1 THEN 'DE' ELSE 'US' END),
       CASE WHEN x % 50 = 0 THEN 'disabled' ELSE 'enabled' END
     FROM c`,
    [subscribers],
  );
  f.db.run(
    `INSERT INTO subscriber_lists (subscriber_id, list_id, status)
     SELECT id, 1 + id % 3, CASE id % 5 WHEN 0 THEN 'unsubscribed' WHEN 1 THEN 'unconfirmed' ELSE 'confirmed' END
     FROM subscribers WHERE id % 2 = 0`,
  );
  // About ten events per subscriber over the 60 days before the clock's now.
  f.db.run(
    `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?)
     INSERT INTO events (subscriber_id, name, data, occurred_at, created_at)
     SELECT 1 + (x * 7919) % ${subscribers}, 'e' || (x % 5),
       json_object('source', CASE x % 3 WHEN 0 THEN 'mcp' WHEN 1 THEN 'web' ELSE 'app' END, 'n', x % 7),
       strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || ((x * 2654435761) % 5184000) || ' seconds'),
       strftime('%Y-%m-%dT%H:%M:%fZ', ?)
     FROM c`,
    [events, f.clock.now().toISOString(), f.clock.now().toISOString()],
  );
  f.db.run("COMMIT");
  f.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  report("seed", {
    subscribers,
    events,
    ms: Math.round(performance.now() - started),
    dbMB: mb(statSync(f.db.filename).size),
  });

  const now = f.clock.now();
  const day = 86_400_000;
  const typical: Record<string, unknown> = {
    attr_eq: { attr: "plan", op: "eq", value: "subscription" },
    attr_in: { attr: "country", op: "in", value: ["PL", "DE", "CZ"] },
    status: { attr: "status", op: "eq", value: "enabled" },
    list: { list: 2, status: ["confirmed"] },
    no_event_since_trigger: { not: { event: "e1", since: "trigger" } },
    event_where_count: {
      event: "e2",
      since: "P30D",
      where: { "data.source": "mcp" },
      count: { gte: 2 },
    },
    onboarding: {
      all: [
        { attr: "plan", op: "ne", value: "subscription" },
        { attr: "credits", op: "lt", value: 100 },
        { list: 2 },
        { not: { event: "e3", since: "enrollment" } },
        {
          any: [
            { event: "e4", since: "last_step" },
            { attr: "country", op: "eq", value: "PL" },
          ],
        },
      ],
    },
    sql: { sql: "json_extract(subscribers.attribs, '$.credits') < 100" },
    sql_mixed: {
      all: [{ sql: "subscribers.attribs->>'country' = 'PL'" }, { event: "e1", since: "P60D" }],
    },
  };
  for (const [name, condition] of Object.entries(typical)) {
    const checked = validate(condition, { canUseSql: true });
    if (!checked.ok) throw new Error(`${name}: ${JSON.stringify(checked.errors)}`);
    const valid: Condition = checked.condition;
    const compileRuns = 10_000;
    let t = performance.now();
    for (let i = 0; i < compileRuns; i++) validate(condition, { canUseSql: true });
    const validateUs = ((performance.now() - t) / compileRuns) * 1000;
    t = performance.now();
    for (let i = 0; i < compileRuns; i++) compile(valid);
    const compileUs = ((performance.now() - t) / compileRuns) * 1000;
    const compiled = compile(valid);
    const plan = (
      f.readonly
        .query(`EXPLAIN QUERY PLAN ${compiled.sql}`)
        .all(
          ...compiled.params.map((p) =>
            typeof p === "object" ? (p.slot === "after" ? "" : 1) : p,
          ),
        ) as {
        detail: string;
      }[]
    ).map((row) => row.detail);
    const runs = compiled.fragments.length ? 50 : 2_000;
    const samples: number[] = [];
    let trues = 0;
    Bun.gc(true);
    peak = process.memoryUsage().rss;
    const rssBefore = peak;
    t = performance.now();
    for (let i = 0; i < runs; i++) {
      const id = BigInt(1 + ((i * 104729) % subscribers));
      const s = performance.now();
      const result = await f.evaluator.evaluate(condition, {
        subscriberId: id,
        triggerAt: new Date(now.getTime() - 20 * day),
        enrolledAt: new Date(now.getTime() - 19 * day),
        lastStepAt: new Date(now.getTime() - 10 * day),
        now,
      });
      samples.push(performance.now() - s);
      if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
      if (result.value) trues++;
    }
    samples.sort((a, b) => a - b);
    report(name, {
      validateUs: round(validateUs),
      compileUs: round(compileUs),
      runs,
      trues,
      evalMsP50: round(samples[Math.floor(runs / 2)]!),
      evalMsP95: round(samples[Math.floor(runs * 0.95)]!),
      evalMsMax: round(samples.at(-1)!),
      totalMs: Math.round(performance.now() - t),
      rssBeforeMB: mb(rssBefore),
      rssPeakMB: mb(peak),
      child: compiled.fragments.length > 0,
      plan,
    });
  }
} finally {
  clearInterval(sampler);
  await f.close();
}
