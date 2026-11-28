// B162c (D189, D190): a byte-forwarding TCP proxy in front of a source binary, run as its own
// process so that stopping it (SIGSTOP) stops every read: the binary's unsent realtime messages
// then pile up as they do behind a reader that has fallen behind. iglo.base closes a realtime
// connection once 8 MiB are unsent; PocketBase 0.40.5 keeps them (D189, measured). (Bun's
// `node:net` `pause()` does not stop a socket's reads, so an in-process proxy cannot do this.) The
// child is `stream-proxy.ts`'s proxy, which forwards bytes unchanged and writes none of its own.
// The test sees the binary fill a stalled connection through `/proc/net/tcp` (`upstreams`), and the
// binary close one through the child's `closed <port>` stdout lines (`closedByBinary`).
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { stopped } from "@/test/sources/harness";
import { startCutProxy } from "@/test/sources/stream-proxy";

/** One of the proxy's connections to the binary, as the kernel sees both of its ends. */
export interface Upstream {
  /** The proxy's local port: names the connection. */
  port: number;
  /** Bytes the stopped proxy has not read. */
  unread: number;
  /**
   * The binary's end: its TCP state (`/proc/net/tcp` `st`, `01` = established) and the bytes it
   * wrote that the proxy's side has not taken; `undefined` once the binary's socket is gone.
   */
  binary: { state: string; unsent: number } | undefined;
}

export interface StallProxy {
  readonly url: string;
  /** Stops the proxy process: nothing is read from either side until `release`. */
  stall(): Promise<void>;
  /** Lets it run again: what the binary sent meanwhile is forwarded, then its close, if any. */
  release(): void;
  /** The proxy's connections to the binary, read from `/proc` (works while it is stopped). */
  upstreams(): Array<Upstream>;
  /** Whether the proxy saw the binary close the connection on proxy port `port`. */
  closedByBinary(port: number): boolean;
  stop(): Promise<void>;
}

interface TcpRow {
  localPort: number;
  remotePort: number;
  state: string;
  tx: number;
  rx: number;
  inode: string;
}

/** The IPv4 TCP sockets of this network namespace (the binary listens on 127.0.0.1). */
function tcpRows(): Array<TcpRow> {
  return readFileSync("/proc/net/tcp", "utf-8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [, local = "", remote = "", state = "", queues = "", , , , , inode = ""] = line
        .trim()
        .split(/\s+/);
      const [tx = "0", rx = "0"] = queues.split(":");
      return {
        localPort: Number.parseInt(local.split(":")[1] ?? "0", 16),
        remotePort: Number.parseInt(remote.split(":")[1] ?? "0", 16),
        state,
        tx: Number.parseInt(tx, 16),
        rx: Number.parseInt(rx, 16),
        inode,
      };
    });
}

/** The socket inodes process `pid` holds open. */
function socketInodes(pid: number): Set<string> {
  const inodes = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1];
      if (inode) {
        inodes.add(inode);
      }
    } catch {
      /* closed meanwhile */
    }
  }
  return inodes;
}

export async function startStallProxy(targetPort: number): Promise<StallProxy> {
  const child = spawn(process.execPath, [import.meta.path, String(targetPort)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  const lines = createInterface({ input: child.stdout });
  const url = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    child.once("exit", (code) => reject(new Error(`the stall proxy exited (${code})`)));
  });
  // Every later line names a connection the binary closed: `closed <proxy port>`.
  const closed = new Set<number>();
  lines.on("line", (line) => {
    const port = /^closed (\d+)$/.exec(line)?.[1];
    if (port) {
      closed.add(Number(port));
    }
  });
  return {
    url,
    async stall() {
      child.kill("SIGSTOP");
      await stopped("the stall proxy", child.pid!);
    },
    release() {
      child.kill("SIGCONT");
    },
    upstreams() {
      const mine = socketInodes(child.pid!);
      const rows = tcpRows();
      return rows
        .filter((row) => mine.has(row.inode) && row.remotePort === targetPort)
        .map((row) => {
          const peer = rows.find(
            (other) => other.localPort === targetPort && other.remotePort === row.localPort,
          );
          return {
            port: row.localPort,
            unread: row.rx,
            binary: peer && { state: peer.state, unsent: peer.tx },
          };
        });
    },
    closedByBinary(port) {
      return closed.has(port);
    },
    async stop() {
      lines.close();
      child.kill("SIGCONT");
      child.kill("SIGKILL");
      await exited;
    },
  };
}

if (import.meta.main) {
  const proxy = startCutProxy(Number(Bun.argv[2]), (port) => {
    console.log(`closed ${port}`);
  });
  console.log(proxy.url);
}
