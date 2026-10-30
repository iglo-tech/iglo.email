-- Adapted from listmonk queries/bounces.sql query-bounces at 6fcd95f. The sort is one of the
-- fixed expressions in store.ts. A bounce of an unlinked send names the send's address.
SELECT COUNT(*) OVER () AS total,
    b.id, b.type, b.source, b.meta, b.created_at, b.subscriber_id, b.send_id, b.campaign_id,
    s.uuid AS subscriber_uuid,
    COALESCE(s.email, sends.to_email) AS email,
    s.status AS subscriber_status,
    c.name AS campaign_name
FROM bounces b
LEFT JOIN subscribers s ON s.id = b.subscriber_id
LEFT JOIN campaigns c ON c.id = b.campaign_id
LEFT JOIN sends ON sends.id = b.send_id
WHERE (?1 = 0 OR b.id = ?1)
    AND (?2 = 0 OR b.campaign_id = ?2)
    AND (?3 = 0 OR b.subscriber_id = ?3)
    AND (?4 = '' OR b.source = ?4)
    AND (?5 = '' OR b.type = ?5)
ORDER BY %order% LIMIT ?7 OFFSET ?6;
