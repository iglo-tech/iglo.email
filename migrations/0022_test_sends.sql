-- B108 (D114): the Message-ID of each step and campaign test send, so a bounce or complaint of a test
-- is named in the log. A test is not a send (D105): no sends row, statistic, webhook or analytics.
-- A Message-ID is kept lowercase without its angle brackets. Rows last seven days (the retention loop).
-- No recipient address: the row is a random Message-ID and numeric IDs, so it holds no personal data.
CREATE TABLE test_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('campaign', 'sequence_step')),
  campaign_id INTEGER,
  sequence_id INTEGER,
  step_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_test_sends_message ON test_sends(message_id);
CREATE INDEX idx_test_sends_created ON test_sends(created_at);
