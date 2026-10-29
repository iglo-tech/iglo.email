// Native sequence definition store (docs/design/05-sequences.md#sequence-definition,
// 03-data-model.md#sequences-sequence_steps); no upstream source. The sequences module owns
// `sequences` and `sequence_steps`. Writes run inside the caller's write transaction.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import type { ListReferences } from "@/lists/references";
import { numberID, type Enrollments } from "@/sequences/enrollments";
import type { DefinitionInput, SequenceStatus } from "@/sequences/input";
import type { TemplateStore } from "@/templates/store";
import sql from "@/sequences/store.sql" with { type: "text" };

interface SequenceRow {
  id: bigint;
  uuid: string;
  name: string;
  status: SequenceStatus;
  trigger: string;
  exit_on: string;
  reentry: string;
  list_id: bigint | null;
  created_at: string;
  updated_at: string;
  active_enrollments: bigint;
}
interface StepRow {
  id: bigint;
  uuid: string;
  position: bigint;
  wait: string;
  kind: string;
  template_id: bigint | null;
  subject: string | null;
  condition: string | null;
  on_false: string;
  cap_policy: string;
  max_late: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/** A definition that cannot be saved or activated as it stands. */
export class SequenceConflict extends Error {
  constructor(
    readonly field: string,
    readonly detail: string,
  ) {
    super(`${field}: ${detail}`);
  }
}

const summary = (row: SequenceRow) => ({
  id: numberID(row.id),
  uuid: row.uuid,
  name: row.name,
  status: row.status,
  trigger: JSON.parse(row.trigger) as unknown,
  exit_on: JSON.parse(row.exit_on) as unknown,
  reentry: row.reentry,
  list_id: row.list_id === null ? null : numberID(row.list_id),
  created_at: row.created_at,
  updated_at: row.updated_at,
  active_enrollments: numberID(row.active_enrollments),
});
const step = (row: StepRow) => ({
  id: numberID(row.id),
  uuid: row.uuid,
  position: Number(row.position),
  wait: row.wait,
  kind: row.kind,
  template_id: row.template_id === null ? null : numberID(row.template_id),
  subject: row.subject,
  condition: row.condition === null ? null : (JSON.parse(row.condition) as unknown),
  on_false: row.on_false,
  cap_policy: row.cap_policy,
  max_late: row.max_late,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export function createSequenceStore(
  db: Database,
  clock: Clock,
  deps: {
    templates: Pick<TemplateStore, "get">;
    lists: Pick<ListReferences, "name">;
    enrollments: Pick<Enrollments, "archive">;
  },
) {
  const q = prepareNamedQueries(db, [{ name: "sequences/store", sql }]);
  const row = (id: bigint) => q.get("sequence-by-id").get(id) as SequenceRow | null;
  const steps = (id: bigint) => q.get("steps-by-sequence").all(id) as StepRow[];
  const full = (id: bigint) => {
    const found = row(id);
    return found && { ...summary(found), steps: steps(id).map(step) };
  };
  const templateType = (id: bigint) => deps.templates.get(id)?.type ?? null;

  /** Activation needs current steps whose templates and list still exist. */
  function checkActivatable(id: bigint) {
    const current = steps(id);
    if (!current.length) throw new SequenceConflict("steps", "an active sequence needs a step");
    const listId = row(id)!.list_id;
    for (const [i, s] of current.entries()) {
      if (s.template_id === null || templateType(s.template_id) !== "tx")
        throw new SequenceConflict(
          `steps.${i}.template_id`,
          "must be an existing transactional template",
        );
      if (s.kind === "marketing" && listId === null)
        throw new SequenceConflict("list_id", "is required when a step is marketing");
    }
  }
  function changeStatus(id: bigint, from: SequenceStatus, to: SequenceStatus) {
    if (to === "active") checkActivatable(id);
    if (to === "archived" && from !== "archived") deps.enrollments.archive(id);
  }
  function writeSteps(id: bigint, input: DefinitionInput, now: string) {
    const existing = new Set((q.get("step-ids").all(id) as { id: bigint }[]).map((r) => r.id));
    for (const [i, s] of input.steps.entries())
      if (s.id !== null && !existing.has(s.id))
        throw new SequenceConflict(`steps.${i}.id`, "is not an active step of this sequence");
    const kept = new Set(input.steps.flatMap((s) => (s.id === null ? [] : [s.id])));
    // Removed steps are never hard-deleted: enrollments and sends may point at them.
    for (const old of existing) if (!kept.has(old)) q.get("step-delete-soft").run(now, old);
    q.get("steps-park").run(id);
    for (const [position, s] of input.steps.entries()) {
      const values = [
        s.wait,
        s.kind,
        s.templateId,
        s.subject,
        s.condition,
        s.onFalse,
        s.capPolicy,
        s.maxLate,
      ] as const;
      if (s.id !== null) q.get("step-update").run(position, ...values, now, s.id);
      else q.get("step-insert").run(crypto.randomUUID(), id, position, ...values, now, now);
    }
  }

  return {
    templateType,
    listExists: (id: bigint) => deps.lists.name(id) !== null,
    get: full,
    list(filter: { status?: string; page: number; perPage: number }) {
      const status = filter.status ?? null;
      const rows = q
        .get("sequences-page")
        .all(status, filter.perPage, (filter.page - 1) * filter.perPage) as SequenceRow[];
      const total = (q.get("sequences-count").get(status) as { n: bigint }).n;
      return {
        results: rows.map(summary),
        total: numberID(total),
        page: filter.page,
        per_page: filter.perPage,
      };
    },
    create(input: DefinitionInput) {
      const now = clock.now().toISOString();
      for (const [i, s] of input.steps.entries())
        if (s.id !== null)
          throw new SequenceConflict(`steps.${i}.id`, "is not an active step of this sequence");
      const id = (
        q
          .get("sequence-insert")
          .get(
            crypto.randomUUID(),
            input.name,
            input.status ?? "draft",
            input.trigger,
            JSON.stringify(input.exitOn),
            input.reentry,
            input.listId,
            now,
            now,
          ) as { id: bigint }
      ).id;
      writeSteps(id, input, now);
      if (input.status === "active") checkActivatable(id);
      return full(id)!;
    },
    /** Replace a definition; kept steps keep their IDs. Null when it does not exist. */
    update(id: bigint, input: DefinitionInput) {
      const current = row(id);
      if (!current) return null;
      const now = clock.now().toISOString();
      const status = input.status ?? current.status;
      q.get("sequence-update").run(
        input.name,
        status,
        input.trigger,
        JSON.stringify(input.exitOn),
        input.reentry,
        input.listId,
        now,
        id,
      );
      writeSteps(id, input, now);
      changeStatus(id, current.status, status);
      return full(id)!;
    },
    setStatus(id: bigint, status: SequenceStatus) {
      const current = row(id);
      if (!current) return null;
      const now = clock.now().toISOString();
      q.get("sequence-status").run(status, now, id);
      changeStatus(id, current.status, status);
      return full(id)!;
    },
    /** Delete a sequence that never had enrollments; archive it otherwise. */
    remove(id: bigint): "ok" | "missing" | "enrolled" {
      if (!row(id)) return "missing";
      if (q.get("sequence-has-enrollments").get(id)) return "enrolled";
      q.get("steps-delete").run(id);
      q.get("sequence-delete").run(id);
      return "ok";
    },
    close: () => q.close(),
  };
}
export type SequenceStore = ReturnType<typeof createSequenceStore>;
