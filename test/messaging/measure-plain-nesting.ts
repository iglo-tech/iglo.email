// B120 (D118): the converter's time on nested and implied-end markup, at 256 KiB and 1 MiB. Run from a
// checkout: `bun test/messaging/measure-plain-nesting.ts`. Nested shapes stay linear through the cap on
// open tracked elements (HANDLER_CAP). Implied-end shapes are bounded by the cap on held end-tag
// handlers (HELD_CAP): past it the conversion stops, and the result is empty (no text part).
import { plainText } from "@/messaging/plain";
import { createMessageBudget } from "@/templates/renderer";

const KIB = 1024;
const MIB = 1024 * KIB;
/** A shape repeats a unit; `prefix` is written once before the units. */
const shapes: Record<string, { bytes: number; prefix?: string; build: (n: number) => string }> = {
  "nested b": { bytes: 7, build: (n) => "<b>".repeat(n) + "t" + "</b>".repeat(n) },
  "nested div": { bytes: 11, build: (n) => "<div>".repeat(n) + "t" + "</div>".repeat(n) },
  "nested a": { bytes: 16, build: (n) => '<a href="x">'.repeat(n) + "t" + "</a>".repeat(n) },
  "nested li": { bytes: 18, build: (n) => "<ul><li>".repeat(n) + "t" + "</li></ul>".repeat(n) },
  "nested td": {
    bytes: 34,
    build: (n) => "<table><tr><td>".repeat(n) + "t" + "</td></tr></table>".repeat(n),
  },
  "unclosed p": { bytes: 12, build: (n) => "<p>x<b>y</b>".repeat(n) },
  "unclosed li": { bytes: 13, prefix: "<ul>", build: (n) => "<li>x<b>y</b>".repeat(n) },
  "unclosed td": { bytes: 13, prefix: "<table><tr>", build: (n) => "<td>x<b>y</b>".repeat(n) },
  "unclosed tr cell": { bytes: 17, prefix: "<table>", build: (n) => "<tr><td>x<b>y</b>".repeat(n) },
  "unclosed dd": { bytes: 13, prefix: "<dl>", build: (n) => "<dd>x<b>y</b>".repeat(n) },
  "unclosed option": { bytes: 17, prefix: "<select>", build: (n) => "<option>x<b>y</b>".repeat(n) },
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function time(html: string): Promise<{ ms: number; text: string }> {
  const samples: number[] = [];
  let text = "";
  for (let run = 0; run < 5; run++) {
    const started = performance.now();
    text = await plainText(html, createMessageBudget());
    samples.push(performance.now() - started);
  }
  return { ms: median(samples), text };
}

for (const [kind, { bytes, prefix = "", build }] of Object.entries(shapes)) {
  const small = await time(prefix + build(Math.floor((256 * KIB) / bytes)));
  const large = await time(prefix + build(Math.floor(MIB / bytes)));
  const state = large.text === "" ? "no text part" : `text ${large.text.length} chars`;
  console.log(
    `${kind.padEnd(17)} 256 KiB ${small.ms.toFixed(1).padStart(7)} ms   1 MiB ${large.ms.toFixed(1).padStart(7)} ms   ratio ${(large.ms / Math.max(small.ms, 5)).toFixed(2)}   1 MiB: ${state}`,
  );
}
