// Synthetic owner-only Markdown and serialized-context costs, not a control comparison.
import { createHash } from "node:crypto";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";
import { createRenderer } from "@/templates/renderer";

const renderer = createRenderer(createRealClock(), createTranslation());
const compiled = {
  markdown: renderer.compile({
    body: "# Hello {{ name }}\n\n[news](https://example.invalid/news)\n\n- one\n- two",
    mode: "markdown",
  }),
  context: renderer.compile({ body: "{{ name }}", mode: "plain" }),
};
const payload = JSON.stringify({
  name: "A & B",
  fields: Array.from({ length: 100 }, (_, i) => ({ label: `value-${i}`, n: i })),
});
function run(kind: keyof typeof compiled, count: number, rep: number) {
  const hash = createHash("sha256");
  const start = performance.now();
  let rss = process.memoryUsage().rss,
    bytes = 0;
  for (let i = 0; i < count; i++) {
    const result = compiled[kind].renderSync(payload).body;
    hash.update(result).update("\0");
    bytes += Buffer.byteLength(result);
    if (i % 100 === 0) rss = Math.max(rss, process.memoryUsage().rss);
  }
  return {
    kind,
    rep,
    count,
    contextBytes: Buffer.byteLength(payload),
    elapsedMs: performance.now() - start,
    bytes,
    digest: hash.digest("hex"),
    sampledRss: rss,
  };
}
for (const kind of ["context", "markdown"] as const) {
  run(kind, 200, 0);
  for (let rep = 1; rep <= 3; rep++) console.log(JSON.stringify(run(kind, 10000, rep)));
}
