// Non-pooled control; bounded synthetic sends only to the owned Mailpit reference.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { arch, cpus, platform, release, totalmem } from "node:os";
import nodemailer from "nodemailer";
import { referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { control } from "@/test/perf/runtime-compat/smtp-control";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { percentile } from "@/test/perf/runtime-compat/metrics";

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
async function run(count: number, repetition: string) {
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
          const transport = nodemailer.createTransport({
            host: reference.host,
            port: reference.port,
            secure: false,
            ignoreTLS: true,
            disableFileAccess: true,
            disableUrlAccess: true,
            connectionTimeout: 5000,
            socketTimeout: 10000,
          });
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
            transport.close();
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
    return {
      mode: "non-pooled",
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
    };
  } finally {
    await mailpit.removeOwned();
  }
}
console.log(JSON.stringify({ kind: "warmup", ...(await run(smoke ? 10 : 100, "warmup")) }));
for (let i = 1; i <= repetitions; i++)
  console.log(JSON.stringify({ kind: "repetition", ...(await run(count, String(i))) }));
