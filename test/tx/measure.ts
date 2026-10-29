// Serial in-process send measurements for docs/perf/M2.3-tx.md; not a CI threshold.
// "Before" is the M2.2 journal producer path (enqueue + outbox loop); "after" is POST /api/tx.
import { createRealClock } from "@/clock";
import { txFixture } from "@/test/tx/fixture";

const N = Number(process.env.TX_MEASURE_N ?? "200");
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2),
    p50: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
  };
};
const rss = () => Math.round(process.memoryUsage().rss / 1048576);
async function drain(f: Awaited<ReturnType<typeof txFixture>>, count: number) {
  const deadline = performance.now() + 120_000;
  while (f.sink.messages.length < count && performance.now() < deadline) await Bun.sleep(1);
  if (f.sink.messages.length < count) throw new Error("drain timeout");
}
const results: Record<string, unknown> = { n: N, bun: Bun.version, rssStartMiB: rss() };

{
  const f = await txFixture({ clock: createRealClock() });
  const started = performance.now();
  const enqueue: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    f.sends.enqueue({
      source: "tx",
      kind: "transactional",
      message: {
        from: "sender@example.test",
        to: [`before-${i}@example.test`],
        subject: `before ${i}`,
        contentType: "html",
        body: Buffer.from(`<p>Order ${i}</p>`),
      },
    });
    enqueue.push(performance.now() - t);
  }
  await drain(f, N);
  results.beforeJournalOutbox = {
    enqueueMs: stats(enqueue),
    deliveredPerSecond: Math.round((N * 1000) / (performance.now() - started)),
  };
  await f.close();
}
{
  const f = await txFixture({ clock: createRealClock() });
  const template = await f.template("<p>Hello {{ subscriber.name }} {{ data.order }}</p>");
  const latencies: number[] = [];
  let started = performance.now();
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    const r = await f.tx({
      subscriber_mode: "external",
      subscriber_emails: [`sync-${i}@example.test`],
      template_id: template,
      data: { order: i },
    });
    if (r.status !== 200 || r.body.data.sends[0].status !== "sent") throw new Error("sync failed");
    latencies.push(performance.now() - t);
  }
  results.afterTxSync = {
    requestMs: stats(latencies),
    sentPerSecond: Math.round((N * 1000) / (performance.now() - started)),
  };
  const asyncLatencies: number[] = [];
  started = performance.now();
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    const r = await f.tx({
      subscriber_emails: [`async-${i}@example.test`],
      template_id: template,
      data: { order: i },
      async: true,
    });
    if (r.status !== 200) throw new Error("async failed");
    asyncLatencies.push(performance.now() - t);
  }
  await drain(f, 2 * N);
  results.afterTxAsync = {
    requestMs: stats(asyncLatencies),
    deliveredPerSecond: Math.round((N * 1000) / (performance.now() - started)),
  };
  const recipients = Array.from({ length: 100 }, (_, i) => `batch-${i}@example.test`);
  let t = performance.now();
  const batch = await f.tx({ subscriber_emails: recipients, template_id: template });
  if (batch.status !== 200) throw new Error("batch failed");
  results.afterTx100RecipientsSyncMs = +(performance.now() - t).toFixed(2);
  const keyed = {
    subscriber_emails: ["idem@example.test"],
    template_id: template,
    idempotency_key: "m",
  };
  await f.tx(keyed);
  const repeats: number[] = [];
  for (let i = 0; i < 50; i++) {
    t = performance.now();
    await f.tx(keyed);
    repeats.push(performance.now() - t);
  }
  results.afterIdempotentRepeatMs = stats(repeats);
  const file = new FormData();
  file.set(
    "data",
    JSON.stringify({ subscriber_emails: ["file@example.test"], template_id: template }),
  );
  file.set("file", new File([new Uint8Array(4 * 1024 * 1024)], "max.bin"));
  t = performance.now();
  const attach = await f.request("/api/tx", {
    method: "POST",
    headers: f.sessionHeaders,
    body: file,
  });
  if (attach.status !== 200) throw new Error("attachment failed");
  results.afterTx4MiBAttachmentMs = +(performance.now() - t).toFixed(2);
  results.rssEndMiB = rss();
  await f.close();
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
