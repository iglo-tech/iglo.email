-- B143b (14-projects section 7, D162): the capacity forecast counts a project's sends by their first
-- push, `coalesce(attempted_at, sent_at)` in `sends.starts`, for the started statuses. Indexed by
-- status and that expression, the count is three range searches of this index alone (a covering
-- index) instead of a scan of every started row. Owned by src/messaging.
CREATE INDEX idx_sends_started ON sends(status, coalesce(attempted_at, sent_at));
