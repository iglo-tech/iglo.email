// B118a item 2: how long a transactional send to several recipients keeps the event loop from other
// work. A spinner queues itself with setImmediate and records the longest gap between its turns; a
// send to one recipient gives the baseline, a send to four gives the case. Run with
// `bun test/tx/measure-yield.ts`. The template is the B120 shape: 1023 open elements, then data
// values that hold stray end tags. The create endpoint's work budget refuses stray tags in the
// template itself, but a send's data is bounded only by 256 KiB in all with 64 KiB per value
// (templates/data.ts), so four values of 63 KiB render about 252 KiB of stray end tags.
import { txFixture } from "@/test/tx/fixture";
import { asBody } from "@/test/read-body";

const worst = `${"<div>".repeat(1023)}${"</span>".repeat(8000)}{{ data.a }}{{ data.b }}{{ data.c }}{{ data.d }}`;
const stray = "</span>".repeat(9000);
const data = { a: stray, b: stray, c: stray, d: stray };

/** The longest gap between two turns of an otherwise idle event loop, in ms, during `work`. */
async function longestGap(work: () => Promise<unknown>): Promise<number> {
  let running = true;
  let last = performance.now();
  let longest = 0;
  const spin = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (running) {
      setImmediate(spin);
    }
  };
  setImmediate(spin);
  last = performance.now();
  await work();
  running = false;
  return longest;
}

const median = (values: Array<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

const f = await txFixture({});
try {
  const templateId = await f.template(worst, "Worst");
  for (const emails of [
    ["one@example.test"],
    ["a@example.test", "b@example.test", "c@example.test", "d@example.test"],
  ]) {
    const runs: Array<number> = [];
    for (let i = 0; i < 3; i++) {
      runs.push(
        await longestGap(async () => {
          const response = await f.tx({
            subscriber_mode: "external",
            subscriber_emails: emails.map((e, j) => `${i}-${j}-${e}`),
            template_id: templateId,
            data,
          });
          if (response.status !== 200) {
            throw new Error(`tx ${response.status}: ${JSON.stringify(asBody(response.body))}`);
          }
        }),
      );
    }
    console.log(
      `${emails.length} recipient(s): longest loop gap ms per run ${runs.map((r) => r.toFixed(0)).join(", ")}; median ${median(runs).toFixed(0)}`,
    );
  }
} finally {
  await f.close();
}
