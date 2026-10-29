// Evaluation of sequence conditions (docs/design/05-sequences.md#conditions); no upstream source.
// A condition without `sql` runs as one statement on the read-only connection. Raw fragments
// run first in M1.7's read-only child runner, with its time, memory and concurrency limits, and
// their results are bound into the same statement. Failures are returned, never thrown, and
// nothing runs on the write connection, so a caller's transaction is never involved.
import type { Database, Statement } from "bun:sqlite";
import { compile, type CompiledCondition } from "@/conditions/compile";
import { parseDuration } from "@/conditions/duration";
import type { ConditionContext, ConditionError, EvaluationResult } from "@/conditions/types";
import { validate } from "@/conditions/validate";
import { fragmentSQL } from "@/subscribers/condition-sql";
import { RunnerError, type QueryRunner } from "@/subscribers/query-runner";

/** Prepared statements kept per evaluator; the least recently used is finalized beyond it. */
const CACHE = 64;
const MIN_TIME = Date.UTC(1000, 0, 1),
  MAX_TIME = Date.UTC(10000, 0, 1);

class ContextError extends Error {}

function instant(value: Date | string | null | undefined, name: string): number {
  if (value === undefined || value === null) throw new ContextError(`${name} is required`);
  const time = (typeof value === "string" ? new Date(value) : value).getTime();
  if (!(time >= MIN_TIME && time < MAX_TIME)) throw new ContextError(`${name} is invalid`);
  return time;
}

function subscriberID(value: unknown): bigint {
  if (typeof value === "bigint" && value > 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  throw new ContextError("subscriberId is invalid");
}

function runnerError(error: RunnerError): ConditionError {
  if (error.kind === "execution" && error.message === "query exceeded the memory limit")
    return { kind: "memory", message: error.message };
  return { kind: error.kind, message: error.message };
}

export function createConditionEvaluator(options: {
  /** A read-only connection (openReadOnly). */
  readonly: Database;
  /** M1.7's raw-query child runner, used only for conditions with `sql`. */
  runner: Pick<QueryRunner, "all">;
}) {
  const { readonly, runner } = options;
  const statements = new Map<string, Statement>();
  const prepared = (sql: string) => {
    let stmt = statements.get(sql);
    if (stmt) statements.delete(sql);
    else stmt = readonly.prepare(sql);
    statements.set(sql, stmt);
    if (statements.size > CACHE) {
      const [oldest, old] = statements.entries().next().value!;
      statements.delete(oldest);
      old.finalize();
    }
    return stmt;
  };

  async function evaluateCompiled(
    compiled: CompiledCondition,
    context: ConditionContext,
  ): Promise<EvaluationResult> {
    let id: bigint, args: (string | number | bigint)[];
    try {
      id = subscriberID(context.subscriberId);
      const now = instant(context.now, "now");
      const after = (since: string) => {
        let time: number;
        if (since === "trigger") time = instant(context.triggerAt, "triggerAt");
        else if (since === "enrollment") time = instant(context.enrolledAt, "enrolledAt");
        else if (since === "last_step")
          time =
            context.lastStepAt === undefined || context.lastStepAt === null
              ? instant(context.triggerAt, "triggerAt")
              : instant(context.lastStepAt, "lastStepAt");
        else time = now - parseDuration(since)!;
        // Stored instants are ISO strings from year 1000; an earlier bound admits every event.
        return time < MIN_TIME ? "" : new Date(time).toISOString();
      };
      args = compiled.params.map((param) =>
        typeof param !== "object"
          ? param
          : param.slot === "subscriber"
            ? id
            : param.slot === "after"
              ? after(param.since)
              : 0,
      );
    } catch (error) {
      if (error instanceof ContextError)
        return { ok: false, error: { kind: "context", message: error.message } };
      return { ok: false, error: { kind: "execution", message: "condition query failed" } };
    }
    try {
      if (compiled.fragments.length) {
        const results = await runner.all(compiled.fragments.map((f) => fragmentSQL(f, id)));
        compiled.params.forEach((param, i) => {
          if (typeof param === "object" && param.slot === "sql")
            args[i] = results[param.index]!.length ? 1 : 0;
        });
      }
      const rows = prepared(compiled.sql).values(...args) as unknown[][];
      if (!rows.length)
        return { ok: false, error: { kind: "not_found", message: "subscriber not found" } };
      return { ok: true, value: rows[0]![0] === 1n || rows[0]![0] === 1 };
    } catch (error) {
      if (error instanceof RunnerError) return { ok: false, error: runnerError(error) };
      return { ok: false, error: { kind: "execution", message: "condition query failed" } };
    }
  }

  return {
    /**
     * Validate, compile and evaluate a stored condition for one subscriber. A stored condition
     * was saved by a user allowed to use `sql`, so `sql` predicates are accepted here.
     */
    async evaluate(condition: unknown, context: ConditionContext): Promise<EvaluationResult> {
      const checked = validate(condition, { canUseSql: true });
      if (!checked.ok) {
        const first = checked.errors[0];
        return {
          ok: false,
          error: {
            kind: "invalid",
            message: first ? `${first.field}: ${first.message}` : "invalid condition",
          },
        };
      }
      return evaluateCompiled(compile(checked.condition), context);
    },
    evaluateCompiled,
    close() {
      for (const stmt of statements.values()) stmt.finalize();
      statements.clear();
    },
  };
}
export type ConditionEvaluator = ReturnType<typeof createConditionEvaluator>;
