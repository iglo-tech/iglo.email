// B118a: the dispatcher keeps its start schedule in memory, so a start has no record of the sends
// before it. The first send after a start waits one interval, as the send after any other start does.
import { afterEach, describe, expect, test } from "bun:test";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";
import { fixtureEmailer, sinkMessage, sinkServer } from "@/test/messaging/sender";
import type { FixtureEmailer } from "@/test/messaging/sender";

/** Lets the dispatcher's promise callbacks run; no injected time passes. */
const flush = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) {
    await close();
  }
});

async function harness(clock: TestClock, rate: number) {
  const sink = await startSink({ clock });
  open.push(() => sink.close());
  const starts: Array<number> = [];
  const make = (): FixtureEmailer => {
    const emailer = fixtureEmailer({
      clock,
      rate: () => rate,
      settings: () => ({ smtp: [sinkServer(sink.port)], rootUrl: "https://example.test" }),
      onStart: () => starts.push(clock.now().getTime()),
    });
    open.push(() => emailer.close());
    return emailer;
  };
  return { sink, starts, make };
}

describe("B118a: send-rate restart boundary", () => {
  test("the first start after a start of the dispatcher waits one interval", async () => {
    const clock = new TestClock();
    const h = await harness(clock, 1);
    const emailer = h.make();
    void emailer.push(sinkMessage("a@example.test"));

    await flush();
    expect(h.starts).toEqual([]);
    clock.advance(999);
    await flush();
    expect(h.starts).toEqual([]);
    clock.advance(1);
    await flush();
    expect(h.starts).toEqual([clock.now().getTime()]);
  });

  test("a dispatcher started after a send does not follow that send at once", async () => {
    const clock = new TestClock();
    const h = await harness(clock, 1);
    const before = h.make();
    void before.push(sinkMessage("a@example.test"));
    clock.advance(1000);
    await flush();
    expect(h.starts.length).toBe(1);
    const previous = h.starts[0]!;

    // The restart: 50 ms after that send, a new dispatcher with no record of it.
    clock.advance(50);
    await before.close();
    const restartedAt = clock.now().getTime();
    const restarted = h.make();
    void restarted.push(sinkMessage("b@example.test"));

    await flush();
    expect(h.starts.length).toBe(1);
    clock.advance(999);
    await flush();
    expect(h.starts.length).toBe(1);
    clock.advance(1);
    await flush();
    expect(h.starts[1]).toBe(restartedAt + 1000);
    expect(h.starts[1]! - previous).toBeGreaterThanOrEqual(1000);
  });

  test("the interval counts from the first send asked for, not from the dispatcher's creation", async () => {
    // B149b (B141 r1): the instance builds the dispatcher before its projects open, which can take
    // longer than one interval at a low rate.
    const clock = new TestClock();
    const h = await harness(clock, 1);
    const emailer = h.make();
    clock.advance(5000);
    const askedAt = clock.now().getTime();
    void emailer.push(sinkMessage("a@example.test"));

    await flush();
    expect(h.starts).toEqual([]);
    clock.advance(999);
    await flush();
    expect(h.starts).toEqual([]);
    clock.advance(1);
    await flush();
    expect(h.starts).toEqual([askedAt + 1000]);
  });

  test("a rate of zero starts at once and sets no wait", async () => {
    const clock = new TestClock();
    const h = await harness(clock, 0);
    const emailer = h.make();
    void emailer.push(sinkMessage("a@example.test"));
    await flush();
    expect(h.starts).toEqual([clock.now().getTime()]);
  });
});
