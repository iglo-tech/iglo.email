-- B19 (D81): a blocklisted subscriber holds only unsubscribed memberships. Older code paths (the
-- bounce blocklist action, PATCH without lists) left them confirmed, so un-blocklisting such a
-- subscriber would resume mail. This is a data repair: it deliberately does not stamp updated_at
-- and queues no webhooks, because no consent changed at this moment.
UPDATE subscriber_lists SET status = 'unsubscribed'
  WHERE status != 'unsubscribed'
    AND subscriber_id IN (SELECT id FROM subscribers WHERE status = 'blocklisted');
