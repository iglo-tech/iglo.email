// Opt-in, serial synthetic comparison against the exact M2.2 control fixture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";
import { createRenderer } from "@/templates/renderer";
const controlPath = resolve(
  "node_modules/.cache/m18-baseline/test/perf/runtime-compat/liquid-render.ts",
);
const control = (await import(
  controlPath
)) as typeof import("@/test/perf/runtime-compat/liquid-render");
const renderer = createRenderer(createRealClock(), createTranslation());
const body =
  "<h1>Hello {{ subscriber.name }}</h1><p>{{ subscriber.attribs.city }} / {{ subscriber.email }}</p><ul>{% for interest in subscriber.attribs.interests %}<li>{{ interest | upcase }}</li>{% endfor %}</ul>";
const layout =
  "<!doctype html><html><body><main>{{ content | raw }}</main><footer>{{ campaign.name }}</footer></body></html>";
const subject = "News for {{ subscriber.name }} in {{ subscriber.attribs.city }}";
const plainBody = "Hello {{ subscriber.name }}: {{ subscriber.email }}";
const data = (i: number) => ({
  subscriber: {
    name: `Person ${i} & Co`,
    email: `user${i}@example.test`,
    attribs: { city: `City ${i % 100}`, interests: ["coffee", "news", "music"] },
  },
  campaign: { name: "Autumn & updates" },
});
function run(kind: "control" | "owner", count: number, rep: number) {
  const html = control.engine("html"),
    plain = control.engine("plain");
  const begin = performance.now();
  const compiled =
    kind === "control"
      ? {
          body: control.compile(html, body, layout),
          subject: plain.parse(subject),
          plainBody: plain.parse(plainBody),
        }
      : undefined;
  const own =
    kind === "owner" ? renderer.compile({ body, layout, subject, mode: "html" }) : undefined;
  const ownPlain =
    kind === "owner" ? renderer.compile({ body: plainBody, mode: "plain" }) : undefined;
  const parsed = performance.now();
  let renderMs = 0,
    bytes = 0,
    rss = process.memoryUsage().rss;
  const digest = createHash("sha256");
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    const input = data(i);
    const output = own
      ? own.renderSync(input)
      : {
          body: control.renderCompiled(html, compiled!.body, input),
          subject: String(plain.renderSync(compiled!.subject, input)),
        };
    const plainOutput = ownPlain
      ? ownPlain.renderSync(input).body
      : String(plain.renderSync(compiled!.plainBody, input));
    renderMs += performance.now() - start;
    assert.ok(
      output.body.includes(`Person ${i} &amp; Co`) &&
        output.subject.includes(`Person ${i} & Co`) &&
        plainOutput.includes(`Person ${i} & Co`),
    );
    digest
      .update(output.subject)
      .update("\0")
      .update(output.body)
      .update("\0")
      .update(plainOutput)
      .update("\0");
    bytes +=
      Buffer.byteLength(output.subject) +
      Buffer.byteLength(output.body) +
      Buffer.byteLength(plainOutput);
    if (i % 100 === 0) rss = Math.max(rss, process.memoryUsage().rss);
  }
  return {
    kind,
    rep,
    count,
    parseMs: parsed - begin,
    renderMs,
    totalMs: performance.now() - begin,
    bytes,
    digest: digest.digest("hex"),
    sampledRss: rss,
  };
}
const records = [];
for (const kind of ["control", "owner"] as const) {
  run(kind, 200, 0);
  for (let n = 1; n <= 3; n++) records.push(run(kind, 10000, n));
}
for (const row of records) console.log(JSON.stringify(row));
assert.equal(new Set(records.map((row) => row.digest)).size, 1);
assert.equal(new Set(records.map((row) => row.bytes)).size, 1);
