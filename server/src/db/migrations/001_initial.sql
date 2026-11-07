-- NiX 360 Media — initial catalog schema (Phase 1/2 foundation).
-- Original media is never represented as writable: this schema only records
-- catalog state, user data, jobs and generated derivatives.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE library_roots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mount_path TEXT NOT NULL UNIQUE,
  health TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown', 'healthy', 'unavailable')),
  last_scan_id TEXT,
  last_success_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE scan_runs (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  files_seen INTEGER NOT NULL DEFAULT 0,
  files_added INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  files_missing INTEGER NOT NULL DEFAULT 0,
  files_skipped INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX idx_scan_runs_root ON scan_runs(root_id, generation);

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  extension TEXT NOT NULL,
  source_version INTEGER NOT NULL DEFAULT 1,
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('photo', 'video')),
  projection TEXT NOT NULL DEFAULT 'unknown'
    CHECK (projection IN ('flat', 'equirectangular', 'dual_fisheye', 'unknown')),
  availability TEXT NOT NULL DEFAULT 'present' CHECK (availability IN ('present', 'missing')),
  processing_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_state IN ('pending', 'processing', 'ready', 'unsupported', 'failed')),
  content_hash TEXT,
  capture_date TEXT,
  last_seen_scan INTEGER NOT NULL DEFAULT 0,
  missing_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (root_id, rel_path)
);
CREATE INDEX idx_media_list ON media(media_type, availability, capture_date, id);
CREATE INDEX idx_media_state ON media(processing_state);
CREATE INDEX idx_media_hash ON media(content_hash);

CREATE TABLE media_metadata (
  media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  video_codec TEXT,
  audio_codec TEXT,
  bit_depth INTEGER,
  frame_rate TEXT,
  color_space TEXT,
  metadata_source TEXT NOT NULL DEFAULT 'none',
  projection_source TEXT NOT NULL DEFAULT 'unknown'
    CHECK (projection_source IN ('metadata', 'aspect_hint', 'override', 'unknown')),
  direct_play INTEGER NOT NULL DEFAULT 0 CHECK (direct_play IN (0, 1)),
  gps_lat REAL,
  gps_lon REAL,
  capture_date_certain INTEGER NOT NULL DEFAULT 0 CHECK (capture_date_certain IN (0, 1)),
  unsupported_reason TEXT,
  probed_at TEXT
);

CREATE TABLE media_overrides (
  media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  title TEXT,
  display_date TEXT,
  projection TEXT CHECK (projection IN ('flat', 'equirectangular', 'dual_fisheye', 'unknown')),
  yaw_degrees REAL,
  pitch_degrees REAL,
  roll_degrees REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE media_relations (
  id TEXT PRIMARY KEY,
  source_media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  related_media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  provenance TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (source_media_id, related_media_id, relation_type)
);

CREATE TABLE derivatives (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  source_version INTEGER NOT NULL,
  recipe_version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('thumbnail', 'preview', 'poster', 'tiles', 'video')),
  storage_key TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  checksum TEXT,
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('pending', 'ready', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (media_id, source_version, recipe_version, kind)
);
CREATE INDEX idx_derivatives_media ON derivatives(media_id, source_version, kind);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  media_id TEXT REFERENCES media(id) ON DELETE CASCADE,
  source_version INTEGER,
  profile_version TEXT,
  dedupe_key TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'paused', 'cancelled', 'retry_wait')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 4,
  next_run_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  progress REAL NOT NULL DEFAULT 0,
  last_error TEXT,
  error_kind TEXT CHECK (error_kind IN ('transient', 'permanent')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_jobs_claim ON jobs(status, next_run_at, priority);
CREATE INDEX idx_jobs_dedupe ON jobs(dedupe_key, status);
CREATE INDEX idx_jobs_media ON jobs(media_id);

CREATE TABLE albums (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_albums_owner ON albums(owner_id);

CREATE TABLE album_items (
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  PRIMARY KEY (album_id, media_id)
);

CREATE TABLE favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, media_id)
);

CREATE TABLE viewing_history (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  last_viewed_at TEXT NOT NULL,
  position_seconds REAL,
  PRIMARY KEY (user_id, media_id)
);
CREATE INDEX idx_history_user ON viewing_history(user_id, last_viewed_at);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_id TEXT,
  created_at TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX idx_audit_created ON audit_events(created_at);
