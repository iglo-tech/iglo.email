-- Adapted from listmonk queries/campaigns.sql (next-campaigns, get-running-campaign,
-- update-campaign-counts, update-campaign-status) at 6fcd95f, with a lease and a
-- per-subscriber delivery claim (docs/design/04-sending.md#campaigns).

-- name: due-campaigns
-- Running campaigns, and scheduled ones whose send_at has passed, that no runner holds.
SELECT id FROM campaigns
WHERE (status = 'running' OR (status = 'scheduled' AND send_at IS NOT NULL AND send_at <= ?1))
  AND (runner_lease IS NULL OR runner_lease_until IS NULL OR runner_lease_until <= ?1)
ORDER BY id;

-- name: acquire-campaign
UPDATE campaigns SET runner_lease = ?2, runner_lease_until = ?3
WHERE id = ?1
  AND (status = 'running' OR (status = 'scheduled' AND send_at IS NOT NULL AND send_at <= ?4))
  AND (runner_lease IS NULL OR runner_lease_until IS NULL OR runner_lease_until <= ?4)
RETURNING id, uuid, type, name, subject, from_email, body, altbody, content_type, headers,
  attribs, messenger, template_id, status, last_subscriber_id, max_subscriber_id;

-- name: campaign-list-ids
SELECT list_id FROM campaign_lists WHERE campaign_id = ? AND list_id IS NOT NULL ORDER BY id;

-- name: start-campaign
-- next-campaigns: to_send and max_subscriber_id for every pickup; a scheduled campaign runs.
UPDATE campaigns SET to_send = ?2, max_subscriber_id = ?3,
  status = (CASE WHEN status != 'running' THEN 'running' ELSE status END),
  started_at = COALESCE(started_at, ?4)
WHERE id = ?1 AND runner_lease = ?5
RETURNING last_subscriber_id, max_subscriber_id;

-- name: renew-lease
UPDATE campaigns SET runner_lease_until = ?3 WHERE id = ?1 AND runner_lease = ?2;

-- name: release-lease
UPDATE campaigns SET runner_lease = NULL, runner_lease_until = NULL
WHERE id = ?1 AND runner_lease = ?2;

-- name: campaign-run-state
SELECT status, runner_lease, last_subscriber_id, max_subscriber_id FROM campaigns WHERE id = ?;

-- name: advance-cursor
UPDATE campaigns SET last_subscriber_id = MAX(last_subscriber_id, ?2), updated_at = ?3
WHERE id = ?1;

-- name: rewind-cursor
UPDATE campaigns SET last_subscriber_id = ?3, updated_at = ?4
WHERE id = ?1 AND runner_lease = ?2 AND last_subscriber_id > ?3;

-- name: add-sent
UPDATE campaigns SET sent = sent + ?2, updated_at = ?3 WHERE id = ?1;

-- name: claim-delivery
INSERT INTO campaign_deliveries (campaign_id, subscriber_id, status, at)
VALUES (?1, ?2, 'claimed', ?3) ON CONFLICT DO NOTHING;

-- name: set-delivery
UPDATE campaign_deliveries SET status = ?3, at = ?4 WHERE campaign_id = ?1 AND subscriber_id = ?2;

-- name: unclaim-delivery
DELETE FROM campaign_deliveries
WHERE campaign_id = ?1 AND subscriber_id = ?2 AND status = 'claimed';

-- name: abandoned-deliveries
-- Claims a stopped runner left without an outcome: a crash after the cursor commit.
SELECT COUNT(*) AS count, MIN(subscriber_id) AS first, MAX(subscriber_id) AS last
FROM campaign_deliveries WHERE campaign_id = ? AND status = 'claimed';

-- name: mark-abandoned
UPDATE campaign_deliveries SET status = 'unknown' WHERE campaign_id = ? AND status = 'claimed';

-- name: finish-campaign
UPDATE campaigns SET status = 'finished', updated_at = ?2
WHERE id = ?1 AND status IN ('running', 'scheduled');

-- name: pause-campaign
UPDATE campaigns SET status = 'paused', updated_at = ?2 WHERE id = ?1 AND status = 'running';

-- name: cancel-campaign
UPDATE campaigns SET status = 'cancelled', updated_at = ?2
WHERE id = ?1 AND status IN ('running', 'scheduled');

-- name: last-delivery
-- The latest campaign delivery that counts toward the marketing frequency cap.
SELECT MAX(at) AS at FROM campaign_deliveries
WHERE subscriber_id = ? AND status IN ('claimed', 'sent', 'unknown');
