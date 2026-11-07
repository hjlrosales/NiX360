# Architecture

## Shape

A modular monolith with one codebase, one SQLite database and two processes from the same image.

```text
Browser (Preact SPA)
   |  same-origin HTTPS, session cookie
   v
Fastify API (server/src)  ──────────────►  SQLite (WAL, local file)
   |  reads derivatives (read-only intent)        ▲
   |  streams originals with Range                │
   v                                              │
/derivatives, /media (read-only roots)      Worker process
                                             (scan → probe → preview → tiles → encode)
```

- **API process**: authentication, authorization, catalog queries, streaming. It never decodes or encodes media inside a request.
- **Worker process**: durable queue consumer. Claims jobs atomically, heartbeats its lease, writes derivatives to a temp directory, publishes by rename, then commits.
- Both processes share `server/src` modules and the same schema. They are separate Compose services for CPU/memory isolation, not microservices.

## Server modules

| Module | Responsibility |
|---|---|
| `config.ts` | Environment validation, media-root parsing, path defaults |
| `db/sqlite.ts` | Connection pragmas (WAL, foreign keys, busy timeout), migrations, savepoint transactions |
| `db/migrations/*.sql` | Versioned schema |
| `auth/*` | Argon2id hashing, opaque session tokens (SHA-256 at rest), cookies, guards, audit events |
| `jobs/queue.ts` | Enqueue with active-job dedupe, atomic claim, leases, heartbeat, retry/backoff, cancel, recovery |
| `jobs/worker.ts` | Poll loop, lease renewal, graceful shutdown |
| `jobs/handlers.ts` | `scan_root`, `probe_media`, `thumbnail`, `hash_media`, `video_rendition`, `pair_companion`, `pano_tiles` handlers; backlog requeue |
| `media/scan.ts` | Read-only walk, stability window, upsert + source versioning, tombstone reconciliation |
| `media/probe.ts` | sharp/ffprobe/ExifTool metadata, projection classification, direct-play detection |
| `media/thumbnails.ts` | Thumbnail/preview/poster generation, atomic publish, stale-version cleanup, startup reconciliation |
| `media/rendition.ts` | Bounded H.264 rendition encoding, ffmpeg progress/timeout control, output verification, atomic publish |
| `media/tiles.ts` | Equirectangular cube projection, Pannellum multires pyramid, manifest publish, stale-version cleanup |
| `media/companions.ts` | OSV/LRF candidate evaluation, canonical resolution, user-state reconciliation, preview selection |
| `media/paths.ts` | Root containment, traversal and symlink-escape rejection |
| `media/send.ts`, `media/range.ts` | Bounded streaming, Range/HEAD/ETag/416 semantics |
| `library/routes.ts` | Cursor-paginated gallery, detail, favorites, history, albums |
| `admin/routes.ts` | Root scans, job visibility/retry/cancel, users, unsupported summary |
| `app.ts` | Fastify assembly, security headers, CSRF origin check, static SPA fallback |

## Request lifecycle

1. `onRequest`: resolve the session cookie to an enabled user (`request.authUser`), sliding the idle window at most once a minute.
2. `preHandler`: for unsafe methods, require an `Origin` matching the configured origin (or same-origin `Sec-Fetch-Site`).
3. Route guard: `requireUser` / `requireAdmin`; every media representation goes through the same guard.
4. Media ids resolve to `media` rows; paths are built server-side and validated with `resolveInside` + `realpath` containment, so a tampered catalog row or a symlink cannot escape a root.

## Job model

`queued → running → succeeded`, with `retry_wait` (transient, exponential backoff), `failed` (permanent or attempts exhausted), `paused`, `cancelled`.

Claims are one `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *`, so two workers cannot take the same job. Leases expire after 60 s and are renewed every 20 s; the worker aborts its job if it loses the lease. On start it requeues jobs with expired leases. Publication is idempotent: handlers check for an existing ready derivative and re-running a job overwrites the same versioned paths.

## Media pipeline

```text
scan_root (read-only walk)
   └─ probe_media (per new/changed source version)
        ├─ unsupported → media.processing_state = 'unsupported' + reason
        ├─ probe failure → 'failed' (retryable) or raw .osv → 'unsupported'
        ├─ thumbnail/poster (recipe thumb-v1)
        │    └─ media.processing_state = 'ready'
        └─ large equirectangular photo → pano_tiles (recipe pano-sq-v1)
             └─ optional enhancement; failure leaves the flat preview usable
```

