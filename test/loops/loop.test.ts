import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLoopFixture } from "@/test/loops/fixture";

async function request(origin: string, input: object) {
  const response = await fetch(origin, {
    method: "POST",
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(3000),
  });
  return {
    status: response.status,
    ...((await response.json()) as { result?: any; error?: string }),
  };
}
async function withFixture(fn: (origin: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "iglo-loop-contract-"));
  const fixture = startLoopFixture(directory);
  try {
    await fn(fixture.origin);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("competing stores claim one live lease and the owning store controls expiry", async () => {
  await withFixture(async (origin) => {
    await request(origin, { action: "add", id: 1 });
    await request(origin, { action: "start", name: "one", hold: true });
    await request(origin, { action: "wait-started", count: 1 });
    await request(origin, { action: "start", name: "two", connection: 1, hold: true });
    await request(origin, { action: "sleeping" });
    expect((await request(origin, { action: "state" })).result.started).toEqual([
      { loop: "one", id: "1", inTransaction: false },
    ]);
    await request(origin, { action: "advance", ms: 500 });
    await request(origin, { action: "wait-started", count: 2 });
    expect((await request(origin, { action: "state" })).result.started[1]).toEqual({
      loop: "two",
      id: "1",
      inTransaction: false,
    });
    await request(origin, { action: "stop", name: "one" });
    await request(origin, { action: "stop", name: "two" });
    await request(origin, { action: "release", name: "one" });
    await request(origin, { action: "release", name: "two" });
    expect((await request(origin, { action: "done", name: "one" })).result.error).toBeNull();
    expect((await request(origin, { action: "done", name: "two" })).result.error).toBeNull();
  });
});

test("stop aborts idle waits and does not start the rest of an in-flight batch", async () => {
  await withFixture(async (origin) => {
    await request(origin, { action: "start", name: "idle" });
    await request(origin, { action: "sleeping" });
    await request(origin, { action: "stop", name: "idle" });
    await request(origin, { action: "stop", name: "idle" });
    expect((await request(origin, { action: "done", name: "idle" })).result.error).toBeNull();
    await request(origin, { action: "add", id: 1 });
    await request(origin, { action: "add", id: 2 });
    await request(origin, { action: "start", name: "batch", hold: true, batchSize: 2 });
    await request(origin, { action: "wait-started", count: 1 });
    await request(origin, { action: "stop", name: "batch" });
    await request(origin, { action: "release", name: "batch" });
    await request(origin, { action: "done", name: "batch" });
    await request(origin, { action: "advance", ms: 1000 });
    expect((await request(origin, { action: "state" })).result.started).toEqual([
      { loop: "batch", id: "1", inTransaction: false },
    ]);
  });
});

test("reports processing failures without automatically replaying them and handles a stopped signal", async () => {
  await withFixture(async (origin) => {
    await request(origin, { action: "add", id: 1 });
    await request(origin, { action: "start", name: "aborted", aborted: true });
    expect((await request(origin, { action: "done", name: "aborted" })).result.error).toBeNull();
    await request(origin, { action: "start", name: "failure", fail: true });
    expect((await request(origin, { action: "done", name: "failure" })).result.error).toMatch(
      /fixture processing failed/,
    );
    await request(origin, { action: "advance", ms: 1000 });
    const state = (await request(origin, { action: "state" })).result;
    expect(state.started).toHaveLength(1);
    expect(state.failures).toHaveLength(1);
  });
});

test("rejects invalid interval, lease and batch options", async () => {
  await withFixture(async (origin) => {
    for (const options of [
      { intervalMs: 0 },
      { leaseMs: -1 },
      { batchSize: 1.5 },
      { batchSize: 0 },
    ]) {
      expect((await request(origin, { action: "start", name: "invalid", ...options })).status).toBe(
        400,
      );
    }
  });
});

test("idle polling follows the injected clock", async () => {
  await withFixture(async (origin) => {
    await request(origin, { action: "start", name: "clock", hold: true, intervalMs: 100 });
    await request(origin, { action: "sleeping" });
    await request(origin, { action: "add", id: 9 });
    await request(origin, { action: "advance", ms: 99 });
    expect((await request(origin, { action: "state" })).result.started).toEqual([]);
    await request(origin, { action: "advance", ms: 1 });
    await request(origin, { action: "wait-started", count: 1 });
    expect((await request(origin, { action: "state" })).result.started).toEqual([
      { loop: "clock", id: "9", inTransaction: false },
    ]);
    await request(origin, { action: "stop", name: "clock" });
    await request(origin, { action: "release", name: "clock" });
    await request(origin, { action: "done", name: "clock" });
  });
});
