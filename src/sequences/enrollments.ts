// Native sequence enrollments: event triggers and exits, reentry, manual enroll and cancel, and
// consent exits (docs/design/05-sequences.md#events-api, #sequence-definition,
// 04-sending.md#unsubscribe); no upstream source. The sequences module owns `enrollments`.
// Every write here runs inside the caller's write transaction, so an enrollment change commits
// or rolls back with the event, consent change or request that caused it.
import type { Database, Statement } from "bun:sqlite";
import type { Clock } from "@/clock";
import { compile } from "@/conditions/compile";
import { parseDuration } from "@/conditions/duration";
import { compareSQL, type Param } from "@/conditions/json";
import type { Condition, Scalar } from "@/conditions/types";
import { prepareNamedQueries } from "@/db/queries";
import type { ExitThenTrigger, RecordedEvent } from "@/events/store";
import type { SubscriberEffects } from "@/subscribers/store";
import type { UnsubscribeEffects } from "@/unsubscribe/routes";
import sql from "@/sequences/enrollments.sql" with { type: "text" };

/** Compiled trigger filters kept per store; the least recently used is finalized beyond it. */
const CACHE = 64;
const MIN_TIME = Date.UTC(1000, 0, 1);

export interface EnrollmentRow {
  id: bigint;
  sequence_id: bigint;
  subscriber_id: bigint;
  trigger_event_id: bigint | null;
  step_id: bigint | null;
  due_at: string | null;
  status: string;
  exit_reason: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}
export interface EnrollmentFilter {
  sequenceId?: bigint;
  subscriberId?: bigint;
  status?: string;
  exitReason?: string;
  page: number;
  perPage: number;
}

const rawJSON = (JSON as typeof JSON & { rawJSON(value: string): object }).rawJSON;
export const numberID = (id: bigint) =>
  id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : rawJSON(id.toString());
const nullableID = (id: bigint | null) => (id === null ? null : numberID(id));
const json = (ids: bigint[]) => `[${ids.join(",")}]`;

export function project(row: EnrollmentRow) {
  return {
    id: numberID(row.id),
    sequence_id: numberID(row.sequence_id),
    subscriber_id: numberID(row.subscriber_id),
    trigger_event_id: nullableID(row.trigger_event_id),
    step_id: nullableID(row.step_id),
    due_at: row.due_at,
    status: row.status,
    exit_reason: row.exit_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
  };
}

/** `wait` after `from`, in the stored ISO format. Waits were validated when saved. */
function after(from: string, wait: string): string {
  const ms = parseDuration(wait);
  if (ms === undefined) throw new Error("Stored step wait is invalid");
  return new Date(Date.parse(from) + ms).toISOString();
}

export type EnrollOutcome =
  | { enrollment: EnrollmentRow }
  | {
      error: "sequence_missing" | "sequence_inactive" | "no_steps" | "reentry";
    };

