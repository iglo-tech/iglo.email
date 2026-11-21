// B116 (D131) cost of recording a refused sequence start: POST /api/subscriber-events and the
// subscriber's event page, in process through the scheduler fixture (the whole stack, the injected
// clock), median of runs. Opt-in; not a CI threshold. The same script runs on origin/main (before)
// and on this branch (after).
//   bun test/sequences/measure-skips.ts
import { schedulerFixture } from "@/test/scheduler/fixture";

const RUNS = Number(process.env.SKIPS_MEASURE_RUNS ?? 5);
const EVENTS = Number(process.env.SKIPS_MEASURE_EVENTS ?? 1000);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const f = await schedulerFixture();
try {
  const template = await f.template();
  const news = await f.list("News");
  const step = { wait: "P1D", template_id: template };
  await f.sequence({
    name: "Started",
    reentry: "always",
    trigger: { event: "started" },
    steps: [{ ...step, kind: "transactional" }],
  });
  await f.sequence({
    name: "Marketing",
    list_id: news,
    reentry: "always",
    trigger: { event: "blocked" },
    steps: [{ ...step, kind: "marketing" }],
  });
  await f.sequence({
    name: "Receipt",
    reentry: "always",
    trigger: { event: "blocked" },
    steps: [{ ...step, kind: "transactional" }],
  });
  const post = (email: string, name: string) =>
    f.json("/api/subscriber-events", "POST", { subscriber: { email }, name });
  const blocked = (await post("blocked@example.test", "signup")).body.data.subscriber_id as number;
  await f.json(`/api/subscribers/${blocked}/blocklist`, "PUT", {});

  const workloads: [string, () => Promise<{ status: number }>][] = [
    ["plain: no sequence triggered", () => post("plain@example.test", "noop")],
    [
      "started: transactional sequence starts (replaces its enrollment)",
      () => post("started@example.test", "started"),
    ],
    [
      "blocked: two sequences refused (blocklisted subscriber)",
      () => post("blocked@example.test", "blocked"),
    ],
  ];
  for (const [label, run] of workloads) {
    const samples: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      const started = performance.now();
      for (let i = 0; i < EVENTS; i++) {
        if ((await run()).status !== 200) throw new Error(`${label}: event refused`);
      }
      samples.push((performance.now() - started) / EVENTS);
    }
    console.log(
      `${label}: ${median(samples).toFixed(4)} ms per event (median of ${RUNS} runs of ${EVENTS})`,
    );
  }

  // The subscriber's event page after the blocked events above: one page of 50 newest events.
  const pageSamples: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const started = performance.now();
    for (let i = 0; i < 100; i++) {
      const page = await f.json(`/api/subscribers/${blocked}/subscriber-events?page=1&per_page=50`);
      if (page.status !== 200) throw new Error(`events page ${page.status}`);
      if (page.body.data.results.length !== 50) throw new Error("events page is not full");
    }
    pageSamples.push((performance.now() - started) / 100);
  }
  console.log(
    `events page (50 of ${EVENTS * RUNS} events): ${median(pageSamples).toFixed(4)} ms per request (median of ${RUNS} runs of 100)`,
  );
} finally {
  await f.close();
}
