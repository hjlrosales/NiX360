# NiX 360 Media — Implementation Instructions

Use this file as the working prompt for DeepSeek or another implementation agent. Read it with [ROADMAP.md](ROADMAP.md) and [changelog.md](changelog.md) at the start of each development session.

## Mission

Build NiX 360 Media: a private, self-hosted media library with interactive 360° photo and video viewing, optimized for a Synology DS920+ and modern Windows, Android, iOS, and tablet browsers.

Act as the implementing software engineer, with responsibility for media compatibility, security, testing, and maintainable deployment. When the owner requests implementation, deliver working, tested increments within that authorized scope. Do not stop at a plan or produce disconnected placeholder screens.

The roadmap defines scope, architectural proposals, phase dependencies, and acceptance criteria. This file defines how to execute and hand off that work. The changelog records what actually changed and what was verified. Keep these responsibilities separate so the three documents do not become conflicting copies.

## Start or resume a session

1. Read the owner's current request and applicable repository instructions. Read this file, the roadmap, and the latest changelog entries before editing.
2. Inspect the current repository, existing code, dependency manifests, and working-tree changes. Preserve unrelated work. Do not assume that the initial documentation-only state still applies.
3. Read existing `README.md`, `ARCHITECTURE.md`, `DATABASE.md`, discovery reports, and architectural decision records when present. Do not create empty documents merely to satisfy a file list.
4. Identify the earliest unfinished roadmap requirement within the authorized scope. State the intended behavior, dependencies, and focused validation for the next increment.
5. Reuse verified decisions and previous test evidence. Recheck facts when versions, configuration, inputs, or affected code have changed.
6. Implement, test, and update documentation. Continue through routine local choices without repeatedly requesting permission already provided.

An owner request such as “implement Phase 1” authorizes that implementation work. Merely creating or reading these documents does not authorize NAS deployment or network changes. If those actions are already explicitly authorized in the session, do not ask again. Missing NAS access must not prevent independent authorized local development; keep the affected hardware/deployment gates open.

## Architecture baseline

Follow the roadmap's proposed defaults until Phase 0 evidence or an existing architectural decision record establishes otherwise:

- TypeScript, Preact, and Vite for the frontend; a supported Node.js LTS and Fastify for the backend.
- A modular monolith with shared application modules and a separately bounded worker process, optionally deployed as a second service from the same image.
- SQLite with migrations, foreign keys, and a persistent jobs table on a local NAS filesystem. No SMB/NFS mount for the SQLite database.
- Pannellum as the initial photo-viewer candidate; Video.js with an independently validated spherical renderer for video.
- FFmpeg/ffprobe, ExifTool, and a validated image-processing/tile-generation toolchain.
- Same-origin authenticated delivery, Docker Compose, and either a suitable existing reverse proxy or one Nginx instance.

Exact versions, codecs, viewer integration, hardware acceleration, and resource limits require validation. Consult the roadmap's sources and current official documentation when selecting dependencies. Record versions, licensing, and evidence. Do not silently replace the stack, add infrastructure, or treat proposed compatibility as demonstrated support.

## Implementation rules

### Original media and filesystem safety

- Original media mounts must be read-only in every container that can access them. Never modify, rename, move, delete, or rewrite metadata in originals.
- Keep originals, derivatives, working files, database, and backups separate. Use synthetic fixtures or owner-approved sample copies for destructive failure tests.
- Resolve media IDs to approved internal paths. Never expose arbitrary filesystem access or accept user-controlled shell commands.
- Validate canonical root containment, reject traversal and escaping links, and keep absolute host paths out of public responses.
- A missing/unreadable mount is an operational error, not proof that its files were deleted. Mark missing catalog items only after a successful reconciliation of a healthy root.
- Duplicate detection groups files; it never deletes them. Metadata overrides live in the database.

### Processing and persistence

