import { expect, test } from "bun:test";
import { TestClock } from "@/test/server/fixture";
import { createByteGate } from "@/tx/gate";

const gate = (clock = new TestClock(), options: { maxBytes?: number; maxWaiters?: number } = {}) =>
  createByteGate({ clock, maxBytes: 100, maxHolders: 3, waitMs: 1000, ...options });

test("reservations are granted in arrival order and freed by release", async () => {
  const g = gate();
  const first = (await g.acquire(60))!;
  let order: string[] = [];
  const second = g.acquire(60).then((r) => (order.push("second"), r));
  // A small request behind a waiting one does not jump the queue.
  const third = g.acquire(10).then((r) => (order.push("third"), r));
  await Bun.sleep(0);
  expect(order).toEqual([]);
  first.release();
  first.release(); // idempotent
  const [b, c] = await Promise.all([second, third]);
  expect(order).toEqual(["second", "third"]);
  expect(g.stats()).toEqual({ bytes: 70, holders: 2, waiting: 0 });
  b!.release();
  c!.release();
  expect(g.stats()).toEqual({ bytes: 0, holders: 0, waiting: 0 });
});

test("a wait ends with null at the injected deadline, and the queue moves on", async () => {
  const clock = new TestClock();
  const g = gate(clock);
  const held = (await g.acquire(90))!;
  const waiter = g.acquire(50);
  await clock.whenSleeping();
  clock.advance(999);
  await Bun.sleep(0);
  expect(g.stats().waiting).toBe(1);
  clock.advance(1);
  expect(await waiter).toBeNull();
  expect(g.stats()).toEqual({ bytes: 90, holders: 1, waiting: 0 });
  held.release();
});

test("a cost over the budget, a full queue and a full holder count are refused", async () => {
  const g = gate(new TestClock(), { maxWaiters: 1 });
  expect(await g.acquire(101)).toBeNull();
  const a = (await g.acquire(100))!;
  const waiting = g.acquire(1);
  expect(await g.acquire(1)).toBeNull();
  a.release();
  (await waiting)!.release();
  const three = [await g.acquire(1), await g.acquire(1), await g.acquire(1)];
  expect(g.tryAcquire(1)).toBeNull();
  for (const r of three) r!.release();
});

test("grow never waits, shrink wakes a waiter, and a released reservation holds nothing", async () => {
  const g = gate();
  const r = (await g.acquire(40))!;
  expect(r.grow(60)).toBe(true);
  expect(r.grow(1)).toBe(false);
  expect(r.bytes).toBe(100);
  const waiter = g.acquire(30);
  r.shrink(50);
  const w = (await waiter)!;
  expect(g.stats().bytes).toBe(80);
  r.release();
  expect(r.grow(1)).toBe(false);
  w.release();
  expect(g.stats()).toEqual({ bytes: 0, holders: 0, waiting: 0 });
});
