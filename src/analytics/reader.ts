// Runs analytics reads in a child process with its own read-only connection, in the manner of
// src/subscribers/query-runner.ts. A read covers up to every view and click, bun:sqlite is
// synchronous, and the pixel, redirect and send paths share the server's one thread, so at
// a million rows an in-process read stalls them for seconds (docs/perf/M3.3-analytics.md).
// Limits, cancellation and shutdown are recorded in docs/design/09-decisions.md D62.
import { readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createAnalyticsStore, type AnalyticsStore } from "@/analytics/store";
import { ok } from "@/server/response";
import { openReadOnly } from "@/subscribers/query-runner";

/** The command line that makes the executable run the child instead of the server. */
export const analyticsChildArgument = "__analytics-read";
const methods = [
  "campaignCounts",
  "listCounts",
  "links",
  "sends",
  "sequenceCounts",
  "dashboardCounts",
  "dashboardCharts",
  "dashboardCampaigns",
  "summary",
] as const;
type Method = (typeof methods)[number];

/** Reads whose rows can number one per ID and period; these stream instead of collecting. */
const streamed: readonly Method[] = ["campaignCounts", "listCounts"];

/** Child entry: one read in one snapshot; stdout is the response body, ready to serve. */
export async function runAnalyticsChild(): Promise<void> {
  const request = JSON.parse(await Bun.stdin.text()) as {
    path: string;
    method: Method;
    args: unknown[];
  };
  if (!methods.includes(request.method)) throw new Error("Unknown analytics read");
  let out = "";
  const flush = () => {
    let bytes = Buffer.from(out);
    while (bytes.length) bytes = bytes.subarray(writeSync(1, bytes));
    out = "";
  };
  const emit = (text: string) => {
    out += text;
    if (out.length >= 65536) flush();
  };
  const db = openReadOnly(request.path);
  try {
    const store = createAnalyticsStore(db);
    db.run("BEGIN");
    const read = store[request.method] as (...args: unknown[]) => unknown;
    const result = read.apply(store, request.args);
    if (streamed.includes(request.method)) {
      emit(`{"data":[`);
      let separator = "";
      for (const row of result as Iterable<unknown>) {
        emit(separator + JSON.stringify(row));
        separator = ",";
      }
      emit("]}");
    } else emit(await ok(result).text());
    flush();
    db.run("COMMIT");
  } finally {
    db.close(true);
  }
}

export class ReaderError extends Error {
  constructor(
    readonly kind: "busy" | "timeout" | "limit" | "failed" | "cancelled" | "closed",
    message: string,
  ) {
    super(message);
  }
}

export interface ReaderOptions {
  /** Database file opened read-only by each child. */
  path: string;
  /** Wall-clock time a child may live. */
  timeoutMs?: number;
  /** Children running at once; the rest wait their turn. */
  concurrency?: number;
  /** Reads waiting for a child; any more are refused as busy at once. */
  maxQueued?: number;
  /** How long a read waits for a free child before it is refused as busy. */
  admissionMs?: number;
  /** Resident memory a child may use; as in the query runner, /proc is sampled. */
  memoryBytes?: number;
  /** Bytes of one response, which the server holds whole so it can never send a partial one. */
  maxOutputBytes?: number;
  command?: string[];
}

function defaultCommand(): string[] {
  // A compiled executable re-runs itself; a source checkout runs the module directly.
  return import.meta.path.startsWith("/$bunfs/")
    ? [process.execPath, analyticsChildArgument]
    : [process.execPath, join(import.meta.dir, "child.ts")];
}

export function createAnalyticsReader(options: ReaderOptions) {
  const command = options.command ?? defaultCommand();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const concurrency = options.concurrency ?? 2;
  const maxQueued = options.maxQueued ?? 32;
  const admissionMs = options.admissionMs ?? 30_000;
  const memoryBytes = options.memoryBytes ?? 256 * 1024 * 1024;
  const maxOutputBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;
  const busy = () => new ReaderError("busy", "too many analytics reads in progress");
  const cancelled = () => new ReaderError("cancelled", "analytics read cancelled");
  const closing = () => new ReaderError("closed", "analytics reader closed");
  /** Each running child and how to stop it with a reason. */
  const children = new Map<Bun.Subprocess, (error: ReaderError) => void>();
  /** Queued reads in arrival order: called with nothing to admit, or with why not. */
  const waiting = new Set<(error?: ReaderError) => void>();
  let active = 0;
  let closed = false;
  const release = () => {
    const [next] = waiting;
    if (next) next();
    else active--;
  };
  const acquire = (signal: AbortSignal | undefined) => {
    if (closed) throw closing();
    if (signal?.aborted) throw cancelled();
    if (active < concurrency) {
      active++;
      return;
    }
    if (waiting.size >= maxQueued) throw busy();
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: ReaderError) => {
        waiting.delete(settle);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => settle(cancelled());
      const timer = setTimeout(() => settle(busy()), admissionMs);
      signal?.addEventListener("abort", abort, { once: true });
      waiting.add(settle);
    });
  };
  const run = async (request: string, signal: AbortSignal | undefined) => {
    const child = Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { PATH: process.env.PATH ?? "" },
    });
    let stopped: ReaderError | undefined;
    const stop = (error: ReaderError) => {
      stopped ??= error;
      child.kill("SIGKILL");
    };
    children.set(child, stop);
    const abort = () => stop(cancelled());
    signal?.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(
      () => stop(new ReaderError("timeout", "analytics read timed out")),
      timeoutMs,
    );
    const pid = child.pid;
    const tooLarge = () => new ReaderError("limit", "analytics result too large");
    const watchdog = setInterval(() => {
      try {
        const pages = Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]);
        if (pages * 4096 > memoryBytes) stop(tooLarge());
      } catch {
        /* exited, or no /proc */
      }
    }, 20);
    try {
      try {
        child.stdin.write(request);
        await child.stdin.end();
      } catch {
        /* A child that exited early reports through its exit code. */
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of child.stdout) {
        size += chunk.length;
        if (size > maxOutputBytes) {
          stop(tooLarge());
          break;
        }
        chunks.push(chunk);
      }
      const code = await child.exited;
      if (stopped) throw stopped;
      if (code !== 0) throw new ReaderError("failed", "analytics read failed");
      return new Uint8Array(Bun.concatArrayBuffers(chunks));
    } finally {
      child.kill("SIGKILL");
      clearTimeout(deadline);
      clearInterval(watchdog);
      signal?.removeEventListener("abort", abort);
      await child.exited;
      children.delete(child);
    }
  };
  return {
    /**
     * The read's response body. The JSON stays bytes here, so a big result is never parsed.
     * The signal cancels it: a queued read leaves the queue and a running child is killed.
     */
    async read<M extends Method>(
      method: M,
      args: Parameters<AnalyticsStore[M]>,
      signal?: AbortSignal,
    ): Promise<Uint8Array<ArrayBuffer>> {
      await acquire(signal);
      try {
        if (closed) throw closing();
        if (signal?.aborted) throw cancelled();
        return await run(JSON.stringify({ path: options.path, method, args }), signal);
      } finally {
        release();
      }
    },
    /** Refuse new and queued reads, kill running children and wait for them to exit. */
    async close() {
      closed = true;
      for (const settle of [...waiting]) settle(closing());
      for (const stop of children.values()) stop(closing());
      await Promise.all([...children.keys()].map((child) => child.exited));
    },
  };
}
export type AnalyticsReader = ReturnType<typeof createAnalyticsReader>;
