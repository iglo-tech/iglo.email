-- Native sequence enrollments (docs/design/05-sequences.md, 03-data-model.md#enrollments); no upstream source.
-- name: enrollment-by-id
SELECT id, sequence_id, subscriber_id, trigger_event_id, step_id, due_at, status, exit_reason, exit_condition, created_at, updated_at, finished_at, test,
    trigger_external_id, trigger_occurred_at, error_since,
    (SELECT name FROM sequences WHERE sequences.id = sequence_id) AS sequence_name,
    (SELECT source FROM sequences WHERE sequences.id = sequence_id) AS sequence_source
  FROM enrollments WHERE id = ?;
-- name: exit-by-event
-- Events API step 2: the subscriber's active enrollments in sequences of any status that exit on the event.
-- A pushed event ends only pushed-event sequences: an external one reads its source (D169, D172).
UPDATE enrollments SET status = 'exited', exit_reason = ?, step_id = NULL, due_at = NULL, claimed_until = NULL, retry_at = NULL, finished_at = ?, updated_at = ?
  WHERE subscriber_id = ? AND status = 'active'
    AND sequence_id IN (SELECT s.id FROM sequences s, json_each(s.exit_on) j WHERE j.value = ? AND s.source = 'events')
  RETURNING id, sequence_id;
-- name: sequences-triggered-by
-- A pushed event starts only pushed-event sequences (D169, D172).
SELECT id, trigger, reentry FROM sequences WHERE status = 'active' AND json_extract(trigger, '$.event') = ? AND source = 'events' ORDER BY id;
-- name: exit-by-record
-- D173: a source record's exits. It ends only external sequences, as a pushed event ends only pushed ones.
UPDATE enrollments SET status = 'exited', exit_reason = ?, step_id = NULL, due_at = NULL, claimed_until = NULL, retry_at = NULL, finished_at = ?, updated_at = ?
  WHERE subscriber_id = ? AND status = 'active'
    AND sequence_id IN (SELECT s.id FROM sequences s, json_each(s.exit_on) j WHERE j.value = ? AND s.source = 'external')
  RETURNING id, sequence_id;
-- name: external-triggered-by
-- D173: the active external sequences a source record under this name may start.
SELECT id, trigger, reentry FROM sequences WHERE status = 'active' AND json_extract(trigger, '$.event') = ? AND source = 'external' ORDER BY id;
-- name: external-sequence
SELECT id, trigger, reentry FROM sequences WHERE id = ? AND status = 'active' AND source = 'external';
-- name: external-names
-- D173: the record names the source stream subscribes to for sequences: an active external sequence's
-- trigger, and an active or paused external sequence's `exit_on`.
SELECT DISTINCT name FROM (
    SELECT json_extract(trigger, '$.event') AS name FROM sequences WHERE source = 'external' AND status = 'active'
    UNION ALL
    SELECT j.value AS name FROM sequences s, json_each(s.exit_on) j WHERE s.source = 'external' AND s.status IN ('active', 'paused')
  ) WHERE typeof(name) = 'text' AND name != '' ORDER BY name;
-- name: end-by-subscriber
-- D173: a subscriber row that stops being its person (an address conflict) ends every active enrollment.
UPDATE enrollments SET status = ?, exit_reason = ?, step_id = NULL, due_at = NULL, claimed_until = NULL, retry_at = NULL, finished_at = ?, updated_at = ?
  WHERE +status = 'active' AND subscriber_id = ?;
-- name: sequence-marketing
-- B124 (D125): whether any active step of the sequence is marketing, which a suppressed person never starts.
SELECT 1 FROM sequence_steps WHERE sequence_id = ? AND status = 'active' AND kind = 'marketing' LIMIT 1;
-- name: sequence-for-enroll
SELECT id, status, reentry, source, json_extract(trigger, '$.event') AS event FROM sequences WHERE id = ?;
-- name: first-step
SELECT id, wait FROM sequence_steps WHERE sequence_id = ? AND status = 'active' ORDER BY position LIMIT 1;
-- name: active-enrollment
SELECT id FROM enrollments WHERE subscriber_id = ? AND sequence_id = ? AND status = 'active' AND test = 0;
-- name: active-test
SELECT id FROM enrollments WHERE subscriber_id = ? AND sequence_id = ? AND status = 'active' AND test = 1;
-- name: any-enrollment
-- Reentry counts real enrollments: a test leaves no history a later real trigger has to pass.
SELECT 1 FROM enrollments WHERE subscriber_id = ? AND sequence_id = ? AND test = 0 LIMIT 1;
-- name: enrollment-insert
INSERT INTO enrollments (sequence_id, subscriber_id, trigger_event_id, step_id, due_at, status, created_at, updated_at, test, wait_from_event, trigger_external_id, trigger_occurred_at)
  VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?) RETURNING id;
