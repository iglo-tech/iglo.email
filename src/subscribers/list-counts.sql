-- Adapted from listmonk schema.sql mat_list_subscriber_stats at 6fcd95f.
-- name: list-unconfirmed
-- D82: members of one list that never confirmed.
SELECT COUNT(*) AS n FROM subscriber_lists WHERE list_id = ? AND status = 'unconfirmed';
-- name: membership-counts
SELECT list_id, status, COUNT(*) AS count FROM subscriber_lists GROUP BY list_id, status;
