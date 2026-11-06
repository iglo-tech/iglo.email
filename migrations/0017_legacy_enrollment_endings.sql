-- B22 (D83): before B20 the scheduler stored the blocklisted and sequence_archived endings as
-- canceled. They are exited now, so status filters and counts must see the old rows too. A data
-- repair: updated_at and finished_at keep the moment of the original ending.
UPDATE enrollments SET status = 'exited'
  WHERE status = 'canceled' AND exit_reason IN ('blocklisted', 'sequence_archived');
