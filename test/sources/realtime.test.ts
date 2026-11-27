// B150b (15-external-sources section 4, D171): the realtime client's server-sent events parser on
// an injected byte stream. A line over the limit is dropped up to its end and its message marked
// oversized; a message's data lines together are bounded the same way; the next message is whole.
// B166 (D194): the connect gives up on its deadline (injected clock) or a stop while the guard's
// address lookup never answers, and cancels the body of a response that comes too late.
import { expect, test } from "bun:test";
import type { Guard } from "@/sources/connect";
import { CONNECT_TIMEOUT_MS, MAX_LINE, openRealtime, sseMessages } from "@/sources/realtime";
import type { SseMessage } from "@/sources/realtime";
import { TestClock } from "@/test/server/fixture";

async function* chunks(parts: ReadonlyArray<string>) {
  const encoder = new TextEncoder();
  for (const part of parts) {
    yield encoder.encode(part);
  }
}

async function parse(parts: ReadonlyArray<string>, maxLine: number) {
  const messages: Array<SseMessage> = [];
  for await (const message of sseMessages(chunks(parts), maxLine)) {
    messages.push(message);
  }
  return messages;
}

const ok = { event: "b", data: "ok", oversized: false };

test("a data line over the limit, split across chunks, is dropped; the next message is whole", async () => {
  const parts = ["event: a\ndata: ", "x".repeat(60), "x".repeat(60), "\n\nevent: b\ndata: ok\n\n"];
  expect(await parse(parts, 100)).toEqual([{ event: "a", data: "", oversized: true }, ok]);
});

test("a line over the limit that is not data still marks its message", async () => {
  const parts = [`event: ${"e".repeat(150)}\n`, "data: small\n\nevent: b\ndata: ok\n\n"];
  expect(await parse(parts, 100)).toEqual([{ event: "message", data: "", oversized: true }, ok]);
});

test("data lines over the limit together mark the message", async () => {
  const line = `data: ${"x".repeat(40)}\n`;
  const parts = [`event: a\n${line}${line}`, `${line}\nevent: b\ndata: ok\n\n`];
  expect(await parse(parts, 100)).toEqual([{ event: "a", data: "", oversized: true }, ok]);
});

test("CRLF line ends, split anywhere", async () => {
  const parts = ["event: a\r", "\ndata: one\r\nda", "ta: two\r\n\r", "\n"];
  expect(await parse(parts, 100)).toEqual([{ event: "a", data: "one\ntwo", oversized: false }]);
});

test("a line with no end is not held: memory stays bounded while it streams", async () => {
  // 128 MiB without a line end, then a normal message. The parser holds at most one limit of it.
  const block = new TextEncoder().encode("x".repeat(64 * 1024));
  let heapWhileStreaming = 0;
  async function* endless() {
    yield new TextEncoder().encode("event: a\ndata: ");
    for (let i = 0; i < 2048; i++) {
      yield block;
    }
    Bun.gc(true);
    heapWhileStreaming = process.memoryUsage().heapUsed;
    yield new TextEncoder().encode("\n\nevent: b\ndata: ok\n\n");
  }
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  const messages: Array<SseMessage> = [];
  for await (const message of sseMessages(endless(), MAX_LINE)) {
    messages.push(message);
  }
  expect(messages).toEqual([{ event: "a", data: "", oversized: true }, ok]);
  expect(heapWhileStreaming - before).toBeLessThan(32 * 1024 * 1024);
});

test("the production limit is 1 MiB per line and per message", async () => {
  const chunk = "x".repeat(64 * 1024);
  const over = Array.from({ length: MAX_LINE / chunk.length + 1 }, () => chunk);
  const fits = "y".repeat(MAX_LINE - 100);
  const halves = `data: ${"z".repeat(MAX_LINE / 2)}\n`;
  const messages = await parse(
    [
      "event: a\ndata: ",
      ...over,
      "\n\n",
      `event: b\ndata: ${fits}\n\n`,
      `event: c\n${halves}${halves}\n`,
    ],
    MAX_LINE,
  );
  expect(messages.map(({ event, data, oversized }) => [event, data.length, oversized])).toEqual([
    ["a", 0, true],
    ["b", fits.length, false],
    ["c", 0, true],
  ]);
});

// ---------------------------------------------------------------------------------------------
// B166 (D194): a connect whose address lookup stalls.

const blocking: Guard = { blockPrivate: () => true, privateHosts: () => [] };

/** How `work` settled within `ms` of real time: its rejection's message, or "pending". */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<string> {
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("pending"), ms));
  return Promise.race([
    work.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
    timeout,
  ]);
}

test("B166: a connect whose address lookup never answers gives up at the connect deadline on the injected clock", async () => {
  const clock = new TestClock();
  const connecting = openRealtime({
    url: "http://stalled.example",
    guard: blocking,
    transport: { lookup: () => new Promise<Array<string>>(() => {}) },
    clock,
    signal: new AbortController().signal,
  });
  await clock.whenSleeping(1);
  expect(await settledWithin(connecting, 50)).toBe("pending");
  clock.advance(CONNECT_TIMEOUT_MS);
  expect(await settledWithin(connecting, 2000)).toBe("The realtime stream did not connect in time");
});

test("B166: a stop during a stalled lookup ends the connect at once; a response that comes later has its body cancelled", async () => {
  const clock = new TestClock();
  const stop = new AbortController();
  let answer!: (addresses: Array<string>) => void;
  let cancelled = false;
  const connecting = openRealtime({
    url: "http://stalled.example",
    guard: blocking,
    transport: {
      lookup: () =>
        new Promise<Array<string>>((resolve) => {
          answer = resolve;
        }),
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        ),
    },
    clock,
    signal: stop.signal,
  });
  await clock.whenSleeping(1);
  stop.abort(new Error("stopping"));
  expect(await settledWithin(connecting, 2000)).toBe("stopping");
  // The lookup answers after the stop with a public address: the response is not read.
  answer(["93.184.216.34"]);
  for (let i = 0; i < 100 && !cancelled; i++) {
    await Bun.sleep(10);
  }
  expect(cancelled).toBe(true);
});
