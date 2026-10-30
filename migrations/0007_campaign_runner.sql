-- M3.2 campaign runner (docs/design/04-sending.md#campaigns). A runner holds a campaign
-- with a lease: `runner_lease` names the holder and `runner_lease_until` is its expiry.
ALTER TABLE campaigns ADD COLUMN runner_lease TEXT;
ALTER TABLE campaigns ADD COLUMN runner_lease_until TEXT;

-- One row per subscriber a campaign has claimed, inserted with the batch cursor before
-- the batch is sent. The primary key makes a second message to the same subscriber
-- impossible. `claimed` rows left by a crashed runner become `unknown`; `skipped` means
-- the subscriber lost eligibility before the push. `claimed`, `sent` and `unknown` count
-- toward the marketing frequency cap from `at`.
CREATE TABLE campaign_deliveries (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE ON UPDATE CASCADE,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'failed', 'unknown', 'skipped')),
  at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, subscriber_id)
) WITHOUT ROWID;
CREATE INDEX idx_campaign_deliveries_subscriber ON campaign_deliveries(subscriber_id, at);