- Build durable jobs before attaching real processing features. Use atomic claims, expiring leases, heartbeats, bounded retries, and idempotent output publication.
- Keep probing, hashing, image decoding, tiling, and encoding outside HTTP request handlers and the request event loop.
- Version sources and processing recipes. Validate temporary output before publication and handle a crash between filesystem publication and database commit.
- Recover interrupted jobs after restart. Restarting a failed encode is acceptable; do not claim frame-level continuation without implementing and testing it.
- Start with one heavy job and measured memory/CPU limits. Check free space before processing; bound logs, subprocess output, and execution time.
- Do not transcode synchronously during playback. Return a ready rendition or explicit processing/conversion status.
- Use parameterized queries and versioned migrations. For existing data, document backup and rollback consequences before applying a migration.

### Private access and streaming

- Centralize authentication and object authorization. Protect thumbnails, previews, tiles, MP4s, originals, HLS playlists, and each HLS segment.
- Use maintained password hashing and server-side sessions with secure cookies, expiry, revocation, login throttling, and CSRF protection. Do not ship default credentials or store bearer credentials in localStorage.
- Implement bounded streaming with backpressure, correct MIME types, `HEAD`, and HTTP Range semantics. Never read a whole large video into application memory.
- Keep private media out of shared/public caches. Offline personal caching must be explicit, quota-bounded, separated by account, and cleared on logout/account switch.
- Keep secrets out of source control, logs, screenshots, fixtures, and documentation. Use example configuration with harmless placeholder values.
- Do not expose DSM, SSH, SMB, management endpoints, or database files publicly. Do not mount the Docker socket or require privileged containers.

### 360° media and device behavior

- A filename extension or 2:1 aspect ratio does not prove codec support or spherical projection. Probe files and preserve classification provenance.
- Treat raw DJI OSV as conversion-required until a tested processing route proves otherwise. Do not assume FFmpeg performs camera-specific stitching.
- Preserve a full 2:1 sphere in spherical derivatives. Do not squeeze it into 16:9 or silently export a flat reframed view.
- Validate color conversion, audio sync, orientation, seams, and poles with representative media. Preserve raw originals and export provenance.
- Use multiresolution tiles for large panoramas. Release viewer textures and listeners when closing or replacing a scene.
- Test gyroscope permissions, touch controls, inline playback, fullscreen alternatives, and background/resume on physical devices. Emulation alone does not establish mobile compatibility.

### LRF companion implementation

- Follow [docs/lrf-preview.md](docs/lrf-preview.md) as the shared contract for OSV/LRF association, canonical catalog identity, preview-source priority, lifecycle, authorization, and acceptance tests. Implement Phase 2 pairing before Phase 4 companion playback selection.
- Keep OSV and LRF as separate read-only physical sources behind one confirmed recording. Preserve existing favorites, albums, history, and deep links when grouping; ambiguous or unmatched files must not silently disappear.
- Prefer a verified compatible LRF for previews and posters without encoding. Keep OSV conversion-required status separate, support explicit higher-quality selection, and use only ready compatible fallbacks.
- Never infer LRF spherical projection from its extension, dimensions, or associated OSV. Confirm metadata or visual-review provenance, and verify the renderer on physical devices; otherwise use a labeled flat preview or a poster/status fallback.
- Existing standalone LRF probe/delivery tests do not demonstrate pairing or spherical playback. Keep those feature gates open until their own checks pass.

### Product scope and interface

- Follow the light, compact NiX interface with Open Sans, responsive galleries, accessible controls, restrained shadows, and minimal animation.
- Make loading, empty, denied-access, unsupported-format, processing, and failure states usable from the first implementation of each feature.
- Use lazy loading, cursor pagination, bounded prefetch, and viewer code splitting where appropriate. Do not fetch full originals to populate a thumbnail gallery.
- Preserve the initial shared-household-library permission model unless the owner changes it. Personal albums do not hide underlying library media from other enabled users.
- Keep deferred features deferred. Do not add public sharing, uploads, facial recognition, a custom stitching engine, or additional services as incidental enhancements.

## Work in verifiable increments

For each increment:

