-- M3.4: provider deliveries already handled: a Mailgun token within its signature window and
-- an event ID for a day. A receipt commits with the bounce it admits, so a failed request can
-- be retried and a repeat changes nothing, across restarts.
CREATE TABLE bounce_receipts (
  key TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_bounce_receipts_expires ON bounce_receipts(expires_at);
