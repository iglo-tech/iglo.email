// What the enrollment explorer shows of one enrollment (docs/design/05-sequences.md#admin-ui); no
// upstream source. The scheduler records a step's decision only when it writes a send, so a step
// passed without one (a false condition with `on_false: skip`) is inferred from the enrollment's
// position. An enrollment that ended keeps no position, so its last step is the end entry.
import type { EventRow } from "@/events/store";
import type { EnrollmentSend } from "@/messaging/sends";
import { numberID, type EnrollmentRow, type Enrollments } from "@/sequences/enrollments";

type Step = ReturnType<Enrollments["steps"]>[number];

export function timeline(
  row: EnrollmentRow,
  event: EventRow | null,
  steps: Step[],
  sends: EnrollmentSend[],
) {
  const stepEntry = (step: Step, send: EnrollmentSend | undefined) => ({
    type: "step",
    at: send ? (send.sent_at ?? send.created_at) : null,
    step_id: numberID(step.id),
    position: Number(step.position),
    kind: send?.kind ?? step.kind,
    decision: send?.status ?? "passed",
    reason: send?.skip_reason ?? null,
    send_id: send ? numberID(send.id) : null,
  });
  const current = steps.find((step) => step.id === row.step_id);
  const passed = (step: Step) =>
    step.status === "active" &&
    (row.status === "completed" || (current !== undefined && step.position < current.position));
  const bySend = new Map(sends.map((send) => [send.step_id, send]));
  const reached = steps.flatMap((step) => {
    const send = bySend.get(step.id);
    return send || passed(step) ? [stepEntry(step, send)] : [];
  });
  reached.sort((a, b) => a.position - b.position);
  return [
    ...(event
      ? [
          {
            type: "trigger",
            at: event.occurred_at,
            name: event.name,
            data: JSON.parse(event.data) as unknown,
          },
        ]
      : []),
    { type: "enrolled", at: row.created_at },
    ...reached,
    ...(row.status === "active"
      ? [
          {
            type: "waiting",
            at: row.due_at,
            step_id: row.step_id === null ? null : numberID(row.step_id),
            position: current ? Number(current.position) : null,
            kind: current?.kind ?? null,
          },
        ]
      : [{ type: "ended", at: row.finished_at, status: row.status, reason: row.exit_reason }]),
  ];
}
