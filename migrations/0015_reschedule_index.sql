-- B5 reschedule: a batch reads one step's active enrollments by ID, so its cost is the batch and
-- not every active enrollment of the sequence. The partial index holds only what a batch may take.
CREATE INDEX idx_enrollments_step_active ON enrollments(step_id, id) WHERE status = 'active';
