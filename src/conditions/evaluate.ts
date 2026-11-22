// Evaluation of sequence conditions (docs/design/05-sequences.md#conditions); no upstream source.
// A condition without `sql` runs as one statement on the read-only connection. A condition with
// `sql` runs as that same single statement, fragments included, in M1.7's read-only child
// runner with its time, memory and concurrency limits, so every predicate sees one snapshot.
// Failures are returned, never thrown, and nothing runs on the write connection, so a caller's
// transaction is never involved.
import type { Database, Statement } from "bun:sqlite";
import { must } from "@/invariant";
import { compile } from "@/conditions/compile";
import type { CompiledCondition } from "@/conditions/compile";
import { ContextError, instant, sinceBound, subscriberID } from "@/conditions/since";
import type { ConditionContext, ConditionError, EvaluationResult } from "@/conditions/types";
import { validate } from "@/conditions/validate";
import { RunnerError } from "@/subscribers/query-runner";
import type { QueryRunner } from "@/subscribers/query-runner";

/** Prepared statements kept per evaluator; the least recently used is finalized beyond it. */
const CACHE = 64;

function runnerError(error: RunnerError): ConditionError {
  if (error.kind === "execution" && error.message === "query exceeded the memory limit") {
    return { kind: "memory", message: error.message };
  }
  return { kind: error.kind, message: error.message };
}

export function createConditionEvaluator(options: {
  /** A read-only connection (openReadOnly). */
  readonly: Database;
  /** M1.7's raw-query child runner, used only for conditions with `sql`. */
  runner: Pick<QueryRunner, "condition">;
}) {
  const { readonly, runner } = options;
  const statements = new Map<string, Statement>();
  const prepared = (sql: string) => {
    let stmt = statements.get(sql);
    if (stmt) {
      statements.delete(sql);
    } else {
      stmt = readonly.prepare(sql);
    }
    statements.set(sql, stmt);
    if (statements.size > CACHE) {
      const [oldest, old] = must(statements.entries().next().value, "oldest statement");
      statements.delete(oldest);
      old.finalize();
    }
    return stmt;
  };

  async function evaluateCompiled(
    compiled: CompiledCondition,
    context: ConditionContext,
  ): Promise<EvaluationResult> {
    let id: bigint, args: Array<string | number | bigint>;
    try {
      id = subscriberID(context.subscriberId);
      const now = instant(context.now, "now");
      const after = (since: string) => sinceBound(context, now, since);
      args = compiled.params.map((param) =>
        typeof param !== "object" ? param : param.slot === "subscriber" ? id : after(param.since),
      );
    } catch (error) {
      if (error instanceof ContextError) {
        return { ok: false, error: { kind: "context", message: error.message } };
      }
      return { ok: false, error: { kind: "execution", message: "condition query failed" } };
    }
    try {
      const matched = compiled.fragments.length
        ? (
            await runner.condition({
              sql: compiled.sql,
              args,
              fragments: compiled.fragments,
            })
          )[0]
        : (prepared(compiled.sql).values(...args) as Array<Array<unknown>>)[0]?.[0];
      if (matched === undefined) {
        return { ok: false, error: { kind: "not_found", message: "subscriber not found" } };
      }
      return { ok: true, value: matched === 1n || matched === 1 };
    } catch (error) {
      if (error instanceof RunnerError) {
        return { ok: false, error: runnerError(error) };
      }
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
      for (const stmt of statements.values()) {
        stmt.finalize();
      }
      statements.clear();
    },
  };
}
export type ConditionEvaluator = ReturnType<typeof createConditionEvaluator>;
