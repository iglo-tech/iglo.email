// B97 measurement (docs/perf/B97-step-preview.md): the median time of step previews and test sends
// through HTTP, and the scheduler's send path for due steps, in the in-process production owners of
// test/scheduler/fixture.ts. Run: bun test/sequences/measure-preview.ts. Not a CI threshold.
import { day, hour, schedulerFixture } from "@/test/scheduler/fixture";

const median = (values: Array<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const timed = async (run: () => Promise<unknown>) => {
  const start = performance.now();
  await run();
  return performance.now() - start;
};

const f = await schedulerFixture();
/** Waits until `count` messages are at the sink, moving the clock that the rate limiter sleeps on. */
async function arrived(count: number) {
  const deadline = Date.now() + 60_000;
  while (f.sink.messages.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`timed out: ${f.sink.messages.length} of ${count} at the sink`);
    }
    f.clock.advance(1000);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}
/** Every send row, all pages (the list is newest first, 100 to a page). */
async function allSends() {
  const rows: Array<{ status: string }> = [];
  for (let page = 1; ; page++) {
    const body = (await f.json(`/api/sends?per_page=100&page=${page}`)).body.data;
    rows.push(...(body.results as Array<{ status: string }>));
    if (page * 100 >= body.total || body.results.length === 0) {
      return { total: body.total, rows };
    }
  }
}
/** Sends still queued or sending, from the list's own totals (one small request each). */
async function openSends() {
  let open = 0;
  for (const status of ["queued", "sending"]) {
    open += (await f.json(`/api/sends?per_page=1&status=${status}`)).body.data.total as number;
  }
  return open;
}
/**
 * Waits until the send log holds `count` sends and none is still queued or sending: each has
 * settled as sent, failed, skipped or unknown, which the caller reports. Delivery waits on the
 * rate limiter's sleeps, which only the injected clock releases, so the clock moves while it waits.
 */
async function delivered(count: number, label: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    f.clock.advance(1000);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    const total = (await f.json("/api/sends?per_page=1")).body.data.total as number;
    const open = await openSends();
    if (total >= count && open === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}: total=${total} open=${open}`);
    }
  }
}
/** The settled statuses of every send row, counted. */
async function statusCounts() {
  const counts: Record<string, number> = {};
  for (const row of (await allSends()).rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return counts;
}
try {
  const template = await f.template(
    "<p>Hi {{ subscriber.name }}; items: {{ trigger.data.items }}; downloads: {{ aggregates.downloads | number | default: 0 }}</p>",
    "Template subject",
  );
  const ada = await f.subscriber("ada@example.test", { name: "Ada" });
  await f.json("/api/subscriber-events", "POST", {
    subscriber: { email: "ada@example.test" },
    name: "purchase",
    occurred_at: new Date(f.clock.now().getTime() - hour).toISOString(),
    data: { items: 3 },
  });
  const sequence = await f.sequence({
    trigger: { event: "purchase" },
    steps: [
      {
        wait: "P1D",
        kind: "transactional",
        template_id: template,
        subject: "Order update",
        aggregates: { downloads: { event: "download", since: "trigger", fn: "count" } },
      },
    ],
  });
  const step = sequence.steps[0]!.id;
  const shownPath = `/api/sequences/${sequence.id}/steps/${step}/preview`;
  const probe = await f.json(shownPath, "POST", { subscriber_id: ada });
  const previews = probe.status === 200;

  // The scheduler's own send path: 100 due manual enrollments per round, from the clock advance until
  // every message is at the sink. A round is one pass of the loop plus the outbox delivering it.
  // First, so it runs as a baseline run does: no test sends have gone through the emailer before it.
  const rounds: Array<number> = [];
  for (let round = 0; round < 3; round++) {
    const subscribers: Array<number> = [];
    for (let i = 0; i < 100; i++) {
      subscribers.push(await f.subscriber(`batch${round}-${i}@example.test`));
    }
    for (const subscriber of subscribers) {
      await f.json("/api/enrollments", "POST", {
        sequence_id: sequence.id,
        subscriber_id: subscriber,
      });
    }
    const start = performance.now();
    await f.pass(day);
    await delivered((round + 1) * 100, "the scheduled sends");
    rounds.push((performance.now() - start) / 100);
  }
  console.log(
    JSON.stringify({
      measure: "scheduler send path",
      n: 100,
      rounds: 3,
      sink_messages_after_last_round: f.sink.messages.length,
      median_ms_per_send: median(rounds).toFixed(3),
      previews_measured: previews,
      statuses_after_rounds: await statusCounts(),
    }),
  );

  if (previews) {
    const samples: Array<number> = [];
    for (let i = 0; i < 100; i++) {
      samples.push(await timed(() => f.json(shownPath, "POST", { subscriber_id: ada })));
    }
    console.log(
      JSON.stringify({ measure: "step preview", n: 100, median_ms: median(samples).toFixed(2) }),
    );

    // Each send settles before the next, as the in-flight cap (4) would otherwise answer 429.
    const testSamples: Array<number> = [];
    for (let i = 0; i < 20; i++) {
      testSamples.push(
        await timed(async () => {
          const r = await f.json(`/api/sequences/${sequence.id}/steps/${step}/test`, "POST", {
            emails: [`owner${i}@example.test`],
            subscriber_id: ada,
          });
          if (r.status !== 200) {
            throw new Error(JSON.stringify(r.body));
          }
        }),
      );
      await arrived(i + 1);
      // The dispatch settles after the sink has the message, on the same clock: let it settle.
      for (let tick = 0; tick < 5; tick++) {
        f.clock.advance(1000);
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }
    }
    console.log(
      JSON.stringify({ measure: "test send", n: 20, median_ms: median(testSamples).toFixed(2) }),
    );
    console.log(
      JSON.stringify({ measure: "send log after test sends", statuses: await statusCounts() }),
    );
  }
} finally {
  await f.close();
}
