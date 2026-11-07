-- Full-sphere desktop exports linked to raw camera originals (DJI workflow).
-- Both files stay ordinary media rows; the relation records provenance and the
-- versions that were confirmed, so a later change suspends playback selection.

-- One confirmed export per raw original. Rejected or superseded rows may remain.
CREATE UNIQUE INDEX idx_relations_one_export
  ON media_relations(source_media_id)
  WHERE relation_type = 'stitched_export' AND status = 'confirmed';

CREATE INDEX idx_relations_export_related
  ON media_relations(related_media_id, relation_type)
  WHERE relation_type = 'stitched_export';
