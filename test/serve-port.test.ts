// Readiness of a child process is a stall window on its CPU time, not a total budget (B118g): a start
// that is slow but still working keeps its window open, and one that hangs fails by name at the stall.
// Each child binds port 0 and names its port on a line, as the executable does (D144).
import { expect, setDefaultTimeout, test } from "bun:test";
import {
  captureOutput,
  healthWhenReady,
  readyOnPortZero,
  reportedPort,
  stopChild,
} from "@/test/serve-port";

// A stall of one second fails by name before this timeout; a busy start takes about three.
setDefaultTimeout(30_000);

/**
 * A child that binds port 0, names the port, and then does not answer for `ms`: it is busy (uses
 * CPU, and its event loop serves nothing) or it is idle (each answer waits without CPU).
 */
function child(mode: "busy" | "idle", ms: number) {
  const code =
    mode === "busy"
      ? `(async () => {
           const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
           await Bun.write(Bun.stdout, "listening on port " + server.port + "\\n");
           const end = Date.now() + ${ms}; while (Date.now() < end) {}
         })();`
      : `const ready = Bun.sleep(${ms});
         const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => { await ready; return new Response("ok"); } });
         process.stdout.write("listening on port " + server.port + "\\n");`;
  return Bun.spawn({ cmd: [process.execPath, "-e", code], stdout: "pipe", stderr: "pipe" });
}

test("a child that is still working past the stall window is ready, not cut off by its total time", async () => {
  const started = child("busy", 2500);
  try {
    const port = await reportedPort(started);
    expect((await healthWhenReady(started, port, 1000)).status).toBe(200);
  } finally {
    await stopChild(started, "SIGKILL");
  }
});

test("a child that hangs without work fails at the stall window, by name", async () => {
  const started = child("idle", 6000);
  try {
    const port = await reportedPort(started);
    const failure = await healthWhenReady(started, port, 1000).then(() => "ready", String);
    expect(failure).toMatch(/Server ready: no progress for 1000 ms/);
  } finally {
    await stopChild(started, "SIGKILL");
  }
});

/** A stdout that writes `chunks` one by one, as reads of a pipe can split one line. */
function stdoutOf(chunks: Array<string>) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        await Bun.sleep(10);
      }
      controller.close();
    },
  });
}

// A read can end inside the line. The port is read from a whole line only, so the part before the
// break does not give a wrong port. Mutation: the line pattern without its newline gives port 3.
test("a port line split inside the number gives the whole port", async () => {
  const output = captureOutput({ stdout: stdoutOf(["listening on port 3", "5195\n"]) });
  expect(await output.port).toBe(35_195);
  expect(await output.text).toBe("listening on port 35195\n");
});

test("a port line with no newline before stdout ends names no port", async () => {
  const output = captureOutput({ stdout: stdoutOf(["listening on port 3"]) });
  expect(await output.port.catch(String)).toContain("Server exited before it reported its port");
});

// The port wait is a stall window on the child's CPU time: a child that stays alive and never names
// its port fails by name. Mutation: the wait without its stall window, and the test times out.
test("a child that never names its port fails at the stall window, by name", async () => {
  const started = Bun.spawn({
    cmd: [process.execPath, "-e", "setTimeout(() => {}, 60_000)"],
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const failure = await reportedPort(started, 1000).then(() => "named", String);
    expect(failure).toContain("Server did not report its port within 1 s");
  } finally {
    await stopChild(started, "SIGKILL");
  }
});

test("a start on port 0 that exits first fails at once, with its stderr", async () => {
  const started = Bun.spawn({
    cmd: [process.execPath, "-e", "console.error('bind refused'); process.exit(3)"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const failure = await readyOnPortZero(started).then(() => "ready", String);
  expect(failure).toContain("Server exited before it reported its port");
  expect(failure).toContain("bind refused");
});
