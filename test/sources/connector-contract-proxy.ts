// B162c (D189, D190): a byte-forwarding TCP proxy in front of a source binary, run as its own
// process so that stopping it (SIGSTOP) stops every read: the binary's unsent realtime messages
// then pile up as they do behind a reader that has fallen behind. iglo.base closes a realtime
// connection once 8 MiB are unsent; PocketBase 0.40.5 keeps them (D189, measured). (Bun's
// `node:net` `pause()` does not stop a socket's reads, so an in-process proxy cannot do this.) The
// child is `stream-proxy.ts`'s proxy, which forwards bytes unchanged and writes none of its own.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { stopped } from "@/test/sources/harness";
import { startCutProxy } from "@/test/sources/stream-proxy";

export interface StallProxy {
  readonly url: string;
  /** Stops the proxy process: nothing is read from either side until `release`. */
  stall(): Promise<void>;
  /** Lets it run again: what the binary sent meanwhile is forwarded, then its close, if any. */
  release(): void;
  stop(): Promise<void>;
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
  return {
    url,
    async stall() {
      child.kill("SIGSTOP");
      await stopped("the stall proxy", child.pid!);
    },
    release() {
      child.kill("SIGCONT");
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
  const proxy = startCutProxy(Number(Bun.argv[2]));
  console.log(proxy.url);
}
