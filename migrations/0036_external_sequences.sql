-- B150c (15-external-sources sections 3 and 6, D172): sequences on a project's external source.
-- A sequence reads pushed events (`events`, every sequence before this migration) or the project's
-- source (`external`), never both.
ALTER TABLE sequences ADD COLUMN source TEXT NOT NULL DEFAULT 'events' CHECK (source IN ('events', 'external'));
-- An external enrollment's trigger is a source record: its ID and its `occurredAt`, which `since: trigger`,
-- reschedule and windows read locally. `trigger_event_id` stays for pushed events.
ALTER TABLE enrollments ADD COLUMN trigger_external_id TEXT CHECK (trigger_external_id IS NULL OR length(trigger_external_id) BETWEEN 1 AND 100);
ALTER TABLE enrollments ADD COLUMN trigger_occurred_at TEXT;
-- When a source read for this enrollment's current step first failed transiently; cleared once the step
-- is decided. A step retried for 72 hours from it ends the enrollment with `source_error`.
ALTER TABLE enrollments ADD COLUMN error_since TEXT;