- **Storage keys**: `<media-id>/v<source-version>/thumb-v1/{thumb,preview,poster}.webp` under `NIX_DERIVATIVES_DIR`. Files for superseded versions and their catalog rows are removed when a new version publishes.
- **Atomicity**: outputs are written under `NIX_TEMP_DIR/job-*`, validated, renamed into place, then recorded. A crash between rename and commit leaves a ready row whose file exists (reused) or a stale row that startup reconciliation marks `failed`.
- **Stability**: files modified within `NIX_STABILITY_WINDOW_SECONDS` are catalogued but not probed until a later scan, avoiding partially copied files.
- **Scan safety**: files are tombstoned only after a complete successful walk. A missing or unreadable root marks the root `unavailable` and fails the scan; it never deletes or tombstones media.

## Projection and playback rules

- Equirectangular photos require explicit projection metadata (XMP `GPano`/`GSpherical` or an override). A 2:1 ratio is stored as `unknown` with `projection_source = 'aspect_hint'`.
- Dual-fisheye video (two equal square video streams, e.g. DJI OSV) is `dual_fisheye` and requires an external stitched export; it is never relabelled or squeezed.
- Direct play requires an MP4/MOV container, H.264 8-bit video and AAC/MP3 or no audio — determined from the probe, not the file extension.
- No playback-time transcoding. Media detail lists every ready representation (`playbackOptions`), best first: compatible LRF preview, verified direct-play original, then precomputed renditions. Each option carries the effective `projection` and a derived `spherical` flag for the file it actually serves, so the client labels a flat presentation of a sphere instead of guessing. `GET /api/media/:id/rendition?profile=` serves one ready profile; the original is served only when direct play is proven; an incompatible original is queued for encoding, never played optimistically.
- Playback position is per user and per canonical recording. Opening an item updates recency without sending a position, detail returns the stored seconds, and the client resumes only 5 s or more into the clip and 10 s or more before the end. Routine saves are throttled to 5 s; pause, close and item changes flush the position, while completion resets it to 0.
- A DJI recording with a same-folder, same-stem LRF companion is presented as one item. Pairing requires agreeing durations and no conflicting capture timestamps; the raw OSV keeps its own conversion state and the LRF is offered only as a labeled preview. Confirmed companions are excluded from gallery, folder, search and album queries in SQL, not hidden in the client, and an LRF deep link resolves to the recording.
- HDR and wide-gamut sources are detected from ffprobe's `color_transfer` and `color_primaries` (PQ, HLG, or BT.2020 primaries; bit depth alone is never treated as HDR). They are stored in `media_metadata` and are never offered as direct-play, because browser tone-mapping is not dependable. The H.264 rendition runs a documented `zscale`/`tonemap=hable` chain from linear light into BT.709 for PQ/HLG, or a primaries/transfer conversion for wide-gamut SDR, and every rendition is tagged and verified as BT.709. The viewer labels the source and the conversion; the untouched original remains downloadable.
- Videos are encoded against versioned profiles in `media/rendition.ts`: `h264-1080-v1` (standard) is the fallback for everything the browser cannot decode, and `h264-720-v1` (data saver) is queued only when the source is larger than 1280×720 (1440×720 for a 2:1 sphere). Both use libx264 High profile level 4.0, CRF 21, 8-bit 4:2:0, AAC 160 kb/s stereo and `+faststart`, without upscaling. Display rotation is read from the container's display matrix (or `rotate` tag), stored as `rotation_degrees`, and applied to the catalog's display dimensions before bounds are chosen; encodes are normalized to a constant frame rate and capped at 30 fps. FFmpeg runs without a shell under a duration-derived timeout and is killed when the worker loses its lease. The output is verified with ffprobe and a `moov`-before-`mdat` check before publication; any deviation from the profile is a permanent failure, not a silent quality change. The decoded frame size must equal the planned target, and an equirectangular source must stay 2:1 within 2%, so a flattened sphere is refused rather than published.
- Large equirectangular photos get a cube pyramid (`pano-sq-v1`) only when projection metadata or an override says so and the source is at least 4096 px wide. The capped 8192 × 4096 source is projected by ffmpeg `v360` into Pannellum's face order and sliced into 512 px WebP tiles at levels 1–3 (2048 px faces, 126 tiles). The preview remains the first visible asset; tiles are fetched only by the lazy Pannellum adapter. Tile failures are isolated from the photo's processing state, and the manifest is published last so a partial pyramid is never advertised as ready.

## LRF companion preview flow

Automatic OSV/LRF pairing and canonical preview selection are implemented; follow [docs/lrf-preview.md](docs/lrf-preview.md) for the contract and remaining device checks.

