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
    readonly kind: "query" | "execution" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

export interface RunnerOptions {
  /** Database file opened read-only by each child. */
  path: string;
  /** Total time a request may wait for SQLite work before the child is killed. */
  timeoutMs: number;
  /** Children running at once; further requests wait. */
  concurrency: number;
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
  let active = 0;
  const waiting: (() => void)[] = [];
  const children = new Set<Bun.Subprocess>();
  const acquire = async () => {
    if (active >= options.concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  /**
   * Run statements in one read-only snapshot and yield `[statement index, values]` batches.
   * The time limit counts only time spent waiting for the child, so a slow HTTP reader of a
   * streamed export does not consume it; the child blocks on its full pipe meanwhile.
   */
  async function* run(statements: Statement[]): AsyncGenerator<[number, bigint[]]> {
    await acquire();
    let child: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;
    let watchdog: Timer | undefined;
    try {
      child = Bun.spawn(command, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: { PATH: process.env.PATH ?? "" },
      });
      children.add(child);
      let overMemory = false;
      const limit = options.memoryBytes ?? 256 * 1024 * 1024;
      const pid = child.pid;
      watchdog = setInterval(() => {
        try {
          const pages = Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]);
          if (pages * 4096 > limit) {
            overMemory = true;
            child?.kill("SIGKILL");
          }
        } catch {
          /* exited, or no /proc */
        }
      }, 20);
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
      let spent = 0,
        pending = "",
        index = -1,
        done = false;
      while (!done) {
        const remaining = options.timeoutMs - spent;
        const started = performance.now();
        let timer: Timer | undefined;
        const chunk = await Promise.race([
          reader.read(),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), Math.max(0, remaining));
          }),
        ]);
        clearTimeout(timer);
        spent += performance.now() - started;
        if (chunk === "timeout") throw new RunnerError("timeout", "query timed out");
        if (chunk.done)
          throw new RunnerError(
            "execution",
            overMemory ? "query exceeded the memory limit" : "query process ended unexpectedly",
          );
        pending += decoder.decode(chunk.value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop()!;
        let batch: bigint[] = [];
        for (const line of lines) {
          if (line[0] === "R") {
            if (index >= 0) yield [index, batch];
            batch = [];
            index = Number(line.slice(1));
            yield [index, []];
          } else if (line === "OK") done = true;
          else if (line[0] === "E")
            throw new RunnerError(
              line[1] === "Q" ? "query" : "execution",
              JSON.parse(line.slice(2)) as string,
            );
          else batch.push(BigInt(line));
        }
        if (batch.length) yield [index, batch];
      }
    } finally {
      clearInterval(watchdog);
      if (child) {
        child.kill("SIGKILL");
        await child.exited;
        children.delete(child);
      }
      release();
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
