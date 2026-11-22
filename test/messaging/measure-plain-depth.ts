// B135 review (blocker 3, D118): the text/plain converter on deeply nested lists. One process per round, so
// the base (origin/main) and the head trees can run alternately in one container. Run from a checkout:
// `bun test/messaging/measure-plain-depth.ts`. It prints one JSON line: the median time in milliseconds of
// five conversions of the review's shape (1,000 open lists, then 100,000 items), the output's length, and
// the process's resident memory after them. The shape is 1.1 MB of HTML.
import { plainText } from "@/messaging/plain";
import { createMessageBudget } from "@/templates/renderer";

const html = "<ul>".repeat(1000) + "<li>x</li>".repeat(100_000);
const samples: Array<number> = [];
let output = "";
for (let run = 0; run < 5; run++) {
  const started = performance.now();
  output = await plainText(html, createMessageBudget());
  samples.push(performance.now() - started);
}
samples.sort((a, b) => a - b);
const rssMiB = Math.round(process.memoryUsage().rss / (1024 * 1024));
console.log(
  JSON.stringify({
    htmlBytes: Buffer.byteLength(html),
    outputBytes: Buffer.byteLength(output),
    medianMs: Math.round(samples[2]! * 10) / 10,
    rssMiB,
  }),
);
