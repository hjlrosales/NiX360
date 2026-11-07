# Database

SQLite (WAL, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`) on a local filesystem. The database is a file next to the derivatives, never on SMB/NFS, because WAL requires same-host access.

Migrations live in `server/src/db/migrations/*.sql`, are applied in filename order, each inside a transaction, and are recorded in `schema_migrations`. `npm run migrate`, the API and the worker all apply pending migrations at start.

## Tables

| Table | Purpose / key invariants |
|---|---|
| `users` | Normalized unique login, Argon2id hash, `admin`/`viewer`, enabled flag |
| `sessions` | SHA-256 of the opaque token as primary key, absolute + idle expiry, revocation timestamp |
| `library_roots` | Configured root id, display name, internal mount path, health, last successful scan |
| `scan_runs` | One row per scan with monotonic `generation` and counts; failures never tombstone |
| `media` | `(root_id, rel_path)` unique, source version, size/mtime, type, projection, availability, processing state, `last_seen_scan` |
| `media_metadata` | Display dimensions, duration, codecs, bit depth, frame rate, color space with transfer and primaries (`color_transfer`/`color_primaries`, added in `006_color_metadata`), display rotation (`rotation_degrees`, added in `004_video_rotation`), metadata/projection provenance, direct-play flag, GPS, unsupported reason (also the explanation for a failed or conversion-required item) |
| `media_overrides` | Explicit user edits (title, display date, projection, orientation). Never written into originals |
| `media_relations` | Directional links; `preview_companion` (canonical OSV → LRF) and `stitched_export` (raw OSV → imported full-sphere export) with `status`, pairing/export `policy_version`, both validated source versions and JSON provenance. Partial unique indexes allow one active companion per recording, one recording per companion and one confirmed export per original (`005_stitched_exports`); rejected rows are kept, and a changed file version suspends export selection without deleting the decision |
| `derivatives` | `(media_id, source_version, recipe_version, kind)` unique; kinds `thumbnail`, `preview`, `poster`, `tiles`, `video`; storage key relative to the derivatives dir; ready state; `source_media_id` records which physical file the asset was decoded from. A `video` row is one published H.264 profile rendition (`h264-1080-v1` standard, `h264-720-v1` data saver). A `tiles` row (`pano-sq-v1`) points at the pyramid's `manifest.json`; the 126 WebP tiles live under `l1`–`l3` beside it. |
| `jobs` | Kind (`scan_root`, `probe_media`, `thumbnail`, `hash_media`, `video_rendition`, `pair_companion`, `pano_tiles`), dedupe key, status, attempts, next run, lease owner/expiry, heartbeat, progress, sanitized error |
| `albums`, `album_items` | Owner-scoped collections with ordering; organisational only |
| `favorites` | Unique `(user_id, media_id)` |
| `viewing_history` | Unique `(user_id, media_id)` with last viewed and playback position in whole seconds. Opening records recency without a position; detail returns the stored value; completion resets it to 0 |
| `audit_events` | Actor, action, target, timestamp; no secrets or media contents |
| `app_settings` | Small durable key/value store; currently holds `queue.paused` so an administrator's pause survives restarts |

## Invariants enforced in code

- Originals are read-only: no table or handler stores a writable original path, and nothing writes into a media root.
- A media row is tombstoned (`availability='missing'`) only after a successful, complete scan of a healthy root.
- `source_version` increments when size or mtime changes; old metadata is dropped, `content_hash` is cleared, and old derivative rows/files are removed after the new version publishes.
- `content_hash` is a SHA-256 of the original streamed by a `hash_media` job. It is evidence for duplicate groups only; nothing is deleted automatically, and identical files remain separate catalog rows.
- Job execution is at-least-once; handlers are idempotent so duplicate delivery does not publish twice.
- Enqueue deduplicates only against *active* jobs (`queued`, `running`, `retry_wait`, `paused`), so finished work can be requested again.
- Uploads, arbitrary paths and shell arguments never reach SQL; all statements are parameterized.

## Panorama tile storage

A ready `tiles` derivative uses recipe `pano-sq-v1`: `<media-id>/v<source-version>/pano-sq-v1/manifest.json` plus `l1/` (one 512 px tile per face), `l2/` (2 × 2) and `l3/` (4 × 4, 2048 px faces). Face letters follow Pannellum (`f`, `b`, `u`, `d`, `l`, `r`) and tile files are `<face><y>_<x>.webp`. The manifest is renamed into place after every tile, so a crash mid-publish cannot advertise a partial pyramid; the derivative row is committed afterwards. Generation requires an explicit equirectangular projection and a source width of at least 4096 px; a failed tile job leaves the photo's `processing_state` untouched. Regeneration on a source-version change removes the old version through the same stale-version cleanup as thumbnails.

## Indexes

Root/path uniqueness, media listing (`media_type, availability, capture_date, id`), processing state, content hash, derivative lookup, job claim (`status, next_run_at, priority`), session user/expiry, per-user history, relative-path prefix for folder navigation and GPS coordinates for bounding-box filtering.

## LRF companion data contract (implemented in `003_lrf_companions`)

Each OSV and LRF keeps its own `media` row, probe metadata and content hash; the LRF is never a `derivatives` entry. `media_relations` stores the directional `preview_companion` link (`source_media_id` = canonical OSV, `related_media_id` = LRF) with `status` (`proposed`/`confirmed`/`rejected`), `policy_version` (currently `1`), both validated source versions and a JSON `provenance` payload (decision maker, durations, tolerance, capture-time delta). Two partial unique indexes enforce one active companion per recording and one recording per companion; rejected rows remain so a manual decision survives rescans, and a version change lets the pair be re-evaluated.

`companion_checks` records visible evidence (`pending`, `ambiguous`, `rejected`) for pairs that are not auto-confirmed — for example a duration outside `max(250 ms, 1 % of the OSV duration)`. Auto-pairing requires the same root, parent directory and exact filename stem with opposite `.osv`/`.lrf` extensions, finite durations for both files, and no conflicting certain capture timestamps (2 s tolerance). Nothing is paired across directories or roots.

Canonical gallery, folder counts, search and album queries exclude confirmed companions inside SQL before pagination. Detail requests for an LRF resolve to the canonical recording and expose both physical sources, the labeled preview URL and the original's separate conversion state.

The LRF is preferred for poster extraction; each poster derivative stores `source_media_id` so a changed companion invalidates the poster without touching the OSV. Preview selection is version-gated: `companionPreview()` accepts a relationship only while its `source_version`/`related_version` equal both files' current `media.source_version`, so a changed, replaced or ambiguous source is not served under recorded evidence until `pair_companion` re-confirms it. Availability is reported separately — a missing companion keeps the recording and shows status, and a missing OSV does not hide a usable LRF. Favorites, album membership and viewing history are merged onto the canonical recording in the same transaction as confirmation (earliest favorite, existing album position, latest playback position). Unpairing restores two separate items and leaves the merged user state on the recording; that rule is intentional and tested.

Restart and database-restore exercises for relationship state remain part of the Phase 7 backup drill.

## Backup and restore

`npm run backup -- --out <file>` writes a consistent copy while the API and worker keep running. It uses SQLite's online backup API (so committed WAL pages are included), verifies page integrity and foreign keys on the temporary copy, then renames it into place. A failed verification removes the partial file, and an existing destination is never replaced without `--force`.

```bash
npm run backup -- --out /volume1/docker/nix360/backups/library-2026-11-05.sqlite
# Inside the container, where /data is the data volume:
docker compose exec app node server/src/scripts/backup.ts --out /data/backups/library.sqlite
```

Do not copy only the live `library.sqlite` file: with WAL enabled, recent commits live in `-wal`. Derivatives are regenerable from originals plus recipes; the catalog, users and overrides are not.

Restore procedure:

1. Stop the API and worker so no process holds the database.
2. Keep the previous catalog files rather than deleting them.
3. Place the verified backup at `NIX_DATA_DIR/library.sqlite` and remove stale `-wal`/`-shm` files beside it.
4. Start the application. Migrations apply only if the backup predates the code.
5. Check `/api/health`, sign in, and confirm gallery counts, companion relationships, favorites/albums/history and overrides.

Verified locally on 2026-11-05: an online snapshot restored into an isolated directory kept media rows, the confirmed LRF companion, canonical deep-link resolution, preview selection, favorites, album membership, playback position, projection override, durable queue settings and derivative keys, with foreign keys intact, no migrations to reapply and no writes made after the snapshot. A restore drill **on the NAS**, derivative rebuilding and recovery-time measurement remain open (Phase 7 gate).
