-- B127 r2 (D135): an enrollment that a step condition ended keeps that condition's text, so the enrollment
-- page and the subscriber's tab can name it. The exit reason stays `condition`. The text is a snapshot
-- taken when the enrollment exits, so a later edit of the step does not change what ended it. Every other
-- exit leaves it NULL, and so does every enrollment before this migration.
ALTER TABLE enrollments ADD COLUMN exit_condition TEXT;
