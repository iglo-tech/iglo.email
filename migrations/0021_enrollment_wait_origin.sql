-- D101: a manual or test enrollment may name an earlier event as its trigger without its first wait
-- counting from that event. 1 (the default, and every row before this migration) keeps the rule
-- for event-started enrollments: the first wait counts from the event's occurred_at. 0 counts it from
-- the enrollment's creation.
ALTER TABLE enrollments ADD COLUMN wait_from_event INTEGER NOT NULL DEFAULT 1 CHECK (wait_from_event IN (0, 1));
