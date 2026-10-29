ALTER TABLE sends ADD COLUMN next_attempt_at TEXT;
ALTER TABLE sends ADD COLUMN retry_of INTEGER REFERENCES sends(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_sends_retry_of ON sends(retry_of) WHERE retry_of IS NOT NULL;
CREATE INDEX idx_sends_due ON sends(status, next_attempt_at, id);