export function createEnrollments(db: Database, clock: Clock) {
  const q = prepareNamedQueries(db, [{ name: "sequences/enrollments", sql }]);
  const byId = (id: bigint) => q.get("enrollment-by-id").get(id) as EnrollmentRow | null;

  // Trigger filters run on the write connection inside the event transaction, so they see the
  // event and the subscriber upsert it just made. They hold no raw `sql` (refused at save).
  type Filter = {
    statement: Statement;
    params: Array<Param | ((e: RecordedEvent) => Param)>;
  };
  const filters = new Map<string, Filter>();
  function prepareFilter(where: Record<string, unknown>): Filter {
    const keys = Object.keys(where);
    if (keys.length && keys.every((key) => key.startsWith("data."))) {
      // Shorthand: equalities on the triggering event's data, with the condition type rules.
      const parts = keys.map((key) =>
        compareSQL("e.data", key.slice("data.".length), "eq", where[key] as Scalar),
      );
      return {
        statement: db.prepare(
          `WITH e(data) AS (SELECT ?) SELECT ${parts.map((p) => p.sql).join(" AND ")} FROM e`,
        ),
        params: [(e) => e.data, ...parts.flatMap((p) => p.args)],
      };
    }
    const compiled = compile(where as Condition);
    if (compiled.fragments.length) throw new Error("Trigger filters cannot contain sql");
    const bound = (since: string) => (e: RecordedEvent) => {
      // At trigger time the enrollment starts now and no step has run: `last_step` falls back
      // to the trigger, like the evaluator.
      const time =
        since === "trigger" || since === "last_step"
          ? Date.parse(e.occurredAt)
          : since === "enrollment"
            ? Date.parse(e.receivedAt)
            : Date.parse(e.receivedAt) - parseDuration(since)!;
      return time < MIN_TIME ? "" : new Date(time).toISOString();
    };
    return {
      statement: db.prepare(compiled.sql),
      params: compiled.params.map((param) =>
        typeof param !== "object"
          ? param
          : param.slot === "subscriber"
            ? (e: RecordedEvent) => e.subscriberId
            : bound(param.since),
      ),
    };
  }
  function matches(trigger: string, event: RecordedEvent): boolean {
    const where = (JSON.parse(trigger) as { where?: Record<string, unknown> }).where;
    if (!where) return true;
    let filter = filters.get(trigger);
    if (filter) filters.delete(trigger);
    else filter = prepareFilter(where);
    filters.set(trigger, filter);
    if (filters.size > CACHE) {
      const [oldest, old] = filters.entries().next().value!;
      filters.delete(oldest);
      old.statement.finalize();
    }
    const args = filter.params.map((p) => (typeof p === "function" ? p(event) : p));
    const value = (filter.statement.values(...args) as unknown[][])[0]?.[0];
    return value === 1n || value === 1;
  }

  function start(
    sequenceId: bigint,
    subscriberId: bigint,
    triggerEventId: bigint | null,
    first: { id: bigint; wait: string },
    from: string,
    now: string,
  ): bigint {
    return (
      q
        .get("enrollment-insert")
        .get(
          sequenceId,
          subscriberId,
          triggerEventId,
          first.id,
          after(from, first.wait),
          now,
          now,
        ) as {
        id: bigint;
      }
    ).id;
  }
  const end = (id: bigint, status: string, reason: string, now: string) =>
    q.get("enrollment-end").run(status, reason, now, now, id).changes === 1;

  /** Events API steps 2-3 for one event, in that order. */
  const exitThenTrigger: ExitThenTrigger = (event) => {
    const now = event.receivedAt;
    const reason = `event:${event.name}`;
    const exited = (
      q.get("exit-by-event").all(reason, now, now, event.subscriberId, event.name) as {
        id: bigint;
        sequence_id: bigint;
      }[]
    ).sort((a, b) => (a.id < b.id ? -1 : 1));
    const ended = exited.map((row) => ({
      id: numberID(row.id),
      sequence_id: numberID(row.sequence_id),
      exit_reason: reason,
    }));
    const started: { id: number | object; sequence_id: number | object }[] = [];
    // Old events and blocklisted subscribers never start sequences.
    if (!event.triggerEligible || event.subscriberStatus === "blocklisted")
      return { started, ended };
    const sequences = q.get("sequences-triggered-by").all(event.name) as {
      id: bigint;
      trigger: string;
      reentry: string;
    }[];
    for (const sequence of sequences) {
      if (!matches(sequence.trigger, event)) continue;
      const first = q.get("first-step").get(sequence.id) as {
        id: bigint;
        wait: string;
      } | null;
      if (!first) continue;
      if (
        sequence.reentry === "never" &&
        q.get("any-enrollment").get(event.subscriberId, sequence.id)
      )
        continue;
      const active = q.get("active-enrollment").get(event.subscriberId, sequence.id) as {
        id: bigint;
      } | null;
      if (active) {
        if (sequence.reentry !== "always") continue;
        // `always`: the running enrollment is replaced by this event.
        end(active.id, "exited", reason, now);
        ended.push({
          id: numberID(active.id),
          sequence_id: numberID(sequence.id),
          exit_reason: reason,
        });
      }
      const id = start(sequence.id, event.subscriberId, event.id, first, event.occurredAt, now);
      started.push({ id: numberID(id), sequence_id: numberID(sequence.id) });
    }
    return { started, ended };
  };

  const at = () => clock.now().toISOString();
  const subscriberEffects: SubscriberEffects = {
    blocklisted(ids) {
      if (ids.length) q.get("exit-by-subscribers").run(at(), at(), json(ids));
    },
    unsubscribed(ids, listIds) {
      if (ids.length && listIds.length)
        q.get("exit-by-lists").run(at(), at(), json(ids), json(listIds));
    },
  };
  const unsubscribeEffects: UnsubscribeEffects = {
    unsubscribed({ subscriberId, listId, listIds, blocklisted }) {
      if (blocklisted) subscriberEffects.blocklisted([subscriberId]);
      // The requested list exits even when its membership was already unsubscribed, so a
      // repeated request ends an enrollment started after the first one.
      else subscriberEffects.unsubscribed([subscriberId], [...new Set([listId, ...listIds])]);
    },
  };

  // Listing builds its statement from the filters present, so each shape uses its index.
  const listStatements = new Map<string, { rows: Statement; total: Statement }>();
  function listStatement(filter: EnrollmentFilter) {
    const clauses: string[] = [];
    if (filter.sequenceId !== undefined) clauses.push("sequence_id = ?");
    if (filter.subscriberId !== undefined) clauses.push("subscriber_id = ?");
    if (filter.status !== undefined) clauses.push("status = ?");
    if (filter.exitReason !== undefined) clauses.push("exit_reason = ?");
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    let statements = listStatements.get(where);
    if (!statements) {
      statements = {
        rows: db.prepare(
          `SELECT id, sequence_id, subscriber_id, trigger_event_id, step_id, due_at, status, exit_reason, created_at, updated_at, finished_at FROM enrollments${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
        ),
        total: db.prepare(`SELECT count(*) AS n FROM enrollments${where}`),
      };
      listStatements.set(where, statements);
    }
    const args: Param[] = [
      ...(filter.sequenceId !== undefined ? [filter.sequenceId] : []),
      ...(filter.subscriberId !== undefined ? [filter.subscriberId] : []),
      ...(filter.status !== undefined ? [filter.status] : []),
      ...(filter.exitReason !== undefined ? [filter.exitReason] : []),
    ];
    return { statements, args };
  }

  return {
    exitThenTrigger,
    subscriberEffects,
    unsubscribeEffects,
    get: byId,
    list(filter: EnrollmentFilter) {
      const { statements, args } = listStatement(filter);
      const rows = statements.rows.all(
        ...args,
        filter.perPage,
        (filter.page - 1) * filter.perPage,
      ) as EnrollmentRow[];
      const total = (statements.total.get(...args) as { n: bigint }).n;
      return {
        results: rows.map(project),
        total: numberID(total),
        page: filter.page,
        per_page: filter.perPage,
      };
    },
    /**
     * Manual enroll of an existing, non-blocklisted subscriber. Reentry applies unless
     * `force`; a forced or `always` enroll replaces a running enrollment (canceled, manual).
     * The caller holds the write transaction.
     */
    enroll(sequenceId: bigint, subscriberId: bigint, force: boolean): EnrollOutcome {
      const sequence = q.get("sequence-for-enroll").get(sequenceId) as {
        id: bigint;
        status: string;
        reentry: string;
      } | null;
      if (!sequence) return { error: "sequence_missing" };
      if (sequence.status !== "active") return { error: "sequence_inactive" };
      const first = q.get("first-step").get(sequenceId) as {
        id: bigint;
        wait: string;
      } | null;
      if (!first) return { error: "no_steps" };
      const now = at();
      if (
        !force &&
        sequence.reentry === "never" &&
        q.get("any-enrollment").get(subscriberId, sequenceId)
      )
        return { error: "reentry" };
      const active = q.get("active-enrollment").get(subscriberId, sequenceId) as {
        id: bigint;
      } | null;
      if (active) {
        if (!force && sequence.reentry !== "always") return { error: "reentry" };
        end(active.id, "canceled", "manual", now);
      }
      const id = start(sequenceId, subscriberId, null, first, now, now);
      return { enrollment: byId(id)! };
    },
    /** Cancel an active enrollment (canceled, manual). The caller holds the write. */
    cancel(id: bigint): EnrollmentRow | "missing" | "inactive" {
      const row = byId(id);
      if (!row) return "missing";
      if (!end(id, "canceled", "manual", at())) return "inactive";
      return byId(id)!;
    },
    /** Exit every active enrollment of an archived sequence. The caller holds the write. */
    archive(sequenceId: bigint) {
      q.get("exit-by-sequence").run(at(), at(), sequenceId);
    },
    close() {
      for (const filter of filters.values()) filter.statement.finalize();
      filters.clear();
      for (const s of listStatements.values()) {
        s.rows.finalize();
        s.total.finalize();
      }
      listStatements.clear();
      q.close();
    },
  };
}
export type Enrollments = ReturnType<typeof createEnrollments>;
