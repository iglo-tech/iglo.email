// Ports for a process that must be given its port before it starts, such as the compiled
// executable with `serve --port`.
//
// A port that a test probes and releases can be taken by another test before the process binds
// it. So a start that fails because its port is in use is retried on a fresh port, and a server
// counts as the one started only when that very process listens on the port: another server can
// hold the port and answer /health while this process is still starting, or after it has failed.
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
