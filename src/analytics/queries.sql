-- Adapted from listmonk queries/lists.sql, queries/campaigns.sql and schema.sql
-- (mat_dashboard_counts, mat_dashboard_charts) at 6fcd95f.
-- name: list-subscription-counts
SELECT list_id, substr(created_at, 1, ?1) AS bucket, COUNT(*) AS count
FROM subscriber_lists
WHERE list_id IN (SELECT value FROM json_each(?2)) AND created_at >= ?3 AND created_at <= ?4
GROUP BY list_id, bucket
ORDER BY bucket, list_id;
-- name: list-unsubscription-counts
-- Memberships retain only their current status and last update, not event history.
SELECT list_id, substr(updated_at, 1, ?1) AS bucket, COUNT(*) AS count
FROM subscriber_lists
WHERE list_id IN (SELECT value FROM json_each(?2)) AND status = 'unsubscribed'
  AND updated_at >= ?3 AND updated_at <= ?4
GROUP BY list_id, bucket
ORDER BY bucket, list_id;
-- name: campaign-link-counts
SELECT COUNT(*) AS count, l.url
FROM link_clicks c JOIN links l ON l.id = c.link_id
WHERE c.campaign_id IN (SELECT value FROM json_each(?1)) AND c.created_at >= ?2 AND c.created_at <= ?3
GROUP BY l.url ORDER BY count DESC, l.url LIMIT 50;
-- name: campaign-link-distinct-counts
SELECT COUNT(DISTINCT c.subscriber_id) AS count, l.url
FROM link_clicks c JOIN links l ON l.id = c.link_id
WHERE c.campaign_id IN (SELECT value FROM json_each(?1)) AND c.created_at >= ?2 AND c.created_at <= ?3
GROUP BY l.url ORDER BY count DESC, l.url LIMIT 50;
-- name: list-link-counts
SELECT COUNT(*) AS count, l.url
FROM link_clicks c JOIN links l ON l.id = c.link_id
WHERE c.campaign_id IN (
    SELECT campaign_id FROM campaign_lists WHERE list_id IN (SELECT value FROM json_each(?1))
  ) AND c.created_at >= ?2 AND c.created_at <= ?3
GROUP BY l.url ORDER BY count DESC, l.url LIMIT 50;
-- name: list-link-distinct-counts
SELECT COUNT(DISTINCT c.subscriber_id) AS count, l.url
FROM link_clicks c JOIN links l ON l.id = c.link_id
WHERE c.campaign_id IN (
    SELECT campaign_id FROM campaign_lists WHERE list_id IN (SELECT value FROM json_each(?1))
  ) AND c.created_at >= ?2 AND c.created_at <= ?3
GROUP BY l.url ORDER BY count DESC, l.url LIMIT 50;
-- name: subscriber-status-counts
SELECT status, COUNT(*) AS count FROM subscribers GROUP BY status;
-- name: subscriber-orphan-count
SELECT COUNT(*) AS count FROM subscribers s
WHERE NOT EXISTS (SELECT 1 FROM subscriber_lists m WHERE m.subscriber_id = s.id);
-- name: list-type-counts
SELECT COUNT(*) AS total,
  COUNT(*) FILTER (WHERE type = 'private') AS private,
  COUNT(*) FILTER (WHERE type = 'public') AS public,
  COUNT(*) FILTER (WHERE optin = 'single') AS optin_single,
  COUNT(*) FILTER (WHERE optin = 'double') AS optin_double
FROM lists;
-- name: campaign-status-counts
SELECT status, COUNT(*) AS count, SUM(sent) AS sent FROM campaigns GROUP BY status;
-- name: chart-views
-- A send's views are not campaign views; GET /api/sends/analytics reports them.
WITH latest AS (
  SELECT substr(created_at, 1, 10) AS day FROM campaign_views
  WHERE campaign_id IS NOT NULL ORDER BY id DESC LIMIT 1
)
SELECT COUNT(*) AS count, substr(created_at, 1, 10) AS date
FROM campaign_views, latest
WHERE campaign_id IS NOT NULL AND created_at >= date(latest.day, '-30 days')
  AND created_at < date(latest.day, '+1 day')
