-- M2.6: a delivery names its subscriber, so a deletion can clear personal data from its stored
-- payloads without scanning them (D25). There is no foreign key: the rows outlive the subscriber
-- and subscriber IDs are never reused. Due lookups run per webhook, so a backlog on one webhook
-- costs another nothing.
ALTER TABLE webhook_deliveries ADD COLUMN subscriber_id INTEGER;
CREATE INDEX idx_webhook_deliveries_subscriber ON webhook_deliveries(subscriber_id)
  WHERE subscriber_id IS NOT NULL;
DROP INDEX idx_webhook_deliveries_due;
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(webhook_id, status, next_attempt_at);