The worker flow is stable source discovery -> independent probes -> validated companion association -> canonical recording presentation. Pairing runs from either file (same root, parent directory and exact stem; agreeing durations and no conflicting certain capture times), so scan order and late arrivals converge on one directional OSV -> LRF relation. Canonical gallery, folder, search and album queries exclude confirmed companions in SQL before pagination, and an LRF deep link resolves to its recording.

The API resolves the recording to a current compatible LRF first for preview playback, then a ready verified-export source, then a compatible canonical original, otherwise a visible fallback. Explicit user quality selection takes precedence over the default preview choice. Raw dual-fisheye OSV is never a direct-play fallback.

A raw camera original can be paired with a full-sphere export rendered elsewhere (DJI Studio on a desktop). The export is imported as an ordinary media row and linked to the raw original in `media/exports.ts`; the confirmed `stitched_export` relation stores both source versions, a policy version, the acting administrator and JSON provenance. `media_relations` keeps exactly one confirmed export per original. Media detail resolves the link only while both versions still match and the export is present and equirectangular, then offers its direct-play file or ready renditions as `Spherical export` options ahead of the unplayable raw file. The raw original keeps `originalConversionRequired: true` and its conversion guidance; changing either file suspends the export until an administrator re-confirms it. The original is never decoded, stitched or exported by the server.

The spherical video stage (`web/src/sphere-video.tsx`, its own lazy chunk, no new dependency) is a small WebGL renderer rather than a plugin: a hidden video element supplies frames, a full-screen quad turns each fragment into a ray through the current yaw/pitch/hfov basis, and the ray's longitude and latitude sample the equirectangular texture. Drag, two-finger pinch, wheel, arrow keys, `+`/`-`, space and `F` are owned by the stage; play/pause, seek, mute and immersive controls sit inside the wrapper, so native fullscreen keeps them reachable. The stage reports its playhead to the viewer for resume and quality switches, seeks a hair past zero after metadata so a paused sphere is not black, explains a lost context with retry and flat-video actions, and lets the viewer swap in a plain `<video>` when WebGL is unavailable.

Preview selection is version-gated: `companionPreview()` returns the LRF only while both recorded source versions equal the current catalog versions. Changing either file therefore suspends the preview until the durable `pair_companion` job re-confirms against fresh probe evidence; ambiguous new evidence (duration, capture time or duplicate candidates) leaves the recording without a preview rather than serving new bytes under old evidence. Availability is reported rather than inferred: a missing LRF shows status while the recording stays listed, and a missing OSV does not hide a usable LRF.

Posters are decoded from the companion with `source_media_id` provenance. Source availability, original conversion status, companion preview readiness, and each source's projection stay separate. Root outages never imply deleted relationships.

## Tiled panorama viewer

`GET /api/media/:id/tiles` returns the viewer configuration only for a ready `tiles` derivative of the current source version, and `GET /api/media/:id/tiles/:level/:file` authorizes each tile with the same session guard as every other representation. Both derive paths from the catalog rather than the request, validate levels/faces/indices, and fail closed with `404` for missing or malformed tiles. Orientation overrides from `media_overrides` are applied to the initial view and horizon roll.

The client keeps Pannellum in a separate lazy chunk: an ordinary photo never downloads it, and a ready panorama mounts one viewer. Each mount owns an `AbortController` for its `webglcontextlost`/`webglcontextrestored` listeners, and unmounting aborts them before `destroy()` and clearing the container, so no viewer instance, texture or timer survives a close. Failures are recoverable rather than silent: a missing WebGL context, an unreachable tile pyramid (a 20 s load watchdog, because Pannellum reports missing tiles as endless loading rather than `error`), a render error and a lost graphics context each render an explanation in place with *Try interactive view again* and *Show flat preview*. A lost context is not destroyed immediately, so the browser can restore it and rebuild the viewer; retry rebuilds into the same host.

Input is split at the same boundary: Pannellum keeps dragging and two-finger pinch (the stage declares `touch-action: none` so the browser cannot consume the gesture), while the adapter owns a window-level key map (arrows, `+`/`-`, `[`/`]`, `F`) with Pannellum's own keyboard control disabled, on-stage zoom and previous/next controls, and immersive mode. Immersive fullscreens the wrapper rather than the canvas so the toolbar and arrows stay reachable; browsers without element fullscreen use a fixed overlay, and both paths re-measure the renderer. The recipe is versioned independently of `thumb-v1`, so a future viewer or tile layout can regenerate only the panorama assets.

## Deferred by design

HLS packaging, offline caches, uploads, and public sharing are intentionally absent. The adapter boundaries (derivative kinds, recipe versions, projection metadata) exist so those features can be added without altering storage contracts.
