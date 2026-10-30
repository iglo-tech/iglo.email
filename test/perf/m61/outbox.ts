// Outbox delivery rate with and without a 10,000-send queued backlog (docs/perf/M6.1-performance.md).
// The production scheduler, outbox and owners from test/scheduler/runtime.ts, as in M5.4, with a
// loopback SMTP sink. The scheduler queues the sequence sends with the outbox stopped; tx sends
// are enqueued through the journal. Then the outbox alone drains the queue while 1 s samples
// count accepted messages. Usage: bun test/perf/m61/outbox.ts [backlog] [repetitions].
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { seed, startRuntime } from "@/test/scheduler/runtime";
import { startSink } from "@/test/tx/sink";
import { measurementBase, memAvailable, record, stats } from "@/test/perf/m61/record";

const backlog = Number(process.argv[2] ?? 10_000);
const repetitions = Number(process.argv[3] ?? 2);
const txCount = 1_000;
const base = measurementBase();
const clock = createRealClock();
const sink = await startSink({});

const count = (db: { query: Function }, sql: string) =>
  Number((db.query(sql).get() as { n: bigint }).n);
async function until(check: () => boolean, label: string, ms = 900_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(5);
  }
}
const rss = () => Math.round(process.memoryUsage().rss / 1048576);

/**
 * Queue `sequence` sequence sends (half transactional, half marketing steps) and `txCount`
 * transactional tx sends after them, then drain with the outbox alone.
 */
async function run(sequence: number) {
  const dir = mkdtempSync(join(base, "m61-outbox-"));
  try {
    if (sequence) {
      const setup = startRuntime({
        dataDir: dir,
        smtpPort: sink.port,
        clock,
        outbox: false,
        scheduler: false,
      });
      seed(setup.db, setup.enrollments, sequence / 2, [{ wait: "PT0S", kind: "transactional" }]);
      seed(setup.db, setup.enrollments, sequence / 2, [{ wait: "PT0S", kind: "marketing" }], "m");
      await setup.close();
      const scheduler = startRuntime({ dataDir: dir, smtpPort: sink.port, clock, outbox: false });
      await until(
        () =>
          count(scheduler.db, "SELECT count(*) AS n FROM sends WHERE status = 'queued'") ===
          sequence,
        "sequence queue",
      );
      await scheduler.close();
    }
    const producer = startRuntime({
      dataDir: dir,
      smtpPort: sink.port,
      clock,
      outbox: false,
      scheduler: false,
    });
    for (let i = 0; i < txCount; i++)
      producer.sends.enqueue({
        source: "tx",
        kind: "transactional",
        message: {
          from: "Measure <noreply@measure.test>",
          to: [`tx${i}@measure.test`],
          subject: `Receipt ${i}`,
          contentType: "plain",
          body: new TextEncoder().encode(`Receipt number ${i}`),
        },
      });
    // The production claim on this queue, rolled back so the drain still starts from it.
    const claimMs: number[] = [];
    for (let i = 0; i < 200; i++) {
      producer.db.run("BEGIN IMMEDIATE");
      const t = performance.now();
      const [row] = producer.sends.claim(clock.now(), new Date(Date.now() + 60_000));
      claimMs.push(performance.now() - t);
      producer.db.run("ROLLBACK");
      if (!row) throw new Error("nothing to claim");
    }
    await producer.close();

    const total = sequence + txCount;
    sink.messages.length = 0;
    let peak = rss();
    const samples: { t: number; delivered: number }[] = [];
    let firstTx = NaN;
    const started = performance.now();
    let at2000 = NaN;
    const r = startRuntime({ dataDir: dir, smtpPort: sink.port, clock, scheduler: false });
    let nextSample = started + 1000;
    await until(() => {
      const now = performance.now();
      peak = Math.max(peak, rss());
      const delivered = sink.messages.length;
      if (now >= nextSample) {
        samples.push({ t: Math.round(now - started), delivered });
        nextSample += 1000;
      }
      if (Number.isNaN(at2000) && delivered >= 2000) at2000 = now;
      if (
        Number.isNaN(firstTx) &&
        sink.messages.some((m, i) => i >= delivered - 50 && m.to[0]!.startsWith("tx"))
      )
        firstTx = now;
      return delivered >= total;
    }, "drain");
    const seconds = (performance.now() - started) / 1000;
    const sent = count(r.db, "SELECT count(*) AS n FROM sends WHERE status = 'sent'");
    const errors = r.errors.length;
    await r.close();
    const tx = sink.messages.filter((m) => m.to[0]!.startsWith("tx")).length;
    sink.messages.length = 0;
    return {
      backlogQueued: sequence,
      txQueued: txCount,
      delivered: total,
      sentRows: sent,
      txDelivered: tx,
      errors,
      seconds: +seconds.toFixed(2),
      overallPerSecond: +(total / seconds).toFixed(1),
      first2000PerSecond: Number.isNaN(at2000)
        ? null
        : +(2000 / ((at2000 - started) / 1000)).toFixed(1),
      txTailPerSecond: Number.isNaN(firstTx)
        ? null
        : +(txCount / ((started + seconds * 1000 - firstTx) / 1000)).toFixed(1),
      claimMs: stats(claimMs),
      peakRssMiB: peak,
      memAvailableMiB: memAvailable(),
      samples,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const label = process.env.M61_LABEL ?? "unlabelled";
for (let i = 0; i < repetitions; i++) {
  record({ scenario: "outbox-no-backlog", label, rep: i + 1, ...(await run(0)) }, false);
  record({ scenario: "outbox-backlog", label, rep: i + 1, ...(await run(backlog)) }, false);
}
await sink.close();
