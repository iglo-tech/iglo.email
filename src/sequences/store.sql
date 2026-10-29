-- Native sequence definitions (docs/design/05-sequences.md#sequence-definition, 03-data-model.md); no upstream source.
-- name: sequence-by-id
SELECT id, uuid, name, status, trigger, exit_on, reentry, list_id, created_at, updated_at,
  (SELECT count(*) FROM enrollments WHERE sequence_id = sequences.id AND status = 'active') AS active_enrollments
  FROM sequences WHERE id = ?;
-- name: steps-by-sequence
SELECT id, uuid, position, wait, kind, template_id, subject, condition, on_false, cap_policy, max_late, status, created_at, updated_at
  FROM sequence_steps WHERE sequence_id = ? AND status = 'active' ORDER BY position;
-- name: sequence-insert
INSERT INTO sequences (uuid, name, status, trigger, exit_on, reentry, list_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id;
-- name: sequence-update
UPDATE sequences SET name = ?, status = ?, trigger = ?, exit_on = ?, reentry = ?, list_id = ?, updated_at = ? WHERE id = ?;
-- name: sequence-status
UPDATE sequences SET status = ?, updated_at = ? WHERE id = ?;
-- name: step-positions
SELECT id, position FROM sequence_steps WHERE sequence_id = ? AND status = 'active';
-- name: pending-deleted-steps
-- Deleted steps that active enrollments still wait on, with their cursor positions.
SELECT id, position FROM sequence_steps WHERE sequence_id = ?1 AND status = 'deleted'
  AND id IN (SELECT step_id FROM enrollments WHERE sequence_id = ?1 AND status = 'active');
-- name: step-cursor
UPDATE sequence_steps SET position = ? WHERE id = ? AND status = 'deleted';
-- name: step-delete-soft
UPDATE sequence_steps SET status = 'deleted', updated_at = ? WHERE id = ?;
-- name: steps-park
-- Kept steps move out of the way of the unique active position index before renumbering.
UPDATE sequence_steps SET position = -id WHERE sequence_id = ? AND status = 'active';
-- name: step-update
UPDATE sequence_steps SET position = ?, wait = ?, kind = ?, template_id = ?, subject = ?, condition = ?, on_false = ?, cap_policy = ?, max_late = ?, updated_at = ? WHERE id = ?;
-- name: step-insert
INSERT INTO sequence_steps (uuid, sequence_id, position, wait, kind, template_id, subject, condition, on_false, cap_policy, max_late, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?);
-- name: sequence-has-enrollments
SELECT 1 FROM enrollments WHERE sequence_id = ? LIMIT 1;
-- name: steps-delete
DELETE FROM sequence_steps WHERE sequence_id = ?;
-- name: sequence-delete
DELETE FROM sequences WHERE id = ?;
-- name: sequences-page
SELECT id, uuid, name, status, trigger, exit_on, reentry, list_id, created_at, updated_at,
  (SELECT count(*) FROM enrollments WHERE sequence_id = sequences.id AND status = 'active') AS active_enrollments
  FROM sequences WHERE ?1 IS NULL OR status = ?1 ORDER BY id DESC LIMIT ?2 OFFSET ?3;
-- name: sequences-count
SELECT count(*) AS n FROM sequences WHERE ?1 IS NULL OR status = ?1;
