// B120 r2 (D118): the converter's time on nested markup, per element kind, at 256 KiB and 1 MiB. Run
// from a checkout: `bun test/messaging/measure-plain-nesting.ts`. The bound on time per end tag is the
// cap on open tracked elements (HANDLER_CAP in src/messaging/plain.ts), so the ratio stays near 4.
import { plainText } from "@/messaging/plain";
import { createMessageBudget } from "@/templates/renderer";

const KIB = 1024;
const MIB = 1024 * KIB;
const nested: Record<string, { bytes: number; build: (n: number) => string }> = {
  b: { bytes: 7, build: (n) => "<b>".repeat(n) + "t" + "</b>".repeat(n) },
  div: { bytes: 11, build: (n) => "<div>".repeat(n) + "t" + "</div>".repeat(n) },
  a: { bytes: 16, build: (n) => '<a href="x">'.repeat(n) + "t" + "</a>".repeat(n) },
  li: { bytes: 18, build: (n) => "<ul><li>".repeat(n) + "t" + "</li></ul>".repeat(n) },
  td: {
    bytes: 34,
    build: (n) => "<table><tr><td>".repeat(n) + "t" + "</td></tr></table>".repeat(n),
  },
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function time(html: string): Promise<number> {
  const samples: number[] = [];
  for (let run = 0; run < 5; run++) {
    const started = performance.now();
    await plainText(html, createMessageBudget());
    samples.push(performance.now() - started);
  }
  return median(samples);
}

for (const [kind, { bytes, build }] of Object.entries(nested)) {
  const small = await time(build(Math.floor((256 * KIB) / bytes)));
  const large = await time(build(Math.floor(MIB / bytes)));
  console.log(
    `${kind.padEnd(4)} 256 KiB ${small.toFixed(1).padStart(7)} ms   1 MiB ${large.toFixed(1).padStart(7)} ms   ratio ${(large / Math.max(small, 0.01)).toFixed(2)}`,
  );
}
