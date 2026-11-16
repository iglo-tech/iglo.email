// Event aggregates in one sequence decision (docs/perf/B85-aggregates.md, D100): one subscriber
// with 1,000, 10,000 and 100,000 events in the step's window, each function alone and ten
// aggregates together, read by the same reader the scheduler calls. Equal noise for another
// subscriber sits beside them, so the subscriber-and-name index is what bounds each read. Generated
// data in a temporary directory. Run with `bun test/scheduler/measure-aggregates.ts [repetitions]`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createEventAggregates, type Aggregate } from "@/events/aggregate";

const repetitions = Number(process.argv[2] ?? 5);
const sizes = [1_000, 10_000, 100_000];
const clock = createRealClock();
const now = Date.parse("2026-11-16T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** One evaluation's median milliseconds over `repetitions` runs, after one warm-up. */
function median(run: () => void): number {
  run();
  const times: number[] = [];
  for (let i = 0; i < repetitions; i++) {
    const started = performance.now();
    run();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

const single: Record<string, Aggregate> = {
  count: { event: "download_finished", since: "P30D", fn: "count" },
  sum: { event: "download_finished", since: "P30D", fn: "sum", field: "data.items" },
  distinct: { event: "download_finished", since: "P30D", fn: "distinct", field: "data.source_id" },
  where: {
    event: "download_finished",
    since: "P30D",
    fn: "count",
    where: { "data.kind": "bulk" },
  },
};
const ten: Record<string, Aggregate> = {
  sum_items: { event: "download_finished", since: "P30D", fn: "sum", field: "data.items" },
  sum_bulk: {
    event: "download_finished",
    since: "P30D",
    fn: "sum",
    field: "data.items",
    where: { "data.kind": "bulk" },
  },
  sum_all: { event: "download_finished", fn: "sum", field: "data.items" },
  sum_since_trigger: {
    event: "download_finished",
    since: "trigger",
    fn: "sum",
    field: "data.items",
  },
  sum_enrollment: {
    event: "download_finished",
    since: "enrollment",
    fn: "sum",
    field: "data.items",
  },
  distinct_sources: {
    event: "download_finished",
    since: "P30D",
    fn: "distinct",
    field: "data.source_id",
  },
  distinct_kinds: { event: "download_finished", since: "P30D", fn: "distinct", field: "data.kind" },
  distinct_items: {
    event: "download_finished",
    since: "P30D",
    fn: "distinct",
    field: "data.items",
  },
  count_bulk: {
    event: "download_finished",
    since: "P30D",
    fn: "count",
    where: { "data.kind": "bulk" },
  },
  count_actions: { event: "assistant_action", since: "P30D", fn: "count" },
};

const results: Record<string, unknown>[] = [];
for (const size of sizes) {
  const dir = mkdtempSync(join(tmpdir(), "iglo-aggregates-measure-"));
  try {
    const db = openDatabase(dir);
    runMigrations(db, dir, clock, productionMigrations);
    const target = db
      .query<{ id: bigint }, [string]>(
        "INSERT INTO subscribers (uuid, email, name) VALUES (?, 'target@example.test', 'Target') RETURNING id",
      )
      .get(crypto.randomUUID())!.id;
    const noise = db
      .query<{ id: bigint }, [string]>(
        "INSERT INTO subscribers (uuid, email, name) VALUES (?, 'noise@example.test', 'Noise') RETURNING id",
      )
      .get(crypto.randomUUID())!.id;
    const insert = db.prepare(
      "INSERT INTO events (subscriber_id, name, data, occurred_at, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    // Every event is inside the 30 days before `now` and after the trigger at `now - 30 days + 1 s`.
    let expectedSum = 0,
      expectedBulkSum = 0;
    const sources = new Set<string>();
    db.transaction(() => {
      for (let i = 0; i < size; i++) {
        const items = (i % 7) + 1;
        const kind = i % 2 ? "bulk" : "single";
        const source = `s${i % 50}`;
        expectedSum += items;
        if (kind === "bulk") expectedBulkSum += items;
        sources.add(source);
        insert.run(
          target,
          "download_finished",
          JSON.stringify({ items, source_id: source, kind }),
          iso(now - (size - i) * 1000),
          iso(now),
        );
        insert.run(
          noise,
          "download_finished",
          JSON.stringify({ items: 1000, source_id: `n${i}`, kind: "bulk" }),
          iso(now - (size - i) * 1000),
          iso(now),
        );
        if (i % 10 === 0)
          insert.run(target, "assistant_action", "{}", iso(now - (size - i) * 1000), iso(now));
      }
    })();
    const reader = createEventAggregates(db);
    const context = {
      subscriberId: target,
      triggerAt: iso(now - 30 * 86_400_000 + 1000),
      enrolledAt: iso(now - 30 * 86_400_000 + 1000),
      lastStepAt: null,
      now: new Date(now),
    };
    const check = (specs: Record<string, Aggregate>) => {
      const out = reader.evaluate(specs, context);
      if (!out.ok) throw new Error(`aggregate failed: ${out.error.message}`);
      return out.values;
    };
    // Totals must match the data generated above, or the timings measure a wrong answer.
    const values = check({ ...single, ...ten });
    if (values.count !== size || values.sum !== expectedSum || values.distinct !== sources.size)
      throw new Error(`unexpected totals at ${size}: ${JSON.stringify(values)}`);
    if (values.where !== size / 2 || values.sum_bulk !== expectedBulkSum)
      throw new Error(`unexpected filtered totals at ${size}`);

    const perFunction: Record<string, number> = {};
    for (const [name, spec] of Object.entries(single))
      perFunction[name] = median(() => check({ [name]: spec }));
    const tenMs = median(() => check(ten));
    results.push({
      events: size,
      noiseEvents: size,
      perFunctionMs: perFunction,
      tenAggregatesMs: tenMs,
      values,
    });
    db.close(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify(
    { bun: Bun.version, repetitions, results },
    (_, v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v),
    2,
  ),
);
