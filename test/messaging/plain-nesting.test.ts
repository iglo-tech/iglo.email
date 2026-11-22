// Deeply nested lists in the text/plain alternative (B135 review, blocker 3, D118). An item is indented by
// its list depth, capped at eight levels, and the output stops growing once it passes the HTML's size, so the
// time and memory stay linear in the input. The 1 MB case gives no text part, as any over-long conversion does.
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

test("1 MB of deeply nested lists gives no text part, since the text would be longer than the HTML", async () => {
  expect(await text(deepLists(1024 * 1024))).toBe("");
});
