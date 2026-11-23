// B118a: the send-rate limiter keeps its schedule in memory, so a start has no record of the sends
// before it. The first send after a start waits one interval, as the send after any other grant does.
import { describe, expect, test } from "bun:test";
import { createSendRateLimiter } from "@/messaging/rate";
import { TestClock } from "@/test/server/fixture";

/** Lets the limiter's promise callbacks run; no injected time passes. */
const flush = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe("B118a: send-rate restart boundary", () => {
  test("the first grant after a start waits one interval", async () => {
    const clock = new TestClock();
    const limiter = createSendRateLimiter({ clock, rate: () => 1 });
    let grantedAt: number | undefined;
    void limiter.acquire().then(() => {
      grantedAt = clock.now().getTime();
    });

    await flush();
    expect(grantedAt).toBeUndefined();
    clock.advance(999);
    await flush();
    expect(grantedAt).toBeUndefined();
    clock.advance(1);
    await flush();
    expect(grantedAt).toBe(clock.now().getTime());
  });

  test("a limiter started after a send does not follow that send at once", async () => {
    const clock = new TestClock();
    const before = createSendRateLimiter({ clock, rate: () => 1 });
    let previous: number | undefined;
    void before.acquire().then(() => {
      previous = clock.now().getTime();
    });
    clock.advance(1000);
    await flush();
    expect(previous).toBe(clock.now().getTime());

    // The restart: 50 ms after that send, a new limiter with no record of it.
    clock.advance(50);
    before.stop();
    const restartedAt = clock.now().getTime();
    const restarted = createSendRateLimiter({ clock, rate: () => 1 });
    let first: number | undefined;
    void restarted.acquire().then(() => {
      first = clock.now().getTime();
    });

    await flush();
    expect(first).toBeUndefined();
    clock.advance(999);
    await flush();
    expect(first).toBeUndefined();
    clock.advance(1);
    await flush();
    expect(first).toBe(restartedAt + 1000);
    expect(first! - previous!).toBeGreaterThanOrEqual(1000);
  });

  test("a rate of zero grants at once and sets no wait", async () => {
    const clock = new TestClock();
    const limiter = createSendRateLimiter({ clock, rate: () => 0 });
    let granted = false;
    void limiter.acquire().then(() => {
      granted = true;
    });
    await flush();
    expect(granted).toBe(true);
  });
});
