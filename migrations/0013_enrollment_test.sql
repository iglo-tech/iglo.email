-- M5.5 test mode (docs/design/05-sequences.md#test-mode): a test enrollment runs beside a real one
-- and leaves it alone, so the one-active rule applies to real and to test enrollments separately.
ALTER TABLE enrollments ADD COLUMN test INTEGER NOT NULL DEFAULT 0 CHECK (test IN (0, 1));
DROP INDEX idx_enrollments_one_active;
CREATE UNIQUE INDEX idx_enrollments_one_active ON enrollments(subscriber_id, sequence_id) WHERE status = 'active' AND test = 0;
CREATE UNIQUE INDEX idx_enrollments_one_active_test ON enrollments(subscriber_id, sequence_id) WHERE status = 'active' AND test = 1;
-- Counts leave test enrollments out and stay answerable from the index.
DROP INDEX idx_enrollments_sequence_status;
CREATE INDEX idx_enrollments_sequence_status ON enrollments(sequence_id, status, test);
