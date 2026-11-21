-- B116 (D131): a skipped campaign delivery names why it was skipped: `unsubscribed` (the membership
-- ended between the claim and the push), `subscriber_blocklisted`, or `subscriber_unavailable` (the
-- UUID or address changed after the claim). Other statuses keep NULL. The partial index serves the
-- campaign's skipped list, so it reads only that campaign's skipped deliveries.
ALTER TABLE campaign_deliveries ADD COLUMN reason TEXT;
CREATE INDEX idx_campaign_deliveries_skipped ON campaign_deliveries(campaign_id, subscriber_id)
  WHERE status = 'skipped';
