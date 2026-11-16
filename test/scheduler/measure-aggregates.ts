// Event aggregates in one sequence decision (docs/perf/B85-aggregates.md, D100): one subscriber
// with 1,000, 10,000 and 100,000 events in the step's window, each function alone and ten
// aggregates together, read by the same reader the scheduler calls. At 100,000 events every read
// is over the per-aggregate limit, so the decision is measured as the skip it becomes, and a
// worst case is measured too: nine aggregates that each read exactly the limit, then one over it.
// Equal noise for another subscriber sits beside them, so the subscriber-and-name index is what
// bounds each read. Generated data in a temporary directory. Run with
// `bun test/scheduler/measure-aggregates.ts [repetitions]`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { AGGREGATE_LIMIT, createEventAggregates, type Aggregate } from "@/events/aggregate";

const repetitions = Number(process.argv[2] ?? 5);
const sizes = [1_000, AGGREGATE_LIMIT, 100_000];
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

/**
 * Nine aggregates that each match exactly the limit (the newest 10,000 events, inside a window of
 * 10,001 seconds), then one over it: the decision reads all nine and stops at the tenth.
 */
const worst: Record<string, Aggregate> = Object.fromEntries([
  ...Array.from({ length: 9 }, (_, i) => [
    `within_${i}`,
    { event: "download_finished", since: "PT10001S", fn: "sum", field: "data.items" } as Aggregate,
  ]),
  ["over", { event: "download_finished", since: "P30D", fn: "count" } as Aggregate],
]);

/**
 * Ten counts over the same window, each with a `where` that matches nothing. The limit counts the
 * window's events, not the matching ones, so at 100,000 events the first read is refused and the
 * decision stops there; at the limit all ten read 10,000 events and total zero.
 */
const whereMiss: Record<string, Aggregate> = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [
    `miss_${i}`,
    {
      event: "download_finished",
      since: "P30D",
      fn: "count",
      where: { "data.kind": `none${i}` },
    } as Aggregate,
  ]),
);

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
    const check = (specs: Record<string, Aggregate>) => reader.evaluate(specs, context);
    const values: Record<string, number> = {};
    if (size <= AGGREGATE_LIMIT) {
      // Totals must match the data generated above, or the timings measure a wrong answer.
      const out = check({ ...single, ...ten });
      if (!out.ok) throw new Error(`aggregate failed at ${size}`);
      Object.assign(values, out.values);
      if (values.count !== size || values.sum !== expectedSum || values.distinct !== sources.size)
        throw new Error(`unexpected totals at ${size}: ${JSON.stringify(values)}`);
      if (values.where !== size / 2 || values.sum_bulk !== expectedBulkSum)
        throw new Error(`unexpected filtered totals at ${size}`);
      const missed = check(whereMiss);
      if (!missed.ok || Object.values(missed.values).some((n) => n !== 0))
        throw new Error(`unexpected where misses at ${size}`);
    } else {
      const refused = check(whereMiss);
      if (refused.ok || !("limit" in refused))
        throw new Error(`expected the where misses to hit the limit at ${size}`);
      // Every download_finished aggregate matches all 100,000 events and is refused with no total,
      // whatever its function. count_actions matches one in ten, exactly the limit: it is complete.
      for (const [name, spec] of Object.entries({ ...single, ...ten })) {
        const out = check({ [name]: spec });
        if (spec.event === "download_finished") {
          if (out.ok || !("limit" in out))
            throw new Error(`expected the limit at ${size}: ${name}`);
        } else if (!out.ok || out.values[name] !== size / 10)
          throw new Error(`unexpected ${name} at ${size}`);
      }
    }

    const perFunction: Record<string, number> = {};
    for (const [name, spec] of Object.entries(single))
      perFunction[name] = median(() => check({ [name]: spec }));
    const tenMs = median(() => check(ten));
    const whereMissMs = median(() => check(whereMiss));
    const result: Record<string, unknown> = {
      events: size,
      noiseEvents: size,
      perFunctionMs: perFunction,
      tenAggregatesMs: tenMs,
      tenWhereMissesMs: whereMissMs,
      values,
    };
    if (size > AGGREGATE_LIMIT) {
      const out = check(worst);
      if (out.ok || !("limit" in out)) throw new Error(`expected the worst case to hit the limit`);
      result.worstCaseMs = median(() => check(worst));
    }
    results.push(result);
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
