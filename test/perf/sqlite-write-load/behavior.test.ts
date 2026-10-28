// Specification for the synthetic-only HTTP fixture, not a production endpoint.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSpikeFixture } from "@/test/perf/sqlite-write-load/fixture";

async function request(origin: string, input: object) {
  const response = await fetch(`${origin}/synthetic/write-load`, {
    method: "POST",
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(3000),
  });
  return {
    status: response.status,
    ...((await response.json()) as { result?: any; error?: string }),
  };
}

async function withFixture(fn: (origin: string, reopen: () => Promise<string>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "iglo-spike-contract-"));
  let fixture = startSpikeFixture(directory);
  try {
    await fn(fixture.origin, async () => {
      await fixture.close();
      fixture = startSpikeFixture(directory);
      return fixture.origin;
    });
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("reservation is durable before processing, bounded, ordered and never replayed on reopen", async () => {
  await withFixture(async (origin, reopen) => {
    expect((await request(origin, { action: "setup", subscribers: 5 })).status).toBe(200);
    expect((await request(origin, { action: "status" })).result).toMatchObject({
      journal: "wal",
      foreignKeys: "1",
      synchronous: "2",
      timeout: "5000",
      safeInteger: "9223372036854775807",
      cursor: 0,
      sent: 0,
      events: 0,
      integrity: "ok",
      foreignKeyErrors: 0,
    });
    expect((await request(origin, { action: "reserve", count: 3 })).result).toEqual([1, 2, 3]);
    expect((await request(origin, { action: "status" })).result).toMatchObject({
      cursor: 3,
      sent: 0,
    });
    expect((await request(origin, { action: "process", count: 1 })).result).toEqual({
      sent: 1,
      inTransaction: false,
    });
    const restarted = await reopen();
    expect((await request(restarted, { action: "status" })).result).toMatchObject({
      cursor: 3,
      sent: 1,
    });
    expect((await request(restarted, { action: "reserve", count: 3 })).result).toEqual([4, 5]);
    expect((await request(restarted, { action: "status" })).result).toMatchObject({
      cursor: 5,
      sent: 1,
    });
  });
});

test("event batches are atomic, unique per subscriber and remain after reopening", async () => {
  await withFixture(async (origin, reopen) => {
    await request(origin, { action: "setup", subscribers: 5 });
    const one = { subscriber: 1, key: "same", sequence: 1 };
    expect((await request(origin, { action: "events", events: [one, one] })).status).toBe(400);
    expect((await request(origin, { action: "status" })).result.events).toBe(0);
    expect(
      (
        await request(origin, {
          action: "events",
          events: [one, { subscriber: 2, key: "same", sequence: 2 }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(origin, {
          action: "events",
          events: [{ subscriber: 9, key: "missing", sequence: 3 }],
        })
      ).status,
    ).toBe(400);
    const restarted = await reopen();
    expect((await request(restarted, { action: "status" })).result).toMatchObject({
      events: 2,
      distinctEvents: 2,
      integrity: "ok",
      foreignKeyErrors: 0,
    });
  });
});

test("FTS follows insert, update and delete, including transaction rollback", async () => {
  await withFixture(async (origin, reopen) => {
    await request(origin, { action: "setup", subscribers: 5 });
    await request(origin, {
      action: "subscriber",
      operation: "insert",
      id: 20,
      name: "Zebra original",
      email: "original@example.test",
    });
    expect((await request(origin, { action: "search", term: "zebra" })).result).toEqual([20]);
    await request(origin, {
      action: "subscriber",
      operation: "update",
      id: 20,
      name: "Otter changed",
      email: "changed@example.test",
    });
    expect((await request(origin, { action: "search", term: "zebra" })).result).toEqual([]);
    expect((await request(origin, { action: "search", term: "changed" })).result).toEqual([20]);
    expect(
      (await request(origin, { action: "subscriber", operation: "delete", id: 20, rollback: true }))
        .status,
    ).toBe(200);
    expect((await request(origin, { action: "search", term: "otter" })).result).toEqual([20]);
    await request(origin, {
      action: "subscriber",
      operation: "update",
      id: 20,
      name: "Badger rollback",
      email: "rollback@example.test",
      rollback: true,
    });
    expect((await request(origin, { action: "search", term: "badger" })).result).toEqual([]);
    await request(origin, { action: "subscriber", operation: "delete", id: 20 });
    await request(origin, {
      action: "subscriber",
      operation: "insert",
      id: 21,
      name: "Marten rollback",
      email: "marten@example.test",
      rollback: true,
    });
    const restarted = await reopen();
    expect((await request(restarted, { action: "search", term: "otter" })).result).toEqual([]);
    expect((await request(restarted, { action: "search", term: "marten" })).result).toEqual([]);
    expect((await request(restarted, { action: "status" })).result).toMatchObject({
      integrity: "ok",
      foreignKeyErrors: 0,
    });
  });
});

test("independent fixed deadlines use the injected clock and exclude catch-up from the window", async () => {
  await withFixture(async (origin) => {
    await request(origin, { action: "setup", subscribers: 200 });
    await request(origin, { action: "start", durationMs: 1000, mode: "batch" });
    await request(origin, { action: "advance", ms: 200 });
    const first = (await request(origin, { action: "workload" })).result;
    expect(first.offeredCampaign).toBe(11);
    expect(first.offeredEvents).toBe(21);
    expect(first.completedCampaign).toBe(11);
    expect(first.committedEvents).toBe(21);
    await request(origin, { action: "advance", ms: 800 });
    const window = (await request(origin, { action: "workload" })).result;
    expect(window.offeredCampaign).toBe(50);
    expect(window.offeredEvents).toBe(100);
    expect(window.completedCampaign).toBe(11);
    expect(window.committedEvents).toBe(21);
    expect(window.campaignBacklog).toBe(39);
    expect(window.eventBacklog).toBe(79);
    await request(origin, { action: "drain" });
    const drained = (await request(origin, { action: "workload" })).result;
    expect(drained.completedCampaign).toBe(11);
    expect(drained.committedEvents).toBe(21);
    expect(drained.drainedCampaign).toBe(39);
    expect(drained.drainedEvents).toBe(79);
    expect((await request(origin, { action: "status" })).result).toMatchObject({
      cursor: 50,
      sent: 50,
      events: 100,
      distinctEvents: 100,
    });
  });
});
