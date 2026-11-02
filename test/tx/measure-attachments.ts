// Serial in-process measurement for docs/perf/B6-send-media-safety.md: peak memory and latency of
// concurrent synchronous `POST /api/tx` multipart sends with a 4 MiB attachment each, against a
// slow SMTP server (every dispatch is held 300 ms). "Before" removes the attachment budget;
// "after" is the shipped one. Opt-in, not a CI threshold. Usage: bun test/tx/measure-attachments.ts <requests> before|after
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRealClock } from "@/clock";
import { txFixture } from "@/test/tx/fixture";

const repository = resolve(import.meta.dir, "../..");
const requests = Number(process.argv[2] ?? 40);
const output = join(repository, "docs/perf/B6-results.jsonl");
const head = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: repository })
  .stdout.toString()
  .trim();
const mib = (bytes: number) => +(bytes / 1048576).toFixed(1);
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    n: values.length,
    p50: +at(0.5).toFixed(0),
    p95: +at(0.95).toFixed(0),
    max: +at(1).toFixed(0),
  };
};

async function run(variant: "before" | "after") {
  const f = await txFixture({
    clock: createRealClock(),
    beforeDispatch: () => Bun.sleep(300),
    ...(variant === "before" ? { limits: { maxBytes: 2 ** 40, maxSends: 1_000_000 } } : {}),
  });
  const template = await f.template("<p>x</p>");
  const post = async (i: number) => {
    const form = new FormData();
    form.set(
      "data",
      JSON.stringify({
        subscriber_emails: [`m-${variant}-${i}@example.test`],
        template_id: template,
      }),
    );
    form.append("file", new File([new Uint8Array(4 * 1024 * 1024)], "a.bin"));
    const encoded = await new Response(form).blob();
    return () => {
      const begin = performance.now();
      return f
        .request("/api/tx", {
          method: "POST",
          headers: {
            ...f.sessionHeaders,
            "content-type": encoded.type,
            "content-length": String(encoded.size),
          },
          body: encoded,
        })
        .then((response) => ({ status: response.status, ms: performance.now() - begin }));
    };
  };
  const sends = await Promise.all(Array.from({ length: requests }, (_, i) => post(i)));
  Bun.gc(true);
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 2);
  const begin = performance.now();
  const answers = await Promise.all(sends.map((send) => send()));
  const seconds = (performance.now() - begin) / 1000;
  clearInterval(sampler);
  const ok = answers.filter((a) => a.status === 200);
  const entry = {
    scenario: `tx attachments ${variant}`,
    requests,
    attachmentMiB: 4,
    ok: ok.length,
    status429: answers.filter((a) => a.status === 429).length,
    other: answers.filter((a) => a.status !== 200 && a.status !== 429).length,
    rssBaselineMiB: mib(baseline),
    rssPeakMiB: mib(peak),
    rssGrowthMiB: mib(peak - baseline),
    seconds: +seconds.toFixed(1),
    latencyMsOk: stats(ok.map((a) => a.ms)),
    latencyMsRefused: stats(answers.filter((a) => a.status === 429).map((a) => a.ms)),
    delivered: f.sink.messages.length,
  };
  console.log(JSON.stringify(entry));
  appendFileSync(output, `${JSON.stringify({ at: new Date().toISOString(), head, ...entry })}\n`);
  await f.close();
}
// One variant per process, so the first run's garbage does not move the second's baseline.
const variant = process.argv[3];
if (variant !== "before" && variant !== "after") throw new Error("Usage: [requests] before|after");
await run(variant);