-- name: test-list
-- Consent is checked for this list when any current step is marketing.
SELECT list_id FROM sequences WHERE id = ?1
  AND EXISTS (SELECT 1 FROM sequence_steps WHERE sequence_id = ?1 AND status = 'active' AND kind = 'marketing');
-- name: enrollment-steps
SELECT id, position, kind, status, cap_policy FROM sequence_steps WHERE sequence_id = ? ORDER BY status, position;
-- name: enrollment-end
UPDATE enrollments SET status = ?, exit_reason = ?, step_id = NULL, due_at = NULL, claimed_until = NULL, retry_at = NULL, finished_at = ?, updated_at = ?
  WHERE id = ? AND status = 'active';
-- name: exit-by-lists
-- B130 (D128, r1): leaving a list ends only the enrollments whose next step is marketing, as the all-lists
-- option does. A transactional step keeps running, even in a sequence tied to the list; a mixed sequence
-- delivers its transactional step and ends at its marketing step. The step is the one the enrollment runs next, as
-- the scheduler advances it: its current step, or the first active step at or after a deleted current step's
-- position (enrollments.ts advance, next-after-deleted). `+status` keeps SQLite from choosing the
-- status-only claim index, which would read every active enrollment in the install (docs/perf/B130-public-defaults.md).
UPDATE enrollments SET status = 'exited', exit_reason = 'unsubscribed', step_id = NULL, due_at = NULL, claimed_until = NULL, retry_at = NULL, finished_at = ?, updated_at = ?
  WHERE +status = 'active' AND subscriber_id IN (SELECT value FROM json_each(?))
    AND sequence_id IN (SELECT id FROM sequences WHERE list_id IN (SELECT value FROM json_each(?)))
    AND (SELECT kind FROM sequence_steps WHERE sequence_id = enrollments.sequence_id AND status = 'active'
      AND position >= (SELECT position FROM sequence_steps WHERE id = enrollments.step_id)
      ORDER BY position LIMIT 1) = 'marketing';
-- name: exit-by-subscribers
-- `+status`: see exit-by-lists. The subscriber's enrollments, not every active one, are the rows read.
UPDATE enrollments SET status = 'exited', exit_reason = 'blocklisted', step_id = NULL, due_at = NULL, claimed_until = NULL, retry_at = NULL, finished_at = ?, updated_at = ?
  WHERE +status = 'active' AND subscriber_id IN (SELECT value FROM json_each(?));
-- name: exit-marketing-by-subscriber
-- B130 (D128): the public "all lists" option. An enrollment whose next step is marketing ends now, as an
-- unsubscribe does; one whose next step is transactional keeps running. "Next step" and `+status`: see exit-by-lists.
UPDATE enrollments SET status = 'exited', exit_reason = 'unsubscribed', step_id = NULL, due_at = NULL, claimed_until = NULL, retry_at = NULL, finished_at = ?, updated_at = ?
  WHERE +status = 'active' AND subscriber_id = ?
    AND (SELECT kind FROM sequence_steps WHERE sequence_id = enrollments.sequence_id AND status = 'active'
      AND position >= (SELECT position FROM sequence_steps WHERE id = enrollments.step_id)
      ORDER BY position LIMIT 1) = 'marketing';
-- name: exit-by-sequence
UPDATE enrollments SET status = 'exited', exit_reason = 'sequence_archived', step_id = NULL, due_at = NULL, claimed_until = NULL, retry_at = NULL, finished_at = ?, updated_at = ?
  WHERE sequence_id = ? AND status = 'active';
-- name: claim-due
-- Scheduler claim: due, unleased enrollments of sequences that can run (paused and draft wait).
-- A retried enrollment is due again at its retry time and queues by it behind other due work.
UPDATE enrollments SET claimed_until = ?1
  WHERE id IN (
    SELECT id FROM enrollments
    WHERE status = 'active' AND coalesce(retry_at, due_at) <= ?2
      AND (claimed_until IS NULL OR claimed_until < ?2)
      AND sequence_id IN (SELECT id FROM sequences WHERE status IN ('active', 'archived'))
    ORDER BY coalesce(retry_at, due_at), id LIMIT ?3)
  RETURNING id, coalesce(retry_at, due_at) AS run_at;
