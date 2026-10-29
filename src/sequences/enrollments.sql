-- Native sequence enrollments (docs/design/05-sequences.md, 03-data-model.md#enrollments); no upstream source.
-- name: enrollment-by-id
SELECT id, sequence_id, subscriber_id, trigger_event_id, step_id, due_at, status, exit_reason, created_at, updated_at, finished_at FROM enrollments WHERE id = ?;
-- name: exit-by-event
-- Events API step 2: the subscriber's active enrollments in active sequences that exit on the event.
UPDATE enrollments SET status = 'exited', exit_reason = ?, step_id = NULL, due_at = NULL, finished_at = ?, updated_at = ?
  WHERE subscriber_id = ? AND status = 'active'
    AND sequence_id IN (SELECT s.id FROM sequences s, json_each(s.exit_on) j WHERE s.status = 'active' AND j.value = ?)
  RETURNING id, sequence_id;
-- name: sequences-triggered-by
SELECT id, trigger, reentry FROM sequences WHERE status = 'active' AND json_extract(trigger, '$.event') = ? ORDER BY id;
-- name: sequence-for-enroll
SELECT id, status, reentry FROM sequences WHERE id = ?;
-- name: first-step
SELECT id, wait FROM sequence_steps WHERE sequence_id = ? AND status = 'active' ORDER BY position LIMIT 1;
-- name: active-enrollment
SELECT id FROM enrollments WHERE subscriber_id = ? AND sequence_id = ? AND status = 'active';
-- name: any-enrollment
SELECT 1 FROM enrollments WHERE subscriber_id = ? AND sequence_id = ? LIMIT 1;
-- name: enrollment-insert
INSERT INTO enrollments (sequence_id, subscriber_id, trigger_event_id, step_id, due_at, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 'active', ?, ?) RETURNING id;
-- name: enrollment-end
UPDATE enrollments SET status = ?, exit_reason = ?, step_id = NULL, due_at = NULL, finished_at = ?, updated_at = ?
  WHERE id = ? AND status = 'active';
-- name: exit-by-lists
UPDATE enrollments SET status = 'exited', exit_reason = 'unsubscribed', step_id = NULL, due_at = NULL, finished_at = ?, updated_at = ?
  WHERE status = 'active' AND subscriber_id IN (SELECT value FROM json_each(?))
    AND sequence_id IN (SELECT id FROM sequences WHERE list_id IN (SELECT value FROM json_each(?)));
-- name: exit-by-subscribers
UPDATE enrollments SET status = 'exited', exit_reason = 'blocklisted', step_id = NULL, due_at = NULL, finished_at = ?, updated_at = ?
  WHERE status = 'active' AND subscriber_id IN (SELECT value FROM json_each(?));
-- name: exit-by-sequence
UPDATE enrollments SET status = 'exited', exit_reason = 'sequence_archived', step_id = NULL, due_at = NULL, finished_at = ?, updated_at = ?
  WHERE sequence_id = ? AND status = 'active';
-- name: claim-due
-- Scheduler claim: due, unleased enrollments of sequences that can run (paused and draft wait).
UPDATE enrollments SET claimed_until = ?1
  WHERE id IN (
    SELECT id FROM enrollments
    WHERE status = 'active' AND due_at <= ?2 AND (claimed_until IS NULL OR claimed_until < ?2)
      AND sequence_id IN (SELECT id FROM sequences WHERE status IN ('active', 'archived'))
    ORDER BY due_at, id LIMIT ?3)
  RETURNING id;
-- name: scheduler-context
SELECT e.id, e.sequence_id, e.subscriber_id, e.trigger_event_id, e.step_id, e.due_at, e.status,
    e.claimed_until, e.created_at, e.updated_at,
    s.name AS sequence_name, s.status AS sequence_status, s.list_id,
    st.uuid AS step_uuid, st.position, st.kind, st.template_id, st.subject, st.condition,
    st.on_false, st.cap_policy, st.max_late, st.status AS step_status, st.updated_at AS step_updated_at
  FROM enrollments e
  JOIN sequences s ON s.id = e.sequence_id
  JOIN sequence_steps st ON st.id = e.step_id
  WHERE e.id = ?;
-- name: claimed
SELECT 1 FROM enrollments WHERE id = ? AND status = 'active' AND claimed_until = ? AND step_id = ?;
-- name: next-after-active
SELECT id, wait FROM sequence_steps WHERE sequence_id = ?1 AND status = 'active' AND position > ?2
  ORDER BY position LIMIT 1;
-- name: next-after-deleted
-- Saving renumbers the remaining active steps, so the step that followed a deleted one now sits
-- at its old position minus the steps deleted before it in the same save.
SELECT id, wait FROM sequence_steps WHERE sequence_id = ?1 AND status = 'active'
    AND position >= ?2 - (SELECT count(*) FROM sequence_steps
      WHERE sequence_id = ?1 AND status = 'deleted' AND updated_at = ?3 AND position < ?2)
  ORDER BY position LIMIT 1;
-- name: claimed-advance
UPDATE enrollments SET step_id = ?, due_at = ?, claimed_until = NULL, updated_at = ?
  WHERE id = ? AND status = 'active' AND claimed_until = ?;
-- name: claimed-complete
UPDATE enrollments SET status = 'completed', step_id = NULL, due_at = NULL, claimed_until = NULL, finished_at = ?, updated_at = ?
  WHERE id = ? AND status = 'active' AND claimed_until = ?;
-- name: claimed-end
UPDATE enrollments SET status = ?, exit_reason = ?, step_id = NULL, due_at = NULL, claimed_until = NULL, finished_at = ?, updated_at = ?
  WHERE id = ? AND status = 'active' AND claimed_until = ?;
-- name: claimed-defer
UPDATE enrollments SET due_at = ?, claimed_until = NULL WHERE id = ? AND status = 'active' AND claimed_until = ?;
-- name: claimed-hold
UPDATE enrollments SET claimed_until = ? WHERE id = ? AND status = 'active' AND claimed_until = ?;
