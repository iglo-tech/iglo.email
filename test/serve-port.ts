// Ports for a process that must be given its port before it starts, such as the compiled
// executable with `serve --port`.
//
// A port that a test probes and releases can be taken by another test before the process binds
// it. So a start that fails because its port is in use is retried on a fresh port, and a server
// counts as the one started only when that very process listens on the port: another server can
// hold the port and answer /health while this process is still starting, or after it has failed.
//
// The guarantee depends on `Bun.serve` running without `reusePort` (src/server/server.ts). With
// SO_REUSEPORT, two servers can bind the same port, so a start would no longer fail when its port
// is taken, and `listensOn` would not prove which process owns the port. Do not add `reusePort`
// to the server without changing both the retry and `listensOn`.
import type { ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { createServer } from "node:net";

const attempts = 5;

/**
 * For a child that has exited: its stderr up to the end of the stream. The exit event can come
 * before the last output is read, and the bind failure is in that output.
 */
export async function stderrDrained(child: ChildProcess): Promise<void> {
  const stream = child.stderr;
  if (!stream || stream.readableEnded || stream.destroyed) return;
  await Promise.race([new Promise((done) => stream.once("end", done)), Bun.sleep(1000)]);
}

async function freeLoopbackPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve a loopback port");
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

/**
 * Whether a start failed because its port was in use. The executable says "Is port N in use?" when
 * its bind fails; its data-directory lock says "is in use by another" and must not match.
 */
export function isPortInUse(error: unknown): boolean {
  return /\bport \d+ in use\b|EADDRINUSE|address already in use/i.test(String(error));
}

/**
 * Calls `start` with a free loopback port. A start that fails because its port is in use is called
 * again with another port, up to five attempts; any other failure is thrown at once. `start` stops
 * its own process before it throws.
 */
export async function startOnFreePort<T>(start: (port: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const port = await freeLoopbackPort();
    try {
      return await start(port);
    } catch (error) {
      if (attempt >= attempts || !isPortInUse(error)) throw error;
    }
  }
}

/**
 * Calls `start` again on `port`, the port its predecessor just released. A restart cannot move to
 * another port: callers keep the origin they were given. Another test can take the freed port
 * before the restart binds it, so a start that fails because the port is in use is retried on the
 * same port, after a short pause that grows with each attempt, up to five attempts. Any other
 * failure is thrown at once, and `start` stops its own process before it throws.
 */
export async function restartOnPort<T>(
  port: number,
  start: (port: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start(port);
    } catch (error) {
      if (attempt >= attempts || !isPortInUse(error)) throw error;
      await Bun.sleep(50 * attempt);
    }
  }
}

/** Whether process `pid` itself listens on loopback `port`. Linux only, like the MVP. */
export function listensOn(pid: number, port: number): boolean {
  try {
    const hex = port.toString(16).toUpperCase().padStart(4, "0");
    const inodes = new Set<string>();
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let text = "";
      try {
        text = readFileSync(table, "utf8");
      } catch {}
      for (const line of text.split("\n").slice(1)) {
        const [, local, , state, , , , , , inode] = line.trim().split(/\s+/);
        if (state === "0A" && local?.endsWith(`:${hex}`) && inode) inodes.add(inode);
      }
    }
    if (inodes.size === 0) return false;
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (match && inodes.has(match[1]!)) return true;
      } catch {}
    }
  } catch {}
  return false;
}

/** The part of a spawned process that these helpers use: `Bun.spawn` returns it. */
export interface Child {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  readonly stderr: ReadableStream<Uint8Array> | number | null | undefined;
  kill(signal?: number | NodeJS.Signals): void;
}

/**
 * Stops a child with `signal`, and with SIGKILL when it has not exited within `graceMs`. Resolves
 * with its exit code only after the process has exited, so it is reaped before the caller goes on.
 */
export async function stopChild(
  child: Child,
  signal: NodeJS.Signals = "SIGTERM",
  graceMs = 5_000,
): Promise<number> {
  if (child.exitCode === null) child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  try {
    return await child.exited;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves once the process answers /health on `port` and listens on it, or throws with its stderr
 * when it exits first. Gives up after `timeoutMs` (five seconds by default).
 */
export async function healthWhenReady(
  child: Child,
  port: number,
  timeoutMs = 5_000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const stderr =
        child.stderr instanceof ReadableStream ? await new Response(child.stderr).text() : "";
      throw new Error(`Server exited before it became ready: ${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Connection: "close" },
        signal: AbortSignal.timeout(500),
      });
      // Another server can hold the port and answer first: ready only when this child listens on it.
      if (child.pid !== undefined && listensOn(child.pid, port)) return response;
    } catch {
      // This delay is only for bounded process readiness, not application time.
    }
    await Bun.sleep(25);
  }
  throw new Error(`Server did not become ready within ${timeoutMs} ms`);
}
