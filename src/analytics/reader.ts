// Runs analytics reads in a child process with its own read-only connection, in the manner of
// src/subscribers/query-runner.ts. A read covers up to every view and click, bun:sqlite is
// synchronous, and the pixel, redirect and send paths share the server's one thread, so at
// a million rows an in-process read stalls them for seconds (docs/perf/M3.3-analytics.md).
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
  "dashboardCounts",
  "dashboardCharts",
  "summary",
] as const;
type Method = (typeof methods)[number];

/** Child entry: one read in one snapshot; stdout is the response body, ready to serve. */
export async function runAnalyticsChild(): Promise<void> {
  const request = JSON.parse(await Bun.stdin.text()) as {
    path: string;
    method: Method;
    args: unknown[];
  };
  if (!methods.includes(request.method)) throw new Error("Unknown analytics read");
  const db = openReadOnly(request.path);
  try {
    const store = createAnalyticsStore(db);
    db.run("BEGIN");
    const read = store[request.method] as (...args: unknown[]) => unknown;
    const body = await ok(read.apply(store, request.args)).text();
    db.run("COMMIT");
    await Bun.write(Bun.stdout, body);
  } finally {
    db.close(true);
  }
}

export class ReaderError extends Error {
  constructor(
    readonly kind: "busy" | "timeout" | "failed",
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
  /** How long a read waits for a free child before it is refused as busy. */
  admissionMs?: number;
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
  const admissionMs = options.admissionMs ?? 30_000;
  const children = new Set<Bun.Subprocess>();
  const waiting: (() => void)[] = [];
  let active = 0;
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  const acquire = async () => {
    if (active < concurrency) {
      active++;
      return;
    }
    let timer: Timer | undefined;
    const admitted = await new Promise<boolean>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      waiting.push(wake);
      timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(wake), 1);
        resolve(false);
      }, admissionMs);
    });
    if (!admitted) throw new ReaderError("busy", "too many analytics reads in progress");
  };
  return {
    /** The read's response body. The JSON stays text here, so a big result is never parsed. */
    async read<M extends Method>(
      method: M,
      ...args: Parameters<AnalyticsStore[M]>
    ): Promise<string> {
      await acquire();
      let timedOut = false;
      try {
        const child = Bun.spawn(command, {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
          env: { PATH: process.env.PATH ?? "" },
        });
        children.add(child);
        const deadline = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        try {
          child.stdin.write(JSON.stringify({ path: options.path, method, args }));
          await child.stdin.end();
          const [body, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
          if (timedOut) throw new ReaderError("timeout", "analytics read timed out");
          if (code !== 0) throw new ReaderError("failed", "analytics read failed");
          return body;
        } finally {
          clearTimeout(deadline);
          children.delete(child);
        }
      } finally {
        release();
      }
    },
    /** Kill running children, as at shutdown. */
    async close() {
      for (const child of children) child.kill("SIGKILL");
      await Promise.all([...children].map((child) => child.exited));
    },
  };
}
export type AnalyticsReader = ReturnType<typeof createAnalyticsReader>;
