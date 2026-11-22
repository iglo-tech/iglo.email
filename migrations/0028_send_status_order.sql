-- B127 r1 (D135): the send log filters by status and lists the newest first, and the dashboard reads
-- the newest sent row for its count. The old index serves the filter but not the order, so each such
-- page sorted every matching row (about half a second at a million sends). (status, id) serves both:
-- the newest matching row is the first entry read backwards. Nothing ordered sends by created_at within
-- a status, so the old (status, created_at) index is replaced rather than kept beside it, and each
-- status change still updates one status index, as before.
DROP INDEX idx_sends_outbox;
CREATE INDEX idx_sends_status_id ON sends(status, id);
