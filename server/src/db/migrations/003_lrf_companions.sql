-- DJI LRF companion associations (contract: docs/lrf-preview.md).
-- Both camera files stay ordinary `media` rows; the relationship is metadata.

ALTER TABLE media_relations ADD COLUMN status TEXT NOT NULL DEFAULT 'proposed'
  CHECK (status IN ('proposed', 'confirmed', 'rejected'));
ALTER TABLE media_relations ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE media_relations ADD COLUMN source_version INTEGER;
ALTER TABLE media_relations ADD COLUMN related_version INTEGER;
ALTER TABLE media_relations ADD COLUMN updated_at TEXT;

-- One active preview companion per recording and one recording per companion.
-- Rejected rows are retained so an administrator's decision survives rescans.
CREATE UNIQUE INDEX idx_relations_one_companion
  ON media_relations(source_media_id, relation_type)
  WHERE relation_type = 'preview_companion' AND status != 'rejected';
CREATE UNIQUE INDEX idx_relations_one_canonical
  ON media_relations(related_media_id, relation_type)
  WHERE relation_type = 'preview_companion' AND status != 'rejected';
CREATE INDEX idx_relations_status ON media_relations(relation_type, status);

-- Visible evidence for pairs that are pending, ambiguous or explicitly rejected.
CREATE TABLE companion_checks (
  source_media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  related_media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ambiguous', 'rejected')),
  reason TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  source_version INTEGER,
  related_version INTEGER,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (source_media_id, related_media_id)
);
CREATE INDEX idx_companion_checks_status ON companion_checks(status, checked_at);

-- Which physical file a published poster was decoded from, so a changed
-- companion invalidates only the assets that depend on it.
ALTER TABLE derivatives ADD COLUMN source_media_id TEXT REFERENCES media(id) ON DELETE SET NULL;
