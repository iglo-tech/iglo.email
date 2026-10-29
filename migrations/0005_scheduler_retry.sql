-- M5.4 scheduler retries and deleted-step cursors (docs/design/05-sequences.md#scheduler).
-- When a released enrollment may be claimed again after a failed attempt (a condition error or a
-- failed decision). `due_at` keeps the step's due time, which `max_late` measures from.
ALTER TABLE enrollments ADD COLUMN retry_at TEXT;
-- Claims order by the retry time when there is one, so retried work queues behind other due work.
DROP INDEX idx_enrollments_due;
CREATE INDEX idx_enrollments_claim ON enrollments(status, coalesce(retry_at, due_at));
-- A deleted step's position is now its cursor in the current numbering: the position of the
-- next active step. Saves keep it current. Earlier tombstones held their old position, read
-- minus the steps removed before them in the same save; convert them once.
WITH shifted AS MATERIALIZED (
  SELECT s.id, s.position - (SELECT count(*) FROM sequence_steps d
    WHERE d.sequence_id = s.sequence_id AND d.status = 'deleted' AND d.updated_at = s.updated_at
      AND d.position < s.position) AS position
  FROM sequence_steps s WHERE s.status = 'deleted')
UPDATE sequence_steps SET position = shifted.position FROM shifted
  WHERE sequence_steps.id = shifted.id AND sequence_steps.position <> shifted.position;
