// B150c (D172) measurement: one event condition and ten aggregates at AGGREGATE_LIMIT, evaluated
// against the real PocketBase 0.40.5 binary through the adapter. Prints JSON lines; the instance
// lives in a temporary directory and is removed at the end. Not a CI threshold.
// Usage: bun test/conditions/measure-source.ts [runs]
import { aggregateOnSource, evaluateOnSource } from "@/conditions/source";
import { AGGREGATE_LIMIT } from "@/events/aggregate";
import type { Aggregate } from "@/events/aggregate";
import { adapter, enableBatch, manyEvents } from "@/test/conditions/source-fixture";
import { startPocketBase } from "@/test/sources/pocketbase";

const runs = Number(process.argv[2] ?? 5);
const report = (name: string, values: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ name, ...values })}\n`);
const round = (ms: number) => Math.round(ms * 10) / 10;
const mb = (bytes: number) => Math.round((bytes / 1_048_576) * 10) / 10;
let peak = 0;
const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
const day = 86_400_000;
const now = Date.now();

const pb = await startPocketBase();
try {
  await enableBatch(pb);
  const user = await pb.user();
  const seeded = performance.now();
  // A window of exactly AGGREGATE_LIMIT records: every aggregate reads all of it.
  await manyEvents(pb, user.id, "view", AGGREGATE_LIMIT, (i) => ({
    at: new Date(now - day - i * 1000),
    data: { items: i % 7, kind: i % 3 === 0 ? "a" : "b", hit: i === 0 },
  }));
  report("seed", { records: AGGREGATE_LIMIT, ms: round(performance.now() - seeded) });
  const source = adapter(pb);
  const context = { externalId: user.id, now: new Date(now) };
  const reads = { source };
  // A count with a `where` the filter narrows and the strict check re-reads: the worst page walk.
  const condition = { event: "view", where: { "data.kind": "a" }, count: { gte: 4000 } } as const;
  const aggregates: Record<string, Aggregate> = Object.fromEntries(
    Array.from({ length: 10 }, (_, i): [string, Aggregate] => [
      `a${i}`,
      i % 3 === 0
        ? { event: "view", fn: "count" }
        : i % 3 === 1
          ? { event: "view", fn: "sum", field: "data.items" }
          : { event: "view", fn: "distinct", field: "data.kind", where: { "data.hit": false } },
    ]),
  );
  for (let run = 0; run < runs; run++) {
    peak = 0;
    let started = performance.now();
    const result = await evaluateOnSource(condition, context, reads);
    report("condition", { run, ok: result.ok, ms: round(performance.now() - started) });
    started = performance.now();
    const totals = await aggregateOnSource(aggregates, context, reads);
    report("ten-aggregates", {
      run,
      ok: totals.ok,
      a0: totals.ok ? totals.values.a0 : null,
      ms: round(performance.now() - started),
      peakRssMb: mb(peak),
    });
  }
} finally {
  clearInterval(sampler);
  await pb.close();
}
