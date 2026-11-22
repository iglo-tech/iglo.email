// Deeply nested lists in the text/plain alternative (B135 review, blocker 3, D118). An item is indented by
// its list depth, capped at eight levels. When the indented text would be longer than the HTML, the text is
// written without indentation, as main writes it, so the message keeps its text part (D134). Each pass stops
// growing once it passes the HTML's size, so the time and memory stay linear in the input.
import { expect, test } from "bun:test";
import { plainText } from "@/messaging/plain";
import { createMessageBudget } from "@/templates/renderer";

const text = (html: string) => plainText(html, createMessageBudget());

/** `depth` lists open, then `items` items: the worst shape for an indent that grows with depth. */
const deepLists = (size: number) =>
  "<ul>".repeat(1000) + "<li>x</li>".repeat(Math.floor(size / 11));

/** The median of three runs, so one slow run on a loaded host does not decide the ratio. */
async function medianTime(size: number) {
  const samples: Array<number> = [];
  for (let run = 0; run < 3; run++) {
    const started = performance.now();
    await text(deepLists(size));
    samples.push(performance.now() - started);
  }
  return samples.sort((a, b) => a - b)[1]!;
}

/** One item inside `levels` open lists. */
const nestedItem = (levels: number) =>
  "<ul>".repeat(levels) + "<li>x</li>" + "</ul>".repeat(levels);

test("a list nested past the indent cap is indented as at the cap: eight levels, two spaces each", async () => {
  // Nine and twelve levels deep indent alike, and that indent is the eight-level cap.
  expect(await text(nestedItem(9))).toBe(await text(nestedItem(12)));
  expect(await text(nestedItem(12))).toBe(" ".repeat(16) + "- x");
});

test("1 MB of deeply nested lists costs at most 32x the time of 64 KB, for 16x the input", async () => {
  const small = await medianTime(64 * 1024);
  const large = await medianTime(1024 * 1024);
  expect(large / Math.max(small, 5)).toBeLessThanOrEqual(32);
});

/** The unindented text of `count` short items, one bullet per line, as main writes a list. */
const bullets = (count: number) => Array.from({ length: count }, () => "- x").join("\n");

test("short items in deep lists: indented, the text would be longer than the HTML, so it is written unindented", async () => {
  // 1000 open lists and 400 items: indented, the output is about 10,000 characters against 8,400 bytes of
  // HTML; unindented, about 3,600. The text part is the unindented one, as main writes it.
  const html = "<ul>".repeat(1000) + "<li>x</li>".repeat(400);
  expect(await text(html)).toBe(bullets(400));
});

test("1 MB of deeply nested lists keeps its text part, unindented, as main writes it", async () => {
  const items = Math.floor((1024 * 1024) / 11);
  expect(await text(deepLists(1024 * 1024))).toBe(bullets(items));
});
