// B130 (D128): what the brand values add to a transactional render, through the real renderer. Each
// render is what the tx route does per recipient: build the data text, then `renderSync` the compiled
// sample template with one message budget. The sample is the checkout's own file, so base (main) and head
// run the same script on their own trees. Modes:
//   none            the data a transactional send carried before B130 (no brand members)
//   once            the brand members built once per request and appended to each recipient (tx route)
//   each            the brand members built for every render (the scheduler's step data, step-data.ts)
// Run: bun test/perf/b130-brand-data.ts <checkout root> none|once|each
// The comparison interleaves the runs (base none, head once, head each) in one container; see
// docs/perf/B130-public-defaults.md.

import type { createRealClock } from "@/clock";
import type { createTranslation } from "@/i18n/i18n";
import type { BrandSite, brandMembers as brandMembersOf } from "@/public/brand";
import type { createMessageBudget, createRenderer } from "@/templates/renderer";
import { asBody } from "@/test/read-body";

const [root, mode] = Bun.argv.slice(2);
if (!root || (mode !== "none" && mode !== "once" && mode !== "each")) {
  throw new Error("usage: bun test/perf/b130-brand-data.ts <checkout root> none|once|each");
}

// The checkout's modules are loaded by path, so each tree runs its own code. Their types are the head's,
// which the base checkout shares for these calls.
const renderer = asBody<{
  createRenderer: typeof createRenderer;
  createMessageBudget: typeof createMessageBudget;
}>(await import(`${root}/src/templates/renderer.ts`));
const clock = asBody<{ createRealClock: typeof createRealClock }>(
  await import(`${root}/src/clock.ts`),
);
const i18n = asBody<{ createTranslation: typeof createTranslation }>(
  await import(`${root}/src/i18n/i18n.ts`),
);
const body = await Bun.file(`${root}/src/templates/builtins/sample-tx.tpl.txt`).text();
const engine = renderer.createRenderer(clock.createRealClock(), i18n.createTranslation());
const compiled = engine.compile({
  body,
  subject: "Your order {{ data.order_id }}",
  mode: "html",
});

const site: BrandSite = {
  logoUrl: "https://example.test/logo.png",
  siteName: "Bench",
  siteUrl: "https://example.test",
  accent: "#ff0066",
  font: "Lora",
  header: "logo_and_name",
};
// Base (main) has no brand members, so only the brand modes import the helper.
const brand =
  mode === "none"
    ? null
    : asBody<{ brandMembers: typeof brandMembersOf }>(await import(`${root}/src/public/brand.ts`));
const brandMembers = (): string => brand!.brandMembers(site);
const once = mode === "once" ? `,${brandMembers()}` : "";

const payload = JSON.stringify({ order_id: "A-1", shipping_date: "Monday" });
const links =
  `,"unsubscribe_url":"https://example.test/m/00000000-0000-4000-8000-000000000002/unsubscribe/00000000-0000-4000-8000-000000000001"` +
  `,"manage_url":"https://example.test/m/00000000-0000-4000-8000-000000000002/unsubscribe/00000000-0000-4000-8000-000000000001?manage=true"`;

/** The data text of one recipient, as the tx route builds it. */
function dataFor(i: number): string {
  const subscriber = JSON.stringify({
    id: i,
    uuid: "00000000-0000-4000-8000-000000000001",
    email: `person${i}@example.test`,
    name: `Person ${i}`,
    attribs: {},
  });
  const each = mode === "each" ? `,${brandMembers()}` : "";
  return `{"subscriber":${subscriber},"data":${payload}${links}${each}${once}}`;
}

const perSample = 2000;
const samples = 15;
let sink = 0;

function renderOne(i: number): number {
  return compiled.renderSync(dataFor(i), undefined, renderer.createMessageBudget()).body.length;
}

// Warm-up: the first renders compile the template's parts and JIT the path.
for (let i = 0; i < 500; i += 1) {
  sink += renderOne(i);
}
const runs: Array<number> = [];
for (let s = 0; s < samples; s += 1) {
  const start = performance.now();
  for (let i = 0; i < perSample; i += 1) {
    sink += renderOne(i);
  }
  runs.push(performance.now() - start);
}
runs.sort((a, b) => a - b);
// Other load on the machine only slows a sample down, so the fastest sample is the steadier estimate;
// the median is printed beside it.
const median = runs[Math.floor(runs.length / 2)]!;
const fastest = runs[0]!;
const micros = (ms: number) => ((ms * 1000) / perSample).toFixed(1);
console.log(
  `${mode} ${root}: min ${micros(fastest)} us, median ${micros(median)} us per render ` +
    `(${samples} x ${perSample}); data text ${dataFor(1).length} bytes; checksum ${sink}`,
);
