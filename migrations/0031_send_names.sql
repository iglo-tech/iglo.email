-- B117d (D139): the send log names a send's template and sequence as they were when the send was queued, so
-- a deleted template or sequence keeps its name. Before, the names were read live, and ON DELETE SET NULL
-- dropped them. The sends an older schema holds are named now, from their template and step as they stand at
-- the upgrade. The column is added with no default, which rewrites no row; the two UPDATEs write only the
-- rows that name a template or a step.
ALTER TABLE sends ADD COLUMN template_name TEXT;
ALTER TABLE sends ADD COLUMN sequence_name TEXT;
UPDATE sends SET template_name = (SELECT t.name FROM templates t WHERE t.id = sends.template_id)
  WHERE template_id IS NOT NULL;
UPDATE sends SET sequence_name = (
  SELECT q.name FROM sequence_steps st JOIN sequences q ON q.id = st.sequence_id WHERE st.id = sends.step_id
) WHERE step_id IS NOT NULL;
