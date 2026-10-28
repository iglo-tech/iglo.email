-- Adapted from listmonk schema.sql mat_list_subscriber_stats at 6fcd95f.
-- name: membership-counts
SELECT list_id, status, COUNT(*) AS count FROM subscriber_lists GROUP BY list_id, status;