-- name: scheduler-context
SELECT e.id, e.sequence_id, e.subscriber_id, e.trigger_event_id, e.step_id, e.due_at, e.status,
    e.claimed_until, e.created_at, e.updated_at, e.test,
    e.trigger_external_id, e.trigger_occurred_at, e.error_since, e.error_last,
    s.name AS sequence_name, s.status AS sequence_status, s.list_id, s.source,
    st.uuid AS step_uuid, st.position, st.kind, st.template_id, st.subject, st.condition, st.aggregates,
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
-- A deleted step's position is the current position of the step that follows it (saves keep it).
SELECT id, wait FROM sequence_steps WHERE sequence_id = ?1 AND status = 'active' AND position >= ?2
  ORDER BY position LIMIT 1;
-- name: claimed-advance
-- D172: `error_since` and `error_last` are per enrollment; a step passed without a source read (late,
-- deleted) keeps them.
UPDATE enrollments SET step_id = ?1, due_at = ?2, claimed_until = NULL, retry_at = NULL,
    error_since = CASE WHEN ?3 THEN error_since END, error_last = CASE WHEN ?3 THEN error_last END,
    updated_at = ?4
  WHERE id = ?5 AND status = 'active' AND claimed_until = ?6;
-- name: claimed-complete
-- D180: a completed enrollment has no outage window left, whatever its last step read.
UPDATE enrollments SET status = 'completed', step_id = NULL, due_at = NULL, claimed_until = NULL, retry_at = NULL,
    error_since = NULL, error_last = NULL, finished_at = ?, updated_at = ?
  WHERE id = ? AND status = 'active' AND claimed_until = ?;
-- name: claimed-end
UPDATE enrollments SET status = ?, exit_reason = ?, exit_condition = ?, step_id = NULL, due_at = NULL, claimed_until = NULL, retry_at = NULL, finished_at = ?, updated_at = ?
  WHERE id = ? AND status = 'active' AND claimed_until = ?;
-- name: claimed-defer
-- D180: a defer decided without a source read keeps the outage window, as claimed-advance does.
UPDATE enrollments SET due_at = ?1, claimed_until = NULL, retry_at = NULL,
    error_since = CASE WHEN ?4 THEN error_since END, error_last = CASE WHEN ?4 THEN error_last END
  WHERE id = ?2 AND status = 'active' AND claimed_until = ?3;
-- name: claimed-release
UPDATE enrollments SET claimed_until = NULL, retry_at = ? WHERE id = ? AND status = 'active' AND claimed_until = ?;
-- name: claimed-source-retry
-- D172: a transient source failure releases the claim for a retry and records its outage window.
UPDATE enrollments SET claimed_until = NULL, retry_at = ?, error_since = ?, error_last = ?
  WHERE id = ? AND status = 'active' AND claimed_until = ?;
-- name: reschedule-batch
-- B5: waiting enrollments of one step after a cursor, with the time that step's wait counts from.
-- Claimed (leased) rows are left to the scheduler.
SELECT e.id, e.due_at, e.retry_at, e.created_at, e.updated_at, e.test, e.wait_from_event,
    coalesce(ev.occurred_at, e.trigger_occurred_at) AS event_at
  FROM enrollments e LEFT JOIN events ev ON ev.id = e.trigger_event_id
  WHERE e.step_id = ?2 AND e.status = 'active' AND e.id > ?3 AND e.sequence_id = ?1
    AND (e.claimed_until IS NULL OR e.claimed_until < ?4)
  ORDER BY e.id LIMIT ?5;
-- name: reschedule-set
UPDATE enrollments SET due_at = ?1 WHERE id = ?2 AND status = 'active' AND step_id = ?3
  AND (claimed_until IS NULL OR claimed_until < ?4);
-- name: reschedule-step
SELECT wait FROM sequence_steps WHERE id = ? AND sequence_id = ? AND status = 'active';
-- name: subscriber-event-links
-- B127: a subscriber's enrollments that a page of its events started (the trigger) or exited (the
-- event's name and the time it was received, which the exit recorded). The subscriber's own index
-- bounds the read; the two JSON arrays hold the page's event IDs and its {name, at} pairs.
SELECT e.id, e.sequence_id, e.trigger_event_id, e.exit_reason, e.finished_at,
    (SELECT name FROM sequences WHERE sequences.id = e.sequence_id) AS sequence_name
  FROM enrollments e
  WHERE e.subscriber_id = ?1
    AND (e.trigger_event_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?2))
      OR EXISTS (SELECT 1 FROM json_each(?3) j
        WHERE e.exit_reason = 'event:' || json_extract(j.value, '$.name')
          AND e.finished_at = json_extract(j.value, '$.at')));
