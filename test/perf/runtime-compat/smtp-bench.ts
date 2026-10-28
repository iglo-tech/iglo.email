// Non-pooled control and bounded pool; synthetic sends only to the owned Mailpit reference.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { arch, cpus, platform, release, totalmem } from "node:os";
import nodemailer from "nodemailer";
import { referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { control } from "@/test/perf/runtime-compat/smtp-control";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { percentile } from "@/test/perf/runtime-compat/metrics";
import { processCheck } from "@/test/perf/runtime-compat/process-check";

const args = new Set(process.argv.slice(2));
for (const arg of args)
  if (!["--smoke", "--control-only"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
const smoke = args.has("--smoke");
const count = smoke ? 20 : 1000;
const repetitions = smoke ? 1 : 3;
const reference = referenceMailpit(process.env);
console.log(
  JSON.stringify({
    kind: "environment",
    bun: Bun.version,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    count,
    repetitions,
    producerConcurrency: 8,
    batchSize: 100,
    smoke,
  }),
);
console.log(JSON.stringify({ kind: "correctness", ...(await control(reference)) }));
console.log(
  JSON.stringify({ kind: "compiled", ...(await processCheck("compiled-smtp", reference)) }),
);
async function run(count: number, repetition: string, mode: "non-pooled" | "pooled") {
  const marker = `m08${reference.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
  const mailpit = new Mailpit(reference, marker);
  const latencies: number[] = [];
  let sendMs = 0,
    observationMs = 0,
    accepted = 0,
    rejected = 0,
    failures = 0,
    matched = 0,
    peakActive = 0,
    active = 0;
  let peakRss = process.memoryUsage().rss;
  const responses = new Set<string>();
  const live = new Set<number>();
  const assignments = new Map<number, number>();
  let resources = 0,
    peakResources = 0,
    closedResources = 0,
    notIdle = 0;
  const log = (entry: { component?: string; tnx?: string; action?: string; cid?: number }) => {
    if (entry.component !== "smtp-pool" || typeof entry.cid !== "number") return;
    if (entry.tnx === "pool" && entry.action === "conection") {
      resources++;
      live.add(entry.cid);
      peakResources = Math.max(peakResources, live.size);
    }
    if (entry.tnx === "pool" && entry.action === "assign")
      assignments.set(entry.cid, (assignments.get(entry.cid) ?? 0) + 1);
    if (entry.tnx === "connection" && entry.action === "closed") {
      live.delete(entry.cid);
      closedResources++;
    }
  };
  const logger = { trace: log, debug: log, info: log, warn: log, error: log, fatal: log };
  const options = {
    host: reference.host,
    port: reference.port,
    secure: false,
    ignoreTLS: true,
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 5000,
    socketTimeout: 10000,
  };
  const pool =
    mode === "pooled"
      ? nodemailer.createTransport({
          ...options,
          pool: true,
          maxConnections: 4,
          maxMessages: 50,
          maxRequeues: 0,
          idleTimeout: 30_000,
          logger,
        })
      : undefined;
  try {
    for (let offset = 0; offset < count; offset += 100) {
      const end = Math.min(count, offset + 100);
      const ids = new Set<string>();
      let next = offset;
      const start = performance.now();
      const workers = Array.from({ length: Math.min(8, end - offset) }, async () => {
        while (next < end) {
          const i = next++;
          const messageId = `<${marker}.${i}@example.test>`;
          ids.add(messageId.slice(1, -1));
          const begin = performance.now();
          active++;
          peakActive = Math.max(peakActive, active);
          const transport = pool ?? nodemailer.createTransport(options);
          if (pool && !pool.isIdle()) notIdle++;
          try {
            const info = await transport.sendMail({
              from: "sender@example.test",
              to: `user${i}@example.test`,
              subject: `${marker} ${i}`,
              text: `Synthetic campaign ${i}: hello Zażółć & world.`,
              messageId,
            });
            assert.equal(info.messageId, messageId);
            assert.deepEqual(info.accepted, [`user${i}@example.test`]);
            accepted += info.accepted.length;
            rejected += info.rejected.length;
            responses.add(info.response.replace(/ as .*/, ""));
          } catch (error) {
            failures++;
            throw error;
          } finally {
            if (!pool) transport.close();
            active--;
            latencies.push(performance.now() - begin);
          }
        }
      });
      const results = await Promise.allSettled(workers);
      sendMs += performance.now() - start;
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      const observationStart = performance.now();
      const messages = await mailpit.list();
      assert.equal(messages.length, end - offset);
      const actual = new Set(messages.map((message) => message.MessageID.replace(/[<>]/g, "")));
      assert.equal(actual.size, ids.size);
      for (const id of ids) assert.ok(actual.has(id));
      matched += actual.size;
      await mailpit.removeOwned();
      observationMs += performance.now() - observationStart;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    pool?.close();
    return {
      mode,
      repetition,
      count,
      accepted,
      rejected,
      failures,
      messageIdMatches: matched,
      sendMs: Number(sendMs.toFixed(3)),
      perSecond: Number(((count * 1000) / sendMs).toFixed(1)),
      observationDrainMs: Number(observationMs.toFixed(3)),
      latencyMs: percentile(latencies),
      peakActive,
      peakSampledRssBytes: peakRss,
      responses: [...responses],
      poolObservations: pool
        ? {
            createdResources: resources,
            peakLiveResources: peakResources,
            closedResources,
            maxMessagesAssignedPerResource: Math.max(0, ...assignments.values()),
            assignments: [...assignments.values()].reduce((a, b) => a + b, 0),
            producerSawNotIdle: notIdle,
            producerMaxOutstanding: peakActive,
          }
        : null,
    };
  } finally {
    pool?.close();
    await mailpit.removeOwned();
  }
}
console.log(
  JSON.stringify({ kind: "warmup", ...(await run(smoke ? 10 : 100, "warmup", "non-pooled")) }),
);
if (!args.has("--control-only"))
  console.log(
    JSON.stringify({ kind: "warmup", ...(await run(smoke ? 10 : 100, "warmup", "pooled")) }),
  );
for (let i = 1; i <= repetitions; i++) {
  console.log(
    JSON.stringify({ kind: "repetition", ...(await run(count, String(i), "non-pooled")) }),
  );
  if (!args.has("--control-only"))
    console.log(JSON.stringify({ kind: "repetition", ...(await run(count, String(i), "pooled")) }));
}
