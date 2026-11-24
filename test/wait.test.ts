// The shared state wait (B118d). Progress is observed in real time, so these tests take real
// milliseconds: the stall windows are short on purpose.
import { expect, test } from "bun:test";
import { untilState } from "@/test/wait";

test("a state reached while progress keeps moving resolves, however long that takes", async () => {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 20);
  try {
    // Ten ticks take about 200 ms, longer than the 100 ms stall window: a change in progress keeps
    // the wait going, so only a stall fails it.
    await untilState(() => ticks >= 10, {
      label: "moving",
      progress: () => String(ticks),
      stallMs: 100,
    });
    expect(ticks).toBeGreaterThanOrEqual(10);
  } finally {
    clearInterval(timer);
  }
});

test("a stall is timed from the last change, not from the start of the wait", async () => {
  // Progress changes at 200 ms and the state is reached at 500 ms. The stall window is 400 ms:
  // counted from the last change, the wait is fine at 500 ms (it would fail at 600 ms); counted
  // from the start, it would have failed at 400 ms. Mutation: the reset of movedAt removed.
  let moved = "a";
  let reached = false;
  const changes = setTimeout(() => {
    moved = "b";
  }, 200);
  const done = setTimeout(() => {
    reached = true;
  }, 500);
  try {
    await untilState(() => reached, { label: "late change", progress: () => moved, stallMs: 400 });
  } finally {
    clearTimeout(changes);
    clearTimeout(done);
  }
  expect(reached).toBe(true);
});

test("progress that stops fails by name, with the state the caller describes", async () => {
  const error = await untilState(() => false, {
    label: "rows settle",
    progress: () => "rows: 3 sending",
    stallMs: 100,
    describe: () => "3 rows still sending",
  }).then(() => "resolved", String);
  expect(error).toContain("rows settle: no progress for 100 ms (rows: 3 sending)");
  expect(error).toContain("3 rows still sending");
});

test("a state that is already reached resolves at once", async () => {
  const started = performance.now();
  await untilState(() => true, { label: "done", progress: () => "", stallMs: 5000 });
  expect(performance.now() - started).toBeLessThan(1000);
});
