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
