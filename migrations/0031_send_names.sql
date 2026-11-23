-- B117d (D139): a send names its template and sequence as they were when it was queued, so a deleted template or
-- sequence keeps the name its sends carry. The columns are added with no default, which rewrites no row. A send
-- queued before this release keeps no stored name: the send log shows the live name until its template or
-- sequence is deleted, as before. No backfill: at a million 2 KB sends it took 136 s and a 4.1 GB WAL
-- (docs/perf/B117d-send-names.md).
ALTER TABLE sends ADD COLUMN template_name TEXT;
ALTER TABLE sends ADD COLUMN sequence_name TEXT;
