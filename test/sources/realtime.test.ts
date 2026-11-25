// B150b (15-external-sources section 4, D171): the realtime client's server-sent events parser on
// an injected byte stream. A line over the limit is dropped up to its end and its message marked
// oversized; a message's data lines together are bounded the same way; the next message is whole.
import { expect, test } from "bun:test";
import { MAX_LINE, sseMessages } from "@/sources/realtime";
import type { SseMessage } from "@/sources/realtime";

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