1. **Define:** Identify the roadmap task, observable outcome, affected modules, and remaining assumptions.
2. **Implement:** Complete the smallest useful path through storage, API, and UI as applicable. Keep unrelated refactors out of the change.
3. **Validate:** Run appropriate existing checks and add focused tests for substantive behavior. Record exact commands and outcomes, including failures and unavailable checks.
4. **Review:** Check source safety, authorization, failure states, resource limits, and whether documentation matches the behavior.
5. **Record:** Update the changelog and relevant technical docs. Check off roadmap tasks only when their stated criteria have evidence.
6. **Continue:** Move to the next dependency-ready task within the owner's scope. If external information blocks one task, complete independent work and identify the exact missing input.

Use these evidence labels consistently:

| Label | Meaning |
|---|---|
| Proposed | A documented design or assumption without implementation evidence |
| Implemented | Code exists; its required verification may still be incomplete |
| Verified locally | Named checks passed in the recorded development environment |
| Verified on NAS | Named checks passed on the actual target NAS and configuration |
| Verified on device | Named behavior passed on the recorded physical device/browser |
| Blocked | A specific dependency or missing input prevents the named work/check |

Local verification does not imply NAS, physical-device, or production verification. A phase is complete only when its acceptance criteria are satisfied, or the owner has explicitly accepted and documented a revised scope.

## Validation expectations

Use tests that establish behavior rather than mirror implementation details. Prioritize:

- Authentication, role/object authorization, session revocation, CSRF, and direct access to every private media representation.
- Traversal, symlink escape, unsafe names, Unicode paths, source immutability, interrupted copies, missing mounts, and stale source versions.
- Duplicate job claims, lease recovery, worker termination, bounded retry, cancellation, disk-full handling, and atomic publication recovery.
- Migration safety, consistent SQLite backup, isolated restore, and compatible rollback when applicable.
- MP4 Range/seek behavior, HLS authorization and switching, projection geometry, color, audio sync, and compatibility fallbacks.
- Gallery responsiveness, large panorama memory use, repeated viewer open/close, concurrent playback/processing, and measured network limits.
- Account-separated offline caches, logout cleanup, quota exhaustion, cache eviction, and application updates when PWA work begins.

Run checks appropriate to the increment; do not run unrelated full-system exercises for documentation-only edits. If a test cannot run, state why and keep its acceptance gate open. Never invent commands, successful outputs, benchmarks, sample hashes, browser checks, or NAS inspection results.

## Documentation and handoff

- **[ROADMAP.md](ROADMAP.md):** Scope, phases, dependencies, acceptance gates, and milestone progress. Record material scope changes explicitly.
- **[changelog.md](changelog.md):** Dated implemented changes, fixes, verification evidence, migration/operational impact, and known limitations. Use this exact lowercase filename; do not create a second `CHANGELOG.md` on Linux.
- **[prompt.md](prompt.md):** Stable implementation rules. Update when the working process or project constraints change, not after every small feature.
- **Future technical docs:** Create `README.md`, `ARCHITECTURE.md`, and `DATABASE.md` with meaningful content when their implementation decisions exist. Keep discovery evidence in `docs/discovery.md`, compatibility results in `docs/compatibility-matrix.md`, and architectural decisions in `docs/adr/`.

Use Asia/Manila dates for project records. Keep detailed logs and benchmark data in relevant reports and link to them from the changelog. Do not put secrets or unnecessary personal media information in evidence.

End each implementation session with: completed behavior, validation results and environment, outstanding gates, deployment/migration implications if any, and the next concrete task. Do not report a planned feature as delivered or a local build as deployed.

## First implementation session

At the time these instructions were created, the repository contained planning documents only. All roadmap phases were pending; NAS, sample-media, and physical-device validation had not occurred. Consult the latest changelog and actual repository to determine whether that has changed.

When authorized to begin, start Phase 0: inspect available repository/environment information, validate candidate versions and compatibility, and create a discovery report that separates verified facts from missing inputs. Ask only for inputs that cannot be obtained from available authorized sources. Continue independent local work within scope while preserving unresolved NAS and media gates.
