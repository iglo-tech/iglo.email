-- M5.3 sequences and enrollments (docs/design/05-sequences.md, 03-data-model.md).
-- What an idempotent event's first request started and ended, replayed for a repeated key.
ALTER TABLE events ADD COLUMN enrollments TEXT CHECK (enrollments IS NULL OR (json_valid(enrollments) AND json_type(enrollments) = 'object'));
-- At most one active enrollment per subscriber and sequence, whatever path creates it.
CREATE UNIQUE INDEX idx_enrollments_one_active ON enrollments(subscriber_id, sequence_id) WHERE status = 'active';
-- Archive exits, delete checks, counts and the sequence filter of the enrollment list.
CREATE INDEX idx_enrollments_sequence_status ON enrollments(sequence_id, status);
-- Active sequences triggered by an event name.
CREATE INDEX idx_sequences_trigger_event ON sequences(json_extract(trigger, '$.event')) WHERE status = 'active';
