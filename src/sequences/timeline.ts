// What the enrollment explorer shows of one enrollment (docs/design/05-sequences.md#admin-ui); no
// upstream source. The scheduler records a step's decision only when it writes a send, so sends are
// the only step entries: the current definition cannot say what an enrollment did, since a step may
// have been added or moved since. A sent step is named by its ID, since its position changes with
// the definition; only the step being waited for has one. `event` is null for a viewer who may not
// read the subscriber.
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
  const byId = new Map(steps.map((step) => [step.id, step]));
  const current = row.step_id === null ? undefined : byId.get(row.step_id);
  const recorded = sends.flatMap((send) => {
    const step = send.step_id === null ? undefined : byId.get(send.step_id);
    return step
      ? [
          {
            type: "step",
            at: send.sent_at ?? send.created_at,
            step_id: numberID(step.id),
            removed: step.status === "deleted",
            kind: send.kind,
            decision: send.status,
            reason: send.skip_reason,
            send_id: numberID(send.id),
          },
        ]
      : [];
  });
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
    ...recorded,
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
