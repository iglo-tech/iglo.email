// B130 (D128): what the brand values add to a transactional template's data. The transactional route
// builds the brand members once per request and concatenates them into each recipient's data text, so
// the cost is one `brandMembers` call per request and a longer string per recipient. "before" is the same
// data text without the brand members, as the route built it on main. Run: bun test/perf/b130-brand-data.ts
import { brandMembers } from "@/public/brand";
import type { BrandSite } from "@/public/brand";

const site: BrandSite = {
  logoUrl: "https://example.test/logo.png",
  siteName: "Bench",
  siteUrl: "https://example.test",
  accent: "#ff0066",
  font: "Lora",
  header: "logo_and_name",
};
const subscriber = JSON.stringify({
  id: 1,
  uuid: "00000000-0000-4000-8000-000000000001",
  email: "a@example.test",
  name: "Ada",
  attribs: {},
});
const payload = JSON.stringify({ order_id: "A-1", shipping_date: "Monday" });
const manage = `,"manage_url":"https://example.test/m/00000000-0000-4000-8000-000000000002/unsubscribe/00000000-0000-4000-8000-000000000001?manage=true"`;
const iterations = 200_000;

function median(samples: Array<number>) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The lengths are summed and printed, so the optimiser cannot drop the work being timed. */
let sink = 0;

/** Milliseconds for `fn` run `iterations` times, five times over, as the median of the five. */
function time(label: string, fn: (i: number) => unknown) {
  const runs: Array<number> = [];
  for (let run = 0; run < 5; run += 1) {
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      sink += String(fn(i)).length;
    }
    runs.push(performance.now() - start);
  }
  const ms = median(runs);
  console.log(
    `${label}: ${ms.toFixed(1)} ms for ${iterations} (${((ms * 1000) / iterations).toFixed(3)} us each)`,
  );
  return ms;
}

const brand = brandMembers(site);
console.log(`brand members: ${brand.length} characters`);
time(
  "before: data text per recipient",
  () => `{"subscriber":${subscriber},"data":${payload}${manage}}`,
);
time(
  "after: data text per recipient",
  () => `{"subscriber":${subscriber},"data":${payload}${manage},${brand}}`,
);
time("after: brand members per request", () => brandMembers(site));
console.log(`checksum ${sink}`);
