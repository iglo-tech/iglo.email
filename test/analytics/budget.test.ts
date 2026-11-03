// B7: the process-wide egress budget for finished analytics responses, and the forced gap that
// lets the WAL restart under continuous polling. The child is a stand-in that prints bytes.
import { expect, test } from "bun:test";
import { createAnalyticsReader } from "@/analytics/reader";

const bytes = (count: number) => ["head", "-c", String(count), "/dev/zero"];
const read = (reader: ReturnType<typeof createAnalyticsReader>, signal?: AbortSignal) =>
  reader.respond("dashboardCounts", [], signal);

test("responses waiting to be written count against the budget until sent or abandoned", async () => {
  const reader = createAnalyticsReader({
    path: "x",
    command: bytes(200_000),
    egressBytes: 300_000,
  });
  const first = await read(reader);
  const second = await read(reader);
  expect(reader.heldBytes()).toBe(400_000);
  // At or over the budget: refused before any child starts, never a partial body.
  await expect(read(reader)).rejects.toMatchObject({ kind: "egress" });
  expect((await first.arrayBuffer()).byteLength).toBe(200_000);
  expect(reader.heldBytes()).toBe(200_000);
  await expect(read(reader)).resolves.toBeInstanceOf(Response);
  await second.body!.cancel();
  expect(reader.heldBytes()).toBe(200_000);
});

test("many unread near-cap responses stop at the budget", async () => {
  const reader = createAnalyticsReader({
    path: "x",
    command: bytes(1_000_000),
    egressBytes: 3_000_000,
    concurrency: 2,
  });
  const kept: Response[] = [];
  let refused = 0;
  for (let i = 0; i < 20; i++) {
    try {
      kept.push(await read(reader));
    } catch {
      refused++;
    }
  }
  expect(kept).toHaveLength(3);
  expect(refused).toBe(17);
  expect(reader.heldBytes()).toBe(3_000_000);
  for (const response of kept) await response.body!.cancel();
  expect(reader.heldBytes()).toBe(0);
});

test("continuous overlap forces a gap after the window, by the injected clock", async () => {
  const run = async (advance: boolean) => {
    let time = 0;
    const reader = createAnalyticsReader({
      path: "x",
      command: ["sleep", "0.3"],
      concurrency: 2,
      gapAfterMs: 10_000,
      now: () => time,
    });
    const started = performance.now();
    const first = reader.read("dashboardCounts", []);
    if (advance) time = 10_000;
    const second = reader.read("dashboardCounts", []).then(() => performance.now() - started);
    await first;
    const elapsed = await second;
    await reader.close();
    return elapsed;
  };
  // Within the window both run together; past it the second waits for the first to finish.
  expect(await run(false)).toBeLessThan(550);
  expect(await run(true)).toBeGreaterThan(550);
});

test("a small body is sent whole and is not counted", async () => {
  const reader = createAnalyticsReader({ path: "x", command: bytes(1000), egressBytes: 1 });
  const response = await read(reader);
  expect(reader.heldBytes()).toBe(0);
});

test("the gap hook runs once when a long streak ends, not after a short one", async () => {
  let time = 0;
  let calls = 0;
  const reader = createAnalyticsReader({
    path: "x",
    command: ["true"],
    gapAfterMs: 10_000,
    now: () => time,
    onGap: () => void calls++,
  });
  await reader.read("dashboardCounts", []).catch(() => {});
  expect(calls).toBe(0);
  const long = reader.read("dashboardCounts", []).catch(() => {});
  time = 10_000;
  await long;
  expect(calls).toBe(1);
});
