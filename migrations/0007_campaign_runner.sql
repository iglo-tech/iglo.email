-- M3.2 campaign runner (docs/design/04-sending.md#campaigns). A runner holds a campaign
-- with a lease: `runner_lease` names the holder and `runner_lease_until` is its expiry.
ALTER TABLE campaigns ADD COLUMN runner_lease TEXT;
ALTER TABLE campaigns ADD COLUMN runner_lease_until TEXT;
-- Changes on every status change. A pipe opened at one generation stops at its next check
-- once it differs, even when a pause or cancel was undone before the pipe looked: a
-- resumed campaign reopens with its current content, lists and max_subscriber_id.
ALTER TABLE campaigns ADD COLUMN runner_generation INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER campaigns_runner_generation AFTER UPDATE OF status ON campaigns
WHEN OLD.status IS NOT NEW.status BEGIN
  UPDATE campaigns SET runner_generation = runner_generation + 1 WHERE id = NEW.id;
END;

-- One row per subscriber a campaign has claimed, inserted with the batch cursor before
-- the batch is sent. The primary key makes a second message to the same subscriber
-- impossible. `claimed` rows left by a crashed runner become `unknown`; `skipped` means
-- the subscriber lost eligibility or changed identity before the push. `claimed` rows
-- reserve the marketing frequency cap whatever their age; `sent` and `unknown` count from
-- `at`, which for an abandoned claim is when the restarted runner found it.
CREATE TABLE campaign_deliveries (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE ON UPDATE CASCADE,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'failed', 'unknown', 'skipped')),
  at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, subscriber_id)
) WITHOUT ROWID;
CREATE INDEX idx_campaign_deliveries_subscriber ON campaign_deliveries(subscriber_id, at);
