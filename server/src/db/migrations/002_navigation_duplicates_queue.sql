-- Phase 2 additions: folder navigation, coordinate filtering, duplicate
-- confirmation and a durable processing-queue switch.

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO app_settings (key, value, updated_at)
VALUES ('queue.paused', 'false', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Folder navigation filters on a root-relative path prefix.
CREATE INDEX idx_media_relpath ON media(rel_path);

-- Coordinate filters use a bounding box over stored GPS values.
CREATE INDEX idx_metadata_gps ON media_metadata(gps_lat, gps_lon);
