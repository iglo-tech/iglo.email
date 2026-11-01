-- B2 retention (D70). Each partial index holds only what a purge pass may still take, so a pass
-- reads its next rows without scanning the history. Sessions expire by a value inside their JSON;
-- the expression matches what the owner reads, a row without one lasting seven days.
ALTER TABLE sends ADD COLUMN tracked_links TEXT;
CREATE INDEX idx_sends_compactable ON sends(created_at)
  WHERE payload IS NOT NULL AND status IN ('sent', 'failed', 'skipped', 'unknown');
CREATE INDEX idx_webhook_deliveries_finished ON webhook_deliveries(updated_at)
  WHERE status IN ('delivered', 'failed');
CREATE INDEX idx_sessions_expiry ON sessions(
  coalesce(json_extract(data, '$.expires_at'), unixepoch(created_at) * 1000 + 604800000)
);
