// Runs subscriber statements that embed a raw SQL fragment, like listmonk's read-only
// transactions in internal/core/subscribers.go (getSubscriberCount, compileSubscriberQueryTpl)
// at 6fcd95f, in a child process with its own read-only connection. bun:sqlite exposes no
// interrupt or progress handler and terminating a Worker does not stop a running SQLite step
// (docs/perf/M1.7-query.md), so the time limit kills the process.
import { Database } from "bun:sqlite";
import { closeSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createIdWriter,
  fileIds,
  openAndUnlink,
  prepareStageDir,
  readIds,
  stagePrefix,
  STAGE_CHUNK,
  type IdList,
} from "@/subscribers/id-stage";
import {
  prepareChecked,
  prepareCondition,
  QueryError,
  type Arg,
  type ConditionArg,
} from "@/subscribers/query-filter";

export interface Statement {
  sql: string;
  args: Arg[];
}
/** A generated condition statement with checked fragments at its slots (prepareCondition). */
export interface ConditionStatement {
  sql: string;
  args: ConditionArg[];
  fragments: string[];
}
type WireArg = string | { int: string } | { num: number };
interface WireStatement {
  sql: string;
  args: WireArg[];
  /** Present only for a condition statement. */
  fragments?: string[];
}
interface Request {
  path: string;
  /** File name prefix: statement N writes its IDs to `${spool}${N}` instead of stdout. */
  spool: string;
  statements: WireStatement[];
}
const toWire = (arg: ConditionArg): WireArg =>
  typeof arg === "bigint" ? { int: arg.toString() } : typeof arg === "number" ? { num: arg } : arg;
const fromWire = (arg: WireArg): ConditionArg =>
  typeof arg === "string" ? arg : "int" in arg ? BigInt(arg.int) : arg.num;
/** The command line that makes the executable run the child instead of the server. */
export const childArgument = "__subscriber-query";

/** A connection that cannot write: opened read-only and with writes refused by query_only. */
export function openReadOnly(path: string): Database {
  const db = new Database(path, { readonly: true, strict: true, safeIntegers: true });
  db.run("PRAGMA query_only = ON");
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

/**
 * Child entry: read one request on stdin and stage one integer per row of the first column in
 * the statement's spool file. Stdout carries only protocol lines: `R<n>` when statement n is
 * valid and its file exists, `B<count>` after each written chunk with the total so far, `OK`.
 */
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
      const args = statement.args.map(fromWire);
      const stmt = statement.fragments
        ? prepareCondition(db, statement.sql, statement.fragments, args)
        : prepareChecked(db, statement.sql, args as Arg[]);
      const writer = createIdWriter(`${request.spool}${index}`);
      try {
        emit(`R${index}`);
        // Report a validated statement before its first row arrives.
        flush();
        let count = 0;
        for (const row of stmt.iterate(...args) as Iterable<Record<string, unknown>>) {
          writer.push(Object.values(row)[0] as bigint);
          if (++count % STAGE_CHUNK === 0) {
            emit(`B${count}`);
            flush();
          }
        }
        writer.flush();
        emit(`B${count}`);
      } finally {
        writer.close();
      }
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
  /**
   * Directory for staged IDs (default `stage` beside the database). Files left by an earlier
   * run are removed when the runner is created, which the data directory lock makes safe.
   */
  stageDir?: string;
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
  const stageDir = options.stageDir ?? join(dirname(options.path), "stage");
  prepareStageDir(stageDir);
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
    const files = new Map<number, number>();
    try {
      yield* spawn(
        statements.map((s) => ({ sql: s.sql, args: s.args.map(toWire) })),
        files,
        onError,
      );
    } finally {
      for (const fd of files.values()) closeSync(fd);
    }
  }
  /**
   * The child's output, as `[statement index, values]`. Values are read from the statement's
   * spool file in the chunks the child reports, so the parent holds one batch at a time.
   * Each statement's file is opened (and unlinked) into `files`, which the caller closes.
   */
  async function* spawn(
    statements: WireStatement[],
    files: Map<number, number>,
    onError?: (error: RunnerError) => void,
    /** False when the caller only wants the files: batches are then not decoded. */
    decode = true,
  ): AsyncGenerator<[number, bigint[]]> {
    const prefix = stagePrefix(stageDir);
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
    /** Index, then the range of that statement's file to read; an empty range marks its start. */
    const ready: [number, number, number][] = [];
    const reported = new Map<number, number>();
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
          spool: prefix,
          statements,
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
        for (const line of lines) {
          if (line[0] === "R") {
            index = Number(line.slice(1));
            files.set(index, openAndUnlink(`${prefix}${index}`));
            reported.set(index, 0);
            ready.push([index, 0, 0]);
          } else if (line[0] === "B") {
            const total = Number(line.slice(1));
            ready.push([index, reported.get(index)!, total]);
            reported.set(index, total);
          } else if (line === "OK") {
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
          }
        }
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
        if (item) yield [item[0], decode ? readIds(files.get(item[0])!, item[1], item[2]) : []];
        else if (finished) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      closed = true;
      child.kill("SIGKILL");
      await exited;
      // A file the child made but the parent was never told about (a timeout or a kill between
      // the child's create and its "R" line) is not open here and would stay until restart.
      for (let i = 0; i < statements.length; i++) {
        if (files.has(i)) continue;
        try {
          unlinkSync(`${prefix}${i}`);
        } catch {
          /* never created */
        }
      }
    }
  }
  return {
    run,
    /** Where staged IDs live; built-in filters stage their large pages here too. */
    stageDir,
    /** Collect each statement's values; for statements known to return few rows. */
    async all(statements: Statement[]): Promise<bigint[][]> {
      const results: bigint[][] = statements.map(() => []);
      for await (const [index, values] of run(statements)) results[index]!.push(...values);
      return results;
    },
    /**
     * Run statements to completion in one snapshot and leave each result on disk. The caller
     * closes every list, which frees its file.
     */
    async stage(statements: Statement[]): Promise<IdList[]> {
      const files = new Map<number, number>();
      try {
        const wire = statements.map((s) => ({ sql: s.sql, args: s.args.map(toWire) }));
        for await (const _ of spawn(wire, files, undefined, false)) void _;
        return statements.map((_, index) => fileIds(files.get(index)!));
      } catch (error) {
        for (const fd of files.values()) closeSync(fd);
        throw error;
      }
    },
    /**
     * Run one generated sequence condition, with its checked fragments, in one read-only
     * snapshot under the same limits; yields the first column of each row.
     */
    async condition(statement: ConditionStatement): Promise<bigint[]> {
      const values: bigint[] = [];
      const files = new Map<number, number>();
      try {
        for await (const [, batch] of spawn(
          [
            {
              sql: statement.sql,
              args: statement.args.map(toWire),
              fragments: statement.fragments,
            },
          ],
          files,
        ))
          values.push(...batch);
      } finally {
        for (const fd of files.values()) closeSync(fd);
      }
      return values;
    },
    /** Kill running children, as at shutdown. */
    async close() {
      for (const child of children) child.kill("SIGKILL");
      await Promise.all([...children].map((child) => child.exited));
    },
  };
}
export type QueryRunner = ReturnType<typeof createQueryRunner>;
