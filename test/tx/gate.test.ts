import { expect, test } from "bun:test";
import { TestClock } from "@/test/server/fixture";
import { createByteGate } from "@/tx/gate";

const gate = (
  clock = new TestClock(),
  options: {
    maxBytes?: number;
    maxWaiters?: number;
    maxHolders?: number;
    maxOvertakes?: number;
  } = {},
) => createByteGate({ clock, maxBytes: 100, maxHolders: 3, waitMs: 1000, ...options });

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
  expect(await g.admit(1)).toBeNull();
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

test("a steady stream of small admissions cannot starve a waiter past maxOvertakes", async () => {
  const clock = new TestClock();
  const g = gate(clock, { maxOvertakes: 3, maxHolders: 10 });
  const held = [(await g.acquire(70))!];
  const big = g.acquire(60);
  let bigDone = false;
  void big.then(() => (bigDone = true));
  // Three small sends fit beside the first holder and go ahead of the waiter.
  for (let i = 0; i < 3; i++) held.push((await g.admit(5))!);
  expect(g.stats()).toEqual({ bytes: 85, holders: 4, waiting: 1 });
  // The fourth queues behind the waiter instead of passing it.
  let late: Awaited<ReturnType<typeof g.admit>> | undefined;
  void g.admit(5).then((r) => (late = r));
  await Promise.resolve();
  expect(g.stats().waiting).toBe(2);
  // Everything ahead of the waiter leaves: the waiter gets its room first, then the late one.
  for (const r of held) r.release();
  const reservation = (await big)!;
  expect(bigDone).toBe(true);
  expect(reservation.bytes).toBe(60);
  await Promise.resolve();
  expect(late?.bytes).toBe(5);
  reservation.release();
  late?.release();
  expect(g.stats()).toEqual({ bytes: 0, holders: 0, waiting: 0 });
});

test("an admission queued behind a waiter takes the room when the waiter's wait ends", async () => {
  const clock = new TestClock();
  const g = gate(clock, { maxOvertakes: 0 });
  const held = (await g.acquire(90))!;
  const big = g.acquire(50);
  const small = g.admit(5);
  await clock.whenSleeping();
  clock.advance(1000);
  expect(await big).toBeNull();
  const reservation = (await small)!;
  expect(reservation.bytes).toBe(5);
  reservation.release();
  held.release();
});
