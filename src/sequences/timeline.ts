// What the enrollment explorer shows of one enrollment (docs/design/05-sequences.md#admin-ui); no
// upstream source. The scheduler records a step's decision only when it writes a send, so sends are
// the only step entries: the current definition cannot say what an enrollment did, since a step may
// have been added or moved since. A sent step is named by its ID, since its position changes with
// the definition; only the step being waited for has one. `event` is null for a viewer who may not
// read the subscriber.
import type { EventRow } from "@/events/store";
import type { EnrollmentSend, Sends } from "@/messaging/sends";
import { numberID, project } from "@/sequences/enrollments";
import type { EnrollmentRow, Enrollments } from "@/sequences/enrollments";

type Step = ReturnType<Enrollments["steps"]>[number];

/**
 * Until when the frequency cap holds an active enrollment's wait (B127), or null. It holds when the
 * step being waited for is marketing under the `defer` policy, the cap still blocks at `now`, and
 * the cap frees no later than the wait's due time, so the cap is what keeps the step from going
 * when it is due. Read from the journal the cap counts; nothing is stored for it.
 */
export function frequencyHold(
  row: EnrollmentRow,
  steps: Array<Step>,
  capFreeAt: Pick<Sends, "capFreeAt">["capFreeAt"],
  now: Date,
): Date | null {
  const current = row.step_id === null ? undefined : steps.find((step) => step.id === row.step_id);
  if (
    row.status !== "active" ||
    row.due_at === null ||
    current?.kind !== "marketing" ||
    current.cap_policy !== "defer"
  ) {
    return null;
  }
  const free = capFreeAt(row.subscriber_id, now);
  return free.getTime() > now.getTime() && free.getTime() >= Date.parse(row.due_at) ? free : null;
}

/**
 * One page of a subscriber's enrollments, projected, each with `held_until`: when the frequency cap
 * holds its wait, or null (B127). Each sequence's steps are read once for the page.
 */
export function listedWithHolds(
  rows: Array<EnrollmentRow>,
  steps: (sequenceId: bigint) => Array<Step>,
  capFreeAt: Pick<Sends, "capFreeAt">["capFreeAt"],
  now: Date,
) {
  const byRow = new Map<bigint, Array<Step>>();
  return rows.map((row) => {
    let sequenceSteps = byRow.get(row.sequence_id);
    if (sequenceSteps === undefined) {
      sequenceSteps = steps(row.sequence_id);
      byRow.set(row.sequence_id, sequenceSteps);
    }
    const until = frequencyHold(row, sequenceSteps, capFreeAt, now);
    return { ...project(row), held_until: until ? until.toISOString() : null };
  });
}

export function timeline(
  row: EnrollmentRow,
  event: EventRow | null,
  steps: Array<Step>,
  sends: Array<EnrollmentSend>,
  heldUntil: Date | null,
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
            // The frequency cap's hold, when it is what keeps the step from going (B127).
            held: heldUntil ? "frequency_cap" : null,
            held_until: heldUntil ? heldUntil.toISOString() : null,
          },
        ]
      : [{ type: "ended", at: row.finished_at, status: row.status, reason: row.exit_reason }]),
  ];
}
