-- Adapted from listmonk queries/campaigns.sql and queries/lists.sql at 6fcd95f. %table% is
-- campaign_views, link_clicks or bounces. bucket is created_at cut to ?1 characters, a UTC
-- DATE_TRUNC that the store finishes; rows of a send have no campaign_id and never match.
-- name: campaign-counts
SELECT campaign_id, substr(created_at, 1, ?1) AS bucket, COUNT(*) AS count
FROM %table%
WHERE campaign_id IN (SELECT value FROM json_each(?2)) AND created_at >= ?3 AND created_at <= ?4
GROUP BY campaign_id, bucket;
-- name: campaign-unique-counts
-- DISTINCT ON keeps each pair's earliest period, and NULL subscribers are one pair.
SELECT campaign_id, substr(first, 1, ?1) AS bucket, COUNT(*) AS count
FROM (
  SELECT campaign_id, MIN(created_at) AS first
  FROM %table%
  WHERE campaign_id IN (SELECT value FROM json_each(?2)) AND created_at >= ?3 AND created_at <= ?4
  GROUP BY subscriber_id, campaign_id
)
GROUP BY campaign_id, bucket;
-- name: list-counts
WITH counts AS (
  SELECT campaign_id, substr(created_at, 1, ?1) AS bucket, COUNT(*) AS count
  FROM %table%
  WHERE campaign_id IN (
      SELECT campaign_id FROM campaign_lists WHERE list_id IN (SELECT value FROM json_each(?2))
    ) AND created_at >= ?3 AND created_at <= ?4
  GROUP BY campaign_id, bucket
)
SELECT cl.list_id, c.bucket, SUM(c.count) AS count
FROM counts c JOIN campaign_lists cl ON cl.campaign_id = c.campaign_id
WHERE cl.list_id IN (SELECT value FROM json_each(?2))
GROUP BY cl.list_id, c.bucket;
-- name: list-unique-counts
WITH counts AS (
  SELECT campaign_id, substr(first, 1, ?1) AS bucket, COUNT(*) AS count
  FROM (
    SELECT campaign_id, MIN(created_at) AS first
    FROM %table%
    WHERE campaign_id IN (
        SELECT campaign_id FROM campaign_lists WHERE list_id IN (SELECT value FROM json_each(?2))
      ) AND created_at >= ?3 AND created_at <= ?4
    GROUP BY subscriber_id, campaign_id
  )
  GROUP BY campaign_id, bucket
)
SELECT cl.list_id, c.bucket, SUM(c.count) AS count
FROM counts c JOIN campaign_lists cl ON cl.campaign_id = c.campaign_id
WHERE cl.list_id IN (SELECT value FROM json_each(?2))
GROUP BY cl.list_id, c.bucket;