GROUP BY date ORDER BY date;
-- name: chart-clicks
WITH latest AS (
  SELECT substr(created_at, 1, 10) AS day FROM link_clicks
  WHERE campaign_id IS NOT NULL ORDER BY id DESC LIMIT 1
)
SELECT COUNT(*) AS count, substr(created_at, 1, 10) AS date
FROM link_clicks, latest
WHERE campaign_id IS NOT NULL AND created_at >= date(latest.day, '-30 days')
  AND created_at < date(latest.day, '+1 day')
GROUP BY date ORDER BY date;
-- name: sends-by-template
-- A send belongs to the moment it was delivered; its row may have been queued days earlier.
WITH sent AS (
  SELECT template_id, COUNT(*) AS count FROM sends
  WHERE status = 'sent' AND sent_at >= ?1 AND sent_at <= ?2
  GROUP BY template_id
), views AS (
  SELECT s.template_id, COUNT(*) AS count, COUNT(DISTINCT v.send_id) AS uniq
  FROM campaign_views v JOIN sends s ON s.id = v.send_id
  WHERE v.created_at >= ?1 AND v.created_at <= ?2
  GROUP BY s.template_id
), clicks AS (
  SELECT s.template_id, COUNT(*) AS count, COUNT(DISTINCT c.send_id) AS uniq
  FROM link_clicks c JOIN sends s ON s.id = c.send_id
  WHERE c.created_at >= ?1 AND c.created_at <= ?2
  GROUP BY s.template_id
), groups AS (
  SELECT template_id FROM sent UNION SELECT template_id FROM views UNION SELECT template_id FROM clicks
)
SELECT g.template_id, t.name AS template_name, COALESCE(sent.count, 0) AS sends,
  COALESCE(views.count, 0) AS views, COALESCE(views.uniq, 0) AS unique_views,
  COALESCE(clicks.count, 0) AS clicks, COALESCE(clicks.uniq, 0) AS unique_clicks
FROM groups g
LEFT JOIN templates t ON t.id = g.template_id
LEFT JOIN sent ON sent.template_id IS g.template_id
LEFT JOIN views ON views.template_id IS g.template_id
LEFT JOIN clicks ON clicks.template_id IS g.template_id
ORDER BY g.template_id;
-- name: sends-by-step
WITH sent AS (
  SELECT step_id, COUNT(*) AS count FROM sends
  WHERE status = 'sent' AND step_id IS NOT NULL AND sent_at >= ?1 AND sent_at <= ?2
  GROUP BY step_id
), views AS (
  SELECT s.step_id, COUNT(*) AS count, COUNT(DISTINCT v.send_id) AS uniq
  FROM campaign_views v JOIN sends s ON s.id = v.send_id
  WHERE s.step_id IS NOT NULL AND v.created_at >= ?1 AND v.created_at <= ?2
  GROUP BY s.step_id
), clicks AS (
  SELECT s.step_id, COUNT(*) AS count, COUNT(DISTINCT c.send_id) AS uniq
  FROM link_clicks c JOIN sends s ON s.id = c.send_id
  WHERE s.step_id IS NOT NULL AND c.created_at >= ?1 AND c.created_at <= ?2
  GROUP BY s.step_id
), groups AS (
  SELECT step_id FROM sent UNION SELECT step_id FROM views UNION SELECT step_id FROM clicks
)
SELECT g.step_id, st.position, st.sequence_id, q.name AS sequence_name, COALESCE(sent.count, 0) AS sends,
  COALESCE(views.count, 0) AS views, COALESCE(views.uniq, 0) AS unique_views,
  COALESCE(clicks.count, 0) AS clicks, COALESCE(clicks.uniq, 0) AS unique_clicks
FROM groups g
JOIN sequence_steps st ON st.id = g.step_id
JOIN sequences q ON q.id = st.sequence_id
LEFT JOIN sent ON sent.step_id = g.step_id
LEFT JOIN views ON views.step_id = g.step_id
LEFT JOIN clicks ON clicks.step_id = g.step_id
ORDER BY st.sequence_id, st.position;
