// Readiness of a child process is a stall window on its CPU time, not a total budget (B118g): a start
// that is slow but still working keeps its window open, and one that hangs fails by name at the stall.
import { expect, setDefaultTimeout, test } from "bun:test";
import { healthWhenReady, startOnFreePort, stopChild } from "@/test/serve-port";

// A stall of one second fails by name before this timeout; a busy start takes about three.
setDefaultTimeout(30_000);

/** A child that serves /health on `port` after `ms`: busy (uses CPU) or idle (sleeps). */
function child(port: number, mode: "busy" | "idle", ms: number) {
  const wait =
    mode === "busy"
      ? `const end = Date.now() + ${ms}; while (Date.now() < end) {}`
      : `await Bun.sleep(${ms});`;
  const code = `(async () => { ${wait} Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("ok") }); })();`;
  return Bun.spawn({ cmd: [process.execPath, "-e", code], stdout: "ignore", stderr: "pipe" });
}

test("a child that is still working past the stall window is ready, not cut off by its total time", async () => {
  const status = await startOnFreePort(async (port) => {
    const started = child(port, "busy", 2500);
    try {
      return (await healthWhenReady(started, port, 1000)).status;
    } finally {
      await stopChild(started, "SIGKILL");
    }
  });
  expect(status).toBe(200);
}, 30_000);

test("a child that hangs without work fails at the stall window, by name", async () => {
  const failure = await startOnFreePort(async (port) => {
    const started = child(port, "idle", 6000);
    try {
      await healthWhenReady(started, port, 1000);
      return "ready";
    } catch (error) {
      return String(error);
    } finally {
      await stopChild(started, "SIGKILL");
    }
  });
  expect(failure).toMatch(/Server ready: no progress for 1000 ms/);
}, 30_000);
