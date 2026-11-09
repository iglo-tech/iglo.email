// B7: the process-wide egress budget for finished analytics responses, and the forced gap that
// lets the WAL restart under continuous polling. The child is a stand-in that prints bytes.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // Each child logs when it starts and, once released, when it ends; the order of the log says
  // whether the second read ran beside the first or waited for it. No elapsed time is measured.
  const run = async (advance: boolean) => {
    const directory = mkdtempSync(join(tmpdir(), "iglo-gap-"));
    const log = join(directory, "log");
    const go = join(directory, "go");
    writeFileSync(log, "");
    const lines = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
    let time = 0;
    const reader = createAnalyticsReader({
      path: "x",
      command: [
        "sh",
        "-c",
        `cat >/dev/null; echo start >> ${log}; while [ ! -e ${go} ]; do sleep 0.01; done; sleep 0.1; echo end >> ${log}`,
      ],
      concurrency: 2,
      gapAfterMs: 10_000,
      now: () => time,
    });
    try {
      const first = reader.read("dashboardCounts", []);
      while (lines().length < 1) await Bun.sleep(5);
      if (advance) time = 10_000;
      const second = reader.read("dashboardCounts", []);
      // Within the window the second child starts beside the first; past it, it is held back
      // until the first has finished, so there is nothing to wait for and the release comes now.
      if (!advance) while (lines().length < 2) await Bun.sleep(5);
      writeFileSync(go, "");
      await Promise.all([first, second]);
      return lines();
    } finally {
      await reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
  expect(await run(false)).toEqual(["start", "start", "end", "end"]);
  expect(await run(true)).toEqual(["start", "end", "start", "end"]);
});

test("a small body is sent whole and is not counted", async () => {
  const reader = createAnalyticsReader({ path: "x", command: bytes(1000), egressBytes: 1 });
  await read(reader);
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
