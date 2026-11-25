// B141 (14-projects sections 7 and 15, D155): the instance dispatcher's start schedule, through its
// senders and the test SMTP sink, on the injected clock. Each project here is a sender with a loop
// that does what the outbox and the campaign runner do: ask for slots, claim at most that many,
// push each in its slot, return the rest. The sink stamps each receipt with the injected clock, and
// the clock moves only once every started message has reached the sink and every loop has settled,
// so a receipt's stamp is its start and nothing waits on real time.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { createDispatcher, HORIZON_MS, UNPACED_BOUND } from "@/messaging/dispatcher";
import type { Grant, GrantClass, Sender, StartClass } from "@/messaging/dispatcher";
import type { SMTPServer } from "@/messaging/email";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";
import { sinkMessage, sinkServer } from "@/test/messaging/sender";

setDefaultTimeout(60_000);

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const turns = async (count = 5) => {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

/** The project a sink receipt belongs to: its recipient is `<project>-<n>@example.test`. */
const projectOf = (to: string) => to.split("-")[0] ?? "";

async function harness(rate: number, smtp?: () => Array<SMTPServer>) {
  const clock = new TestClock();
  const sink = await startSink({ clock });
  const starts: Array<{ cls: StartClass; at: number }> = [];
  const dispatcher = createDispatcher({
    clock,
    smtp: smtp ?? (() => [sinkServer(sink.port)]),
    rate: () => rate,
    onStart: (cls) => starts.push({ cls, at: clock.now().getTime() }),
  });
  /** Pushes settled, across every loop and test: the clock waits until every started one has. */
  let finished = 0;
  const loops: Array<{ stop(): void; done: Promise<void> }> = [];
  cleanup.push(async () => {
    for (const loop of loops) {
      loop.stop();
    }
    await dispatcher.close();
    await Promise.all(loops.map((loop) => loop.done));
    await sink.close();
  });
  const project = (slug: string): Sender =>
    dispatcher.sender({
      rootUrl: () => `https://${slug}.example.test`,
      copyAllowed: () => true,
      refuse: () => {},
    });
  /**
   * What the outbox's marketing loop and the campaign runner do: ask for up to `ask` slots, take
   * at most what is left of `total`, push each in its slot, wait for the batch, return the rest.
   */
  const loop = (
    sender: Sender,
    slug: string,
    cls: GrantClass,
    total = Number.POSITIVE_INFINITY,
  ) => {
    let stopped = false;
    let sent = 0;
    const done = (async () => {
      while (!stopped && sent < total) {
        let grant: Grant;
        try {
          grant = await sender.request(cls, cls === "campaign" ? 100 : 10);
        } catch {
          return;
        }
        const count = Math.min(grant.count, total - sent);
        grant.keep(count);
        const results = Array.from({ length: count }, (_, i) =>
          track(
            sender.push(sinkMessage(`${slug}-${sent + i}@example.test`), { copies: false, grant }),
          ),
        );
        sent += count;
        await Promise.all(results);
        grant.release();
      }
    })();
    const handle = {
      stop: () => {
        stopped = true;
      },
      done,
      get sent() {
        return sent;
      },
    };
    loops.push(handle);
    return handle;
  };
  /** A push whose settling the clock waits for once it has started. */
  function track(dispatch: { result: Promise<unknown> }) {
    return dispatch.result.finally(() => {
      finished++;
    });
  }
  const received = () => sink.messages.map((message) => projectOf(message.to[0] ?? ""));
  /** Every started message reached the sink, and every loop has answered its batch. */
  const settled = async () => {
    const end = Date.now() + 20_000;
    for (;;) {
      await turns();
      if (sink.messages.length >= starts.length && finished >= starts.length) {
        await turns();
        if (sink.messages.length >= starts.length && finished >= starts.length) {
          return;
        }
      }
      if (Date.now() > end) {
        throw new Error(`stuck: ${starts.length} starts, ${sink.messages.length} received`);
      }
      await Bun.sleep(1);
    }
  };
  /** Steps the injected clock by `step` until `done`, each step once everything has settled. */
  const drive = async (done: () => boolean, step: number) => {
    const end = Date.now() + 50_000;
    while (!done()) {
      if (Date.now() > end) {
        throw new Error(`drive: ${starts.length} starts, ${received().join(",").slice(-200)}`);
      }
      await settled();
      if (done()) {
        return;
      }
      clock.advance(step);
    }
    await settled();
  };
  return { clock, sink, dispatcher, starts, project, loop, track, received, settled, drive };
}

describe("B141: dispatcher", () => {
  test("priority and fairness: transactional first, marketing before campaign, campaigns take turns", async () => {
    const rate = 10;
    const interval = 1000 / rate;
    const h = await harness(rate);
    const a = h.project("a");
    const b = h.project("b");
    const c = h.project("c");
    const d = h.project("d");
    // Project a runs a 10,000-recipient campaign.
    h.loop(a, "a", "campaign", 10_000);
    await h.drive(() => h.received().length >= 25, 10);

    // Project b queues 50 marketing sends; project c makes a transactional call while they wait.
    const before = h.received().length;
    const marketing = h.loop(b, "b", "marketing", 50);
    await h.drive(() => h.received().length >= before + 5, 10);
    const askedAt = h.clock.now().getTime();
    void h.track(c.push(sinkMessage("c-0@example.test")));
    await h.drive(
      () => h.received().includes("c") || h.clock.now().getTime() > askedAt + 2 * HORIZON_MS,
      10,
    );
    const receipt = h.sink.messages.find((message) => message.to[0] === "c-0@example.test");
    // C starts within the horizon plus one slot.
    expect(receipt).toBeDefined();
    expect(receipt!.at! - askedAt).toBeLessThanOrEqual(HORIZON_MS + interval);
    await h.drive(
      () => marketing.sent === 50 && h.received().filter((p) => p === "b").length === 50,
      10,
    );
    // All of b's 50 started before a got 50 more slots.
    const during = h.received().slice(before);
    const lastB = during.lastIndexOf("b");
    expect(during.slice(0, lastB).filter((p) => p === "a").length).toBeLessThan(50);

    // A second campaign, in project d: from its first start on, the two take turns, within ±1.
    const firstOfD = h.received().length;
    h.loop(d, "d", "campaign", 10_000);
    await h.drive(() => h.received().length >= firstOfD + 200, 10);
    const turnsTaken = h.received().slice(firstOfD);
    const fromD = turnsTaken.indexOf("d");
    expect(fromD).toBeGreaterThanOrEqual(0);
    let ofA = 0;
    let ofD = 0;
    for (const p of turnsTaken.slice(fromD)) {
      if (p === "a") {
        ofA++;
      } else if (p === "d") {
        ofD++;
      }
      expect(Math.abs(ofA - ofD)).toBeLessThanOrEqual(1);
    }
    expect(ofD).toBeGreaterThanOrEqual(99);
  });

  test("no double pacing: 60 s at rate 10 is 600 ± 1 starts, with no gap over two intervals", async () => {
    const rate = 10;
    const interval = 1000 / rate;
    const h = await harness(rate);
    h.loop(h.project("a"), "a", "campaign");
    h.loop(h.project("b"), "b", "campaign");
    // Marketing goes before campaign work while it has any; 100 leaves the rest to the campaigns.
    h.loop(h.project("m"), "m", "marketing", 100);
    const t = h.project("t");
    // Warm up past the first interval after the start (B118a).
    await h.drive(() => h.starts.length >= 5, 50);
    const from = h.clock.now().getTime();
    let nextTx = from;
    await h.drive(() => {
      // A transactional push every 1.3 s competes for the same slots.
      if (h.clock.now().getTime() >= nextTx) {
        void h.track(t.push(sinkMessage(`t-${nextTx}@example.test`)));
        nextTx += 1300;
      }
      return h.clock.now().getTime() >= from + 60_000;
    }, 50);
    const window = h.starts.filter((s) => s.at >= from && s.at < from + 60_000);
    expect(Math.abs(window.length - 600)).toBeLessThanOrEqual(1);
    for (let i = 1; i < window.length; i++) {
      expect(window[i]!.at - window[i - 1]!.at).toBeLessThanOrEqual(2 * interval);
    }
    // Every class got starts: none of them was paced twice into silence.
    expect(new Set(window.map((s) => s.cls))).toEqual(
      new Set<StartClass>(["transactional", "marketing", "campaign"]),
    );
  });

  test("rate 0: grants follow class order, and reserved plus in-flight never exceeds 200", async () => {
    // An SMTP server that accepts and never greets: every started push stays in flight until its
    // 60 s deadline on the injected clock.
    const sockets = new Set<Socket>();
    const silent: Server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      silent.listen(0, "127.0.0.1", resolve);
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          silent.close(() => resolve());
        }),
    );
    const address = silent.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const h = await harness(0, () => [sinkServer(port)]);
    const a = h.project("a");
    const b = h.project("b");
    const c = h.project("c");
    const m = h.project("m");
    const order: Array<string> = [];
    const held: Record<string, number> = {};
    const ask = (sender: Sender, name: string, cls: GrantClass, count: number) =>
      sender.request(cls, count).then((grant) => {
        order.push(name);
        held[name] = grant.count;
        return grant;
      });
    // a and b take 100 each and push them: they start at once, unpaced, and stay in flight.
    const first = await ask(a, "a", "campaign", 100);
    const pushed = Array.from(
      { length: first.count },
      (_, i) => a.push(sinkMessage(`a-${i}@example.test`), { copies: false, grant: first }).result,
    );
    await ask(b, "b", "campaign", 100);
    expect(h.starts.length).toBe(100);
    // The bound is full: c's campaign request, then m's marketing request, wait.
    const later = ask(c, "c", "campaign", 100);
    const marketing = ask(m, "m", "marketing", 10);
    await turns();
    expect(order).toEqual(["a", "b"]);
    expect(held.a! + held.b!).toBe(UNPACED_BOUND);
    // The in-flight pushes end at their deadline: the room goes to marketing first.
    h.clock.advance(60_000);
    await Promise.all(pushed);
    await marketing;
    await later;
    expect(order).toEqual(["a", "b", "m", "c"]);
    // Reserved (b's 100, m's and c's grants) plus in flight (none now) stays within the bound.
    expect(held.b! + held.m! + held.c!).toBeLessThanOrEqual(UNPACED_BOUND);
    expect(held.m).toBeGreaterThanOrEqual(1);
  });
});
