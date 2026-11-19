// Serial timing for docs/perf/B108-test-send-records.md (D114); opt-in, not a CI threshold. Times
// the record each test send writes (one write transaction, as the route does), the step test
// request that writes it, and the lookup an unmatched notice pays, in a table of 100 rows and of
// 100,100 rows. Usage: bun test/messaging/measure-test-sends.ts [n]
import { writeTransaction } from "@/db/transaction";
import { createTestSends } from "@/messaging/test-sends";
import { schedulerFixture } from "@/test/scheduler/fixture";

const N = Number(process.argv[2] ?? 100);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const micro = (ms: number) => `${(ms * 1000).toFixed(1)} µs`;
const milli = (ms: number) => `${ms.toFixed(2)} ms`;
const uuid = () => crypto.randomUUID();

const f = await schedulerFixture();
try {
  const testSends = createTestSends(f.db, f.clock);

  // The record alone: one row, in its own write transaction, as a test send writes it.
  const recording: number[] = [];
  for (let i = 0; i < N; i++) {
    const start = performance.now();
    writeTransaction(f.db, () =>
      testSends.record([
        {
          messageId: `<${uuid()}@fixture.test>`,
          kind: "sequence_step",
          campaign_id: null,
          sequence_id: 1,
          step_id: 1,
          recipient: `record-${i}@example.test`,
        },
      ]),
    );
    recording.push(performance.now() - start);
  }

  // The step test request that writes the record: queued, one address, through HTTP.
  const template = await f.template("<p>Hi</p>", "Measured");
  const sequence = await f.sequence({
    trigger: { event: "purchase" },
    steps: [{ wait: "P1D", kind: "transactional", template_id: template, subject: "Measured" }],
  });
  const requests: number[] = [];
  for (let i = 0; i < N; i++) {
    const address = `request-${i}@example.test`;
    const start = performance.now();
    const sent = await f.json(
      `/api/sequences/${sequence.id}/steps/${sequence.steps[0]!.id}/test`,
      "POST",
      { emails: [address] },
    );
    requests.push(performance.now() - start);
    if (sent.status !== 200) throw new Error(`test send ${sent.status}`);
    // Wait for the message before the next one: four test sends may be in flight at once.
    await f.until(() => f.sink.messages.some((m) => m.to.includes(address)), "the test message");
  }

  // The lookup an unmatched notice pays: an indexed miss, in the window or past it.
  const lookups = () => {
    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      const start = performance.now();
      testSends.find(`<${uuid()}@elsewhere.test>`);
      samples.push(performance.now() - start);
    }
    return median(samples);
  };
  const small = lookups();
  writeTransaction(f.db, () => {
    const insert = f.db.query(
      `INSERT INTO test_sends (message_id, kind, campaign_id, sequence_id, step_id, recipient, created_at)
       VALUES (?, 'sequence_step', NULL, 1, 1, ?, ?)`,
    );
    const at = f.clock.now().toISOString();
    for (let i = 0; i < 100_000; i++)
      insert.run(`<${uuid()}@bulk.test>`, `bulk-${i}@example.test`, at);
  });
  const large = lookups();

  console.log(`n=${N}`);
  console.log(`record (median, one write transaction): ${micro(median(recording))}`);
  console.log(`step test request (median, HTTP, queued): ${milli(median(requests))}`);
  console.log(`unmatched lookup, 100 rows (median): ${micro(small)}`);
  console.log(`unmatched lookup, 100,100 rows (median): ${micro(large)}`);
} finally {
  await f.close();
}
