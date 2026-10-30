-- M6.1 frequency-cap lookups (docs/design/04-sending.md#frequency-cap). The cap asks per
-- subscriber for rows in given statuses and for the latest counted time. Both indexes lead with
-- the subscriber and the status, so each lookup seeks to its status and reads the newest time
-- from the end of the range instead of scanning the subscriber's whole history.
-- The journal counts a marketing row from coalesce(sent_at, attempted_at, created_at).
DROP INDEX idx_sends_cap;
CREATE INDEX idx_sends_cap ON sends(subscriber_id, kind, status, coalesce(sent_at, attempted_at, created_at));
-- Campaign deliveries count from `at`; a `claimed` row holds the cap at any age.
DROP INDEX idx_campaign_deliveries_subscriber;
CREATE INDEX idx_campaign_deliveries_subscriber ON campaign_deliveries(subscriber_id, status, at);
