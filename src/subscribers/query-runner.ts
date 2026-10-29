// Runs subscriber statements that embed a raw SQL fragment, like listmonk's read-only
// transactions in internal/core/subscribers.go (getSubscriberCount, compileSubscriberQueryTpl)
// at 6fcd95f, in a child process with its own read-only connection. bun:sqlite exposes no
// interrupt or progress handler and terminating a Worker does not stop a running SQLite step
// (docs/perf/M1.7-query.md), so the time limit kills the process.
import { Database } from "bun:sqlite";
import { readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { prepareChecked, QueryError, type Arg } from "@/subscribers/query-filter";

export interface Statement {
  sql: string;
  args: Arg[];
}
type WireArg = string | { int: string };
interface Request {
  path: string;
  statements: { sql: string; args: WireArg[] }[];
}
/** The command line that makes the executable run the child instead of the server. */
export const childArgument = "__subscriber-query";

/** A connection that cannot write: opened read-only and with writes refused by query_only. */
export function openReadOnly(path: string): Database {
  const db = new Database(path, { readonly: true, strict: true, safeIntegers: true });
  db.run("PRAGMA query_only = ON");
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

/** Child entry: read one request on stdin, stream one integer per row of the first column. */
export async function runQueryChild(): Promise<void> {
  let out = "";
  const flush = () => {
    if (out) writeSync(1, out);
    out = "";
  };
  const emit = (line: string) => {
    out += `${line}\n`;
    if (out.length >= 65536) flush();
  };
  let db: Database | undefined;
  try {
    const request = JSON.parse(await Bun.stdin.text()) as Request;
    db = openReadOnly(request.path);
    // One read transaction: every statement sees the same snapshot.
    db.run("BEGIN");
    for (const [index, statement] of request.statements.entries()) {
      const args = statement.args.map((arg) => (typeof arg === "string" ? arg : BigInt(arg.int)));
      const stmt = prepareChecked(db, statement.sql, args);
      emit(`R${index}`);
      // Report a validated statement before its first row arrives.
      flush();
      for (const row of stmt.iterate(...args) as Iterable<Record<string, unknown>>)
        emit(String(Object.values(row)[0]));
      stmt.finalize();
    }
    db.run("COMMIT");
    emit("OK");
    flush();
  } catch (error) {
    out = "";
    const message = error instanceof Error ? error.message : "query failed";
    writeSync(1, `E${error instanceof QueryError ? "Q" : "X"}${JSON.stringify(message)}\n`);
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

export class RunnerError extends Error {
  constructor(
    readonly kind: "query" | "execution" | "timeout" | "busy",
    message: string,
  ) {
    super(message);
  }
}

export interface RunnerOptions {
  /** Database file opened read-only by each child. */
  path: string;
  /** Wall-clock time a child may live, however fast its output is consumed. */
  timeoutMs: number;
  /** Children running at once. */
  concurrency: number;
  /** How long a request waits for a free child slot before it is refused as busy. */
  admissionMs?: number;
  /**
   * Resident memory a child may use. bun:sqlite ignores PRAGMA hard_heap_limit, so the parent
   * samples /proc and kills a child above the limit.
   */
  memoryBytes?: number;
  command?: string[];
}

function defaultCommand(): string[] {
  // A compiled executable re-runs itself; a source checkout runs this module directly.
  return import.meta.path.startsWith("/$bunfs/")
    ? [process.execPath, childArgument]
    : [process.execPath, join(import.meta.dir, "query-child.ts")];
}

export function createQueryRunner(options: RunnerOptions) {
  const command = options.command ?? defaultCommand();
  const admissionMs = options.admissionMs ?? 1000;
  let active = 0;
  const waiting: (() => void)[] = [];
  const children = new Set<Bun.Subprocess>();
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  /** Take a child slot, waiting at most admissionMs; returns its idempotent release. */
  const acquire = async (): Promise<() => void> => {
    if (active < options.concurrency) active++;
    else {
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
      if (!admitted) throw new RunnerError("busy", "too many queries in progress");
    }
    let held = true;
    return () => {
      if (held) release();
      held = false;
    };
  };
  /**
   * Run statements in one read-only snapshot and yield `[statement index, values]` batches.
   * The parent drains the child's output as it arrives, so the child never waits for a slow
   * HTTP reader and the time limit is wall-clock time over the child's whole life: at the limit
   * the child is killed whether or not anyone is consuming, and `onError` is told at once so a
   * streaming response can end. The slot is released when the child exits, which also happens
   * at the limit and when the consumer stops early.
   */
  async function* run(
    statements: Statement[],
    onError?: (error: RunnerError) => void,
  ): AsyncGenerator<[number, bigint[]]> {
    const releaseSlot = await acquire();
    let child: Bun.Subprocess<"pipe", "pipe", "ignore">;
    try {
      child = Bun.spawn(command, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: { PATH: process.env.PATH ?? "" },
      });
    } catch (error) {
      releaseSlot();
      throw error;
    }
    children.add(child);
    const ready: [number, bigint[]][] = [];
    let failure: RunnerError | undefined,
      finished = false,
      closed = false,
      overMemory = false,
      wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const fail = (error: RunnerError) => {
      if (failure || finished) return;
      failure = error;
      child.kill("SIGKILL");
      if (!closed) onError?.(error);
      notify();
    };
    const deadline = setTimeout(
      () => fail(new RunnerError("timeout", "query timed out")),
      options.timeoutMs,
    );
    const limit = options.memoryBytes ?? 256 * 1024 * 1024;
    const pid = child.pid;
    const watchdog = setInterval(() => {
      try {
        const pages = Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]);
        if (pages * 4096 > limit) {
          overMemory = true;
          child.kill("SIGKILL");
        }
      } catch {
        /* exited, or no /proc */
      }
    }, 20);
    const exited = child.exited.then(() => {
      clearTimeout(deadline);
      clearInterval(watchdog);
      children.delete(child);
      releaseSlot();
    });
    const pump = async () => {
      child.stdin.write(
        JSON.stringify({
          path: options.path,
          statements: statements.map((s) => ({
            sql: s.sql,
            args: s.args.map((arg) => (typeof arg === "bigint" ? { int: arg.toString() } : arg)),
          })),
        } satisfies Request),
      );
      await child.stdin.end();
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let pending = "",
        index = -1;
      while (!failure && !finished) {
        const chunk = await reader.read();
        if (chunk.done) {
          fail(
            new RunnerError(
              "execution",
              overMemory ? "query exceeded the memory limit" : "query process ended unexpectedly",
            ),
          );
          return;
        }
        pending += decoder.decode(chunk.value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop()!;
        let batch: bigint[] = [];
        for (const line of lines) {
          if (line[0] === "R") {
            if (index >= 0 && batch.length) ready.push([index, batch]);
            batch = [];
            index = Number(line.slice(1));
            ready.push([index, []]);
          } else if (line === "OK") {
            if (batch.length) ready.push([index, batch]);
            batch = [];
            finished = true;
            clearTimeout(deadline);
          } else if (line[0] === "E") {
            fail(
              new RunnerError(
                line[1] === "Q" ? "query" : "execution",
                JSON.parse(line.slice(2)) as string,
              ),
            );
            return;
          } else batch.push(BigInt(line));
        }
        if (batch.length) ready.push([index, batch]);
        notify();
      }
    };
    pump().catch((error: unknown) =>
      fail(new RunnerError("execution", error instanceof Error ? error.message : "query failed")),
    );
    try {
      while (true) {
        if (failure) throw failure;
        const item = ready.shift();
        if (item) yield item;
        else if (finished) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      closed = true;
      child.kill("SIGKILL");
      await exited;
    }
  }
  return {
    run,
    /** Collect each statement's values. */
    async all(statements: Statement[]): Promise<bigint[][]> {
      const results: bigint[][] = statements.map(() => []);
      for await (const [index, values] of run(statements)) results[index]!.push(...values);
      return results;
    },
    /** Kill running children, as at shutdown. */
    async close() {
      for (const child of children) child.kill("SIGKILL");
      await Promise.all([...children].map((child) => child.exited));
    },
  };
}
export type QueryRunner = ReturnType<typeof createQueryRunner>;
