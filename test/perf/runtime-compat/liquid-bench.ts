// Baseline comparison with listmonk models/campaigns.go and internal/manager/message.go.
// Data are generated per recipient; this does not implement the production renderer.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { createRealClock } from "@/clock";
import { compile, engine, renderCompiled } from "@/test/perf/runtime-compat/liquid-render";
import { percentile } from "@/test/perf/runtime-compat/metrics";
import { processCheck } from "@/test/perf/runtime-compat/process-check";

const args = new Set(process.argv.slice(2));
for (const arg of args)
  if (!["--smoke", "--control-only"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
const smoke = args.has("--smoke");
const count = smoke ? 100 : 10_000;
const repetitions = smoke ? 1 : 3;
const body =
  '<h1>Hello {{ subscriber.name }}</h1><p>{{ subscriber.attribs.city }} / {{ subscriber.email }}</p><ul>{% for interest in subscriber.attribs.interests %}<li>{{ interest | upcase }}</li>{% endfor %}</ul><a href="{{ unsubscribe_url | track_link }}">{{ "hello" | t }}</a>';
const layout =
  "<!doctype html><html><body><main>{{ content | raw }}</main><footer>{{ campaign.name }}</footer></body></html>";
const subject = "News for {{ subscriber.name }} in {{ subscriber.attribs.city }}";
const html = engine("html");
const plain = engine("plain");
const clock = createRealClock();
function data(i: number) {
  return {
    subscriber: {
      name: `Person ${i} & Co`,
      email: `user${i}@example.test`,
      attribs: { city: `City ${i % 100}`, interests: ["coffee", "news", "music"] },
    },
    campaign: { name: "Autumn & updates" },
    unsubscribe_url: `https://example.test/unsubscribe?id=${i}`,
  };
}
function run(n: number, label: "parse-per-recipient" | "compile-once") {
  const parseSamples: number[] = [];
  const renderSamples: number[] = [];
  const latency: number[] = [];
  const digest = createHash("sha256");
  let peakRss = process.memoryUsage().rss;
  let outputBytes = 0;
  const started = performance.now();
  const shared =
    label === "compile-once"
      ? { compiled: compile(html, body, layout), subject: plain.parse(subject) }
      : undefined;
  const initialParseMs = performance.now() - started;
  for (let i = 0; i < n; i++) {
    const begin = performance.now();
    const compiled = shared?.compiled ?? compile(html, body, layout);
    const compiledSubject = shared?.subject ?? plain.parse(subject);
    const parsed = performance.now();
    const values = data(i);
    const rendered = renderCompiled(html, compiled, values);
    const title = String(plain.renderSync(compiledSubject, values));
    const finished = performance.now();
    assert.ok(
      rendered.includes(`Person ${i} &amp; Co`) &&
        rendered.includes(`user${i}@example.test`) &&
        rendered.includes(`id=${i}&amp;fixture=1`) &&
        title.includes(`Person ${i} & Co`),
    );
    digest.update(title).update("\0").update(rendered).update("\0");
    outputBytes += Buffer.byteLength(rendered) + Buffer.byteLength(title);
    parseSamples.push(parsed - begin);
    renderSamples.push(finished - parsed);
    latency.push(finished - begin);
    if (i % 100 === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  const elapsedMs = performance.now() - started;
  return {
    label,
    recipients: n,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    perSecond: Number(((n * 1000) / elapsedMs).toFixed(1)),
    parseMs: Number(
      (label === "compile-once" ? initialParseMs : parseSamples.reduce((a, b) => a + b, 0)).toFixed(
        3,
      ),
    ),
    renderMs: Number(renderSamples.reduce((a, b) => a + b, 0).toFixed(3)),
    latencyMs: percentile(latency),
    peakSampledRssBytes: peakRss,
    outputBytes,
    sha256: digest.digest("hex"),
  };
}
console.log(
  JSON.stringify({
    kind: "environment",
    at: clock.now().toISOString(),
    bun: Bun.version,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    smoke,
    repetitions,
    count,
    sizes: {
      body: Buffer.byteLength(body),
      layout: Buffer.byteLength(layout),
      subject: Buffer.byteLength(subject),
    },
    config:
      "ownPropertyOnly, empty templates, HTML outputEscape, 64Ki parse, 1s render, 1M operation allocation; plain subject",
  }),
);
console.log(JSON.stringify({ kind: "probe", ...(await processCheck("source-liquid")) }));
console.log(JSON.stringify({ kind: "probe", ...(await processCheck("compiled-liquid")) }));
console.log(JSON.stringify({ kind: "warmup", ...run(smoke ? 20 : 200, "parse-per-recipient") }));
if (!args.has("--control-only"))
  console.log(JSON.stringify({ kind: "warmup", ...run(smoke ? 20 : 200, "compile-once") }));
for (let i = 1; i <= repetitions; i++) {
  const baseline = run(count, "parse-per-recipient");
  console.log(JSON.stringify({ kind: "repetition", repetition: i, ...baseline }));
  if (!args.has("--control-only")) {
    const compiled = run(count, "compile-once");
    assert.equal(compiled.sha256, baseline.sha256);
    assert.equal(compiled.outputBytes, baseline.outputBytes);
    console.log(JSON.stringify({ kind: "repetition", repetition: i, ...compiled }));
  }
}
