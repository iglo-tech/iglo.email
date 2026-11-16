-- B85 (D100): a sequence step may declare event aggregates, which its template reads as
-- `aggregates`. Stored like `condition`: a JSON object, or NULL for a step without any.
ALTER TABLE sequence_steps ADD COLUMN aggregates TEXT CHECK (aggregates IS NULL OR (json_valid(aggregates) AND json_type(aggregates) = 'object'));
