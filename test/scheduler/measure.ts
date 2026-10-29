// Scheduler throughput for 10,000 due enrollments, and outbox send load with and without the
// scheduler working at the same time (docs/perf/M5.4-scheduler.md). Generated data in
// temporary directories, a loopback SMTP sink, the production owners from runtime.ts.
// Run with `bun run scheduler:measure [enrollments] [repetitions]`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { seed, startRuntime } from "@/test/scheduler/runtime";
import { startSink } from "@/test/tx/sink";

const enrollments = Number(process.argv[2] ?? 10_000);
const repetitions = Number(process.argv[3] ?? 3);
const sendLoad = 2_000;
const clock = createRealClock();
const sink = await startSink({});

const count = (db: { query: Function }, sql: string) =>
  Number((db.query(sql).get() as { n: bigint }).n);
async function until(check: () => boolean, label: string, ms = 600_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(10);
  }
}
const rss = () => Math.round(process.memoryUsage().rss / 1048576);

/** Seed with no loops running, so timing starts when the scheduler starts. */
async function prepare(dir: string, n: number, kind: "transactional" | "marketing") {
  const r = startRuntime({
    dataDir: dir,
    smtpPort: sink.port,
    clock,
    outbox: false,
    scheduler: false,
  });
  seed(r.db, r.enrollments, n, [{ wait: "PT0S", kind }]);
  await r.close();
}

async function schedulerRun(kind: "transactional" | "marketing") {
  const dir = mkdtempSync(join(tmpdir(), "iglo-scheduler-measure-"));
  try {
    await prepare(dir, enrollments, kind);
    let peak = rss();
    const started = performance.now();
    const r = startRuntime({ dataDir: dir, smtpPort: sink.port, clock, outbox: false });
    await until(() => {
      peak = Math.max(peak, rss());
      return (
        count(r.db, "SELECT count(*) AS n FROM enrollments WHERE status = 'completed'") ===
        enrollments
      );
    }, "scheduler");
    const seconds = (performance.now() - started) / 1000;
    const queued = count(r.db, "SELECT count(*) AS n FROM sends WHERE status = 'queued'");
    if (queued !== enrollments || r.errors.length) throw new Error("unexpected scheduler result");
    await r.close();
    return { seconds, perSecond: enrollments / seconds, peakRssMiB: peak };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Drain `sendLoad` queued sends; with `busy`, the scheduler processes `enrollments` more. */
async function outboxRun(busy: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "iglo-scheduler-sendload-"));
  try {
    await prepare(dir, sendLoad, "transactional");
    const queue = startRuntime({ dataDir: dir, smtpPort: sink.port, clock, outbox: false });
    await until(
      () => count(queue.db, "SELECT count(*) AS n FROM sends WHERE status = 'queued'") === sendLoad,
      "queue",
    );
    await queue.close();
    if (busy) {
      const more = startRuntime({
        dataDir: dir,
        smtpPort: sink.port,
        clock,
        outbox: false,
        scheduler: false,
      });
      seed(more.db, more.enrollments, enrollments, [{ wait: "PT0S", kind: "transactional" }], "b");
      await more.close();
    }
    const before = sink.messages.length;
    const started = performance.now();
    const r = startRuntime({
      dataDir: dir,
      smtpPort: sink.port,
      clock,
      scheduler: busy,
    });
    await until(
      () =>
        count(
          r.db,
          `SELECT count(*) AS n FROM sends WHERE id <= ${sendLoad} AND status = 'sent'`,
        ) === sendLoad,
      "send load",
    );
    const seconds = (performance.now() - started) / 1000;
    const scheduled = count(
      r.db,
      "SELECT count(*) AS n FROM enrollments WHERE status = 'completed'",
    );
    await r.close();
    if (sink.messages.length - before < sendLoad) throw new Error("missing messages");
    sink.messages.length = 0;
    return {
      seconds,
      perSecond: sendLoad / seconds,
      schedulerCompletedMeanwhile: busy ? scheduled - sendLoad : 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const results: Record<string, unknown[]> = {
  transactional: [],
  marketing: [],
  sendLoadAlone: [],
  sendLoadWithScheduler: [],
};
for (let i = 0; i < repetitions; i++) {
  results.transactional!.push(await schedulerRun("transactional"));
  results.marketing!.push(await schedulerRun("marketing"));
  results.sendLoadAlone!.push(await outboxRun(false));
  results.sendLoadWithScheduler!.push(await outboxRun(true));
}
await sink.close();
console.log(
  JSON.stringify(
    { bun: Bun.version, enrollments, sendLoad, repetitions, results },
    (_, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v),
    2,
  ),
);
