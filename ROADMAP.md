# NiX 360 Media — Development Roadmap

**Status:** Implementation in progress; completed slices and verification are recorded in [changelog.md](changelog.md). LRF companion pairing and the tiled 360° viewer are implemented locally; browser/device acceptance remains pending.  
**Prepared:** 5 November 2026 (Asia/Manila).  
**Target:** A private, self-hosted photo and video library with immersive 360° viewing on a Synology DS920+.  
**Implementer:** DeepSeek or another developer, following the phase gates below.

## 1. Scope and planning status

Build a lightweight web application that indexes existing NAS media, preserves originals, and serves optimized derivatives to Windows, Android, iOS, and tablet browsers. Deliver a responsive gallery, albums, search, favorites, viewing history, interactive panoramas, 360° video, and an installable PWA with secure remote access.

This roadmap refines the supplied project brief. Its implementation companions are [prompt.md](prompt.md), which defines the development workflow, and [changelog.md](changelog.md), which records actual changes and verification. Remaining technical documentation is assigned to implementation phases rather than created as empty placeholders.

### What was inspected

- The supplied project brief and local project directory were inspected. The project directory was empty; no application, configuration, or applicable AGENTS.md was found.
- Official product documentation and upstream project pages were researched; relevant links appear beside decisions below.
- No NAS connection, DSM configuration, installed RAM, media samples, container runtime, GPU device, network route, or upload speed was inspected. These remain Phase 0 inputs, not verified capabilities.
- No application code, containers, packages, NAS settings, or original media were changed.

### Non-negotiable rules

1. Mount original media **read-only** in every application container that can access it. Never edit, move, rename, delete, or write metadata into originals.
2. Store all generated assets and temporary processing files outside original media roots.
3. Inspect the actual environment before selecting deployment settings or promising performance.
4. Do not deploy or change NAS/network settings as part of planning. Application implementation starts only after the owner authorizes it; this document is not deployment authorization.
5. Use a modular monolith with a persistent job queue. Do not add Redis, a message broker, Kubernetes, Elasticsearch, or a separate media server without measured need.
6. Require authorization for every private media resource, including thumbnails, panorama tiles, HLS playlists, segments, and originals.
7. Do not rely on playback-time transcoding. Requesting an unavailable rendition may enqueue work, but playback must use a ready rendition or show processing status.
8. Prefer open-source components and local processing. Do not introduce paid services or upload private media to third-party conversion tools without owner approval.
9. Record unsupported formats and failures visibly; never silently skip files or imply successful conversion.
10. Keep versions, migrations, architectural decisions, test results, and operational instructions reproducible.

### Release boundaries

**First usable release (MVP, through Phase 4):** authenticated LAN library; read-only imports; durable jobs; thumbnails and previews; albums, search, favorites, and history; tiled 360° photos; ordinary and verified equirectangular video with precomputed MP4 quality options.

**Production v1 (through Phase 7):** measured HLS delivery where useful, secure remote access, PWA installation, mobile validation, optional offline thumbnails, operational monitoring, and demonstrated recovery.

**Deferred:** automatic camera ingestion, uploads, original-file management, public sharing links, facial recognition, AI tagging, maps requiring external services, VR headsets/WebXR, stereoscopic media, a custom DJI stitching engine, distributed processing, and complete offline video libraries. HEIC and selected offline media are conditional extensions after feasibility tests.

## 2. Recommended architecture and technology decisions

These are proposed defaults. Phase 0 validates them against actual files and devices and freezes exact supported versions. A failed experiment should change the affected decision, not trigger an unrelated rewrite.

| Area | Recommended starting point | Reason / decision gate |
|---|---|---|
| Frontend | TypeScript, Preact, Vite; static production bundle | Small client application with reusable gallery and viewer components; no server-side rendering requirement. Validate viewer integration and bundle size. |
| Backend | Supported Node.js LTS, TypeScript, Fastify | One language across UI and API; bounded subprocesses perform expensive media work. Pin compatible runtime and framework versions using the [Node.js lifecycle](https://nodejs.org/en/about/previous-releases) and [Fastify support policy](https://fastify.dev/docs/latest/Reference/LTS/). |
| Backend alternative | Supported .NET LTS with ASP.NET Core | Appropriate if the implementer has stronger .NET expertise. Choose once in Phase 0; do not run both backend stacks. |
| Database | SQLite on a local NAS volume, migrations, WAL, foreign keys | Suitable starting point for a small household library. Use short transactions, busy timeout, bounded queries, and a patched SQLite build. WAL requires same-host access and is unsuitable for an SMB/NFS database mount. See [SQLite WAL](https://sqlite.org/wal.html). |
| Database alternative | PostgreSQL | Reconsider only if measured write contention or multiple application hosts justify another service. Library size alone is not a migration trigger. |
| Background jobs | Jobs table in SQLite; worker process from the same codebase/image | Durable processing without another queue service; isolate media work from HTTP request handling. |
| Photo viewer | Pannellum, provisionally | Validate tiled viewing and mobile controls against Marzipano and Photo Sphere Viewer before locking selection. |
| Video viewer | Video.js plus a validated 360 rendering integration | Video.js playback controls alone do not render a spherical scene. Test the exact Video.js / videojs-vr combination; keep a renderer adapter so an alternative is possible. |
| Media tools | FFmpeg/ffprobe; ExifTool; sharp/libvips for ordinary previews | Test metadata fidelity, compiled codec support, memory use, and container availability. Select an offline panorama tile generator with the viewer. |
| Delivery | Same-origin authenticated API streaming initially | Stream bounded chunks with backpressure and HTTP Range support; do not buffer whole videos in application memory. |
| Proxy / HTTPS | Existing suitable DSM reverse proxy or one Nginx proxy | Reuse working infrastructure when possible. Do not create competing listeners or proxy chains by default. |
| Deployment | Docker Compose, Linux amd64 image built outside the NAS | Keep build tools and compilation out of the runtime; use bind mounts with explicit permissions. |
| PWA | Manifest, service worker, explicit per-user cache policy | Installation and offline behavior are enhancements over a fully usable browser application. |

Record the license and version of every direct dependency, container base, font, tile-generation tool, codec library, and significant bundled dependency in the Phase 0 inventory. Verify FFmpeg's actual build configuration rather than assigning one blanket license to all builds. Pin image digests/package lockfiles and retain notices. Do not select unmaintained packages simply because a tutorial uses them.

### Photo viewer assessment

| Candidate | Verified capabilities / license | Maintenance and implementation implications |
|---|---|---|
| Marzipano | Multiresolution cube scenes; Apache-2.0. See [repository](https://github.com/google/marzipano) and [documentation](https://www.marzipano.net/docs.html). | Upstream repository was archived on 20 April 2026. It remains a comparison candidate, but adopting it needs an explicit maintenance/fork decision. Do not make it the default solely because it appeared in the original brief. |
| Pannellum | Equirectangular, cubemap, and multiresolution input; MIT. See [repository](https://github.com/mpetroff/pannellum) and [multiresolution documentation](https://pannellum.org/documentation/examples/multiresolution/). | Preferred starting point. Verify current release activity, mobile behavior, orientation controls, and the generator's dependencies and memory use. Its provided multiresolution generation workflow must be evaluated, not assumed inexpensive. |
| Photo Sphere Viewer | Equirectangular/cubemap tiles and video adapters; MIT core; Three.js dependency. See [repository](https://github.com/mistic100/Photo-Sphere-Viewer) and [adapter overview](https://photo-sphere-viewer.js.org/guide/). | Alternative if integration or video consistency outweighs added dependencies. Test current releases and only ship required adapters/plugins. |

Use the same sample images and physical phones for comparison. Record initial bytes, startup time, peak browser memory where measurable, drag/pinch behavior, seam/pole quality, texture limits, gyroscope permission handling, and recovery after backgrounding. A published browser-support statement is not an acceptance test.

### Logical architecture

```text
Browser / installed PWA
        |
        | HTTPS, same origin, session cookie
        v
Reverse proxy (existing DSM service OR Nginx)
        |
        v
Application: authentication, library API, static UI, authorized media delivery
        |                                  |
        v                                  v
SQLite: catalog, users, jobs          Read-only original roots
        |
        v
Worker: scan / probe / preview / tile / encode
        |                     |
        | read only           | write
        v                     v
Original roots          Derivatives and temporary outputs
```

The application and worker share modules and database schema. They may be two Compose services using the same image so the worker can have separate CPU/memory limits. This is operational isolation within one application, not separate microservices. Both access SQLite on the same NAS host through a local bind mount.

Only the proxy is externally reachable. The database is a file, not a network service. Processing tools run without shell interpolation, with allowlisted arguments, bounded execution time, and access limited to approved mounts. Do not mount the Docker socket or use privileged containers.

## 3. Storage, catalog, and processing contracts

### Proposed NAS layout

Paths below are examples. Phase 0 records actual share paths, volume type, capacity, ownership, and UID/GID before use.

```text
/volume1/photo/                         -> /media/photos          read-only
/volume1/video/                         -> /media/videos          read-only
/volume1/nix360-imports/                -> /media/imports         read-only (optional exports)
/volume1/docker/nix360/
  config/                              -> /config                limited access
  data/library.sqlite                  -> /data/library.sqlite   app + worker
  derivatives/
    <media-id>/<source-version>/<recipe-version>/
      thumbnails/
      previews/
      tiles/
      video/
  temp/                                -> /work                  worker only
  logs/                                -> /logs                  bounded rotation
  backups/                             -> backup staging         separate backup process
```

Mount derivatives read-only in the web process and read/write in the worker. Keep staging and final derivative directories on the same filesystem if publishing via atomic rename. Neither originals nor the database belong inside the image or container writable layer. A backup copy on the same NAS is staging, not protection against NAS loss.

### Scanning and file identity

- Configure allowlisted roots administratively; clients never submit arbitrary filesystem paths. Exclude derivative directories, NAS-generated thumbnail folders, and hidden/system paths by policy.
- Use an initial full scan, scheduled reconciliation, and a manual rescan. Filesystem watchers may reduce delay but never replace reconciliation.
- Track files by root ID and normalized relative path. Handle Unicode, case behavior, and long paths explicitly. Reject traversal and links that escape the approved root; prefer refusing symlinks entirely initially.
- Detect likely changes using size and high-resolution modification time. These are hints, not proof of identity. Use queued content hashing for duplicate confirmation and configurable integrity checks.
- Wait for stable size/time observations before probing a newly copied file. Recheck before publishing a derivative; discard stale output if the source changed during processing.
- Store a source version and invalidate only derivatives for an obsolete version. Keep manual metadata overrides separate from extracted metadata.
- Mark missing files only after a complete, successful scan of a healthy, accessible root. A disconnected mount, permission error, or interrupted scan must not mark the entire library deleted.
- External deletion creates a catalog tombstone; never delete anything from original roots. Apply a configurable grace period before cleaning orphaned generated assets.
- Duplicate hashes create duplicate groups, not automatic deletion. A probable rename may be reconciled only after unambiguous identity checks; preserve user favorites and albums when identity is confirmed.
- Unsupported or corrupt files remain discoverable with a reason and retry/conversion guidance. Distinguish absent metadata from extraction failure.

### Minimum database model

| Entity | Key fields / relationships |
|---|---|
| `users` | ID, normalized unique login, password hash, role, enabled state, timestamps |
| `sessions` | Hashed opaque token, user ID, issued/expiry/last-seen timestamps, revocation state |
| `library_roots` | ID, internal mount mapping, display name, scan policy, health, latest successful scan |
| `media` | ID, root ID, relative path, source version, size, mtime, optional content hash, type, availability/processing states |
| `media_metadata` | Media ID, dimensions, duration, codecs, frame rate, bit depth, color properties, projection, stereo layout, metadata provenance/confidence, EXIF/GPS, capture time and offset certainty |
| `media_overrides` | Media ID, explicitly edited display date/projection/orientation/title; never writes the source |
| `media_relations` | Source media ID, related imported export ID, relation type and conversion provenance |
| `derivatives` | Media ID, source version, recipe/profile version, kind, relative storage key, bytes, dimensions, checksum, readiness state |
| `jobs` | Kind, media/version/profile, unique deduplication key, status, priority, attempts, next run, lease owner/expiry, heartbeat, progress, sanitized error |
| `scan_runs` | Root ID, generation, start/end, status, counts, error; successful generations drive missing-file reconciliation |
| `albums`, `album_items` | Owner, title, visibility; unique album/media membership and ordering |
| `favorites` | Unique user/media pair |
| `viewing_history` | Unique user/media pair, last viewed, playback position, optional viewer orientation |
| `audit_events` | Actor, action, target ID, timestamp; avoid secrets and private metadata in logs |
| `schema_migrations` | Version and applied timestamp |

Initial permission model: one household library shared by all enabled users. Admin manages users, roots, jobs, and settings; viewer browses media and manages personal albums/favorites/history. Albums are organizational, not a way to hide media in a shared library. Add library-level membership before offering separate private libraries.

Use foreign keys and indexes for root/path uniqueness, type/capture-date/ID pagination, availability, content hashes, job status/next-run, and per-user history. Add SQLite FTS only for defined text fields such as filenames, titles, and album names; GPS support initially means stored coordinates and coordinate filters, not automatic geocoding. Preserve unknown capture timezone rather than inventing UTC; document fallback from capture date to file date. Use parameterized SQL and migrations with a tested backup/rollback strategy.

### Durable processing

1. Scanner discovers a stable source; a short transaction creates catalog records and deduplicated probe jobs.
2. Metadata determines whether ordinary previewing, panorama tiling, conversion, or unsupported-format handling is appropriate.
3. Jobs advance through `queued -> running -> succeeded`, with retry-wait, failed, paused, and cancelled paths. Dependencies must be complete before a dependent job is claimed.
4. Claim jobs atomically with expiring leases and heartbeats. Recover expired leases after a crash. Assume at-least-once execution and make publication idempotent.
5. Write to a job-specific temporary directory, validate outputs, atomically publish them, then mark readiness in the database. Reconcile a crash between filesystem publication and database commit.
6. Use bounded retries with backoff; separate permanent unsupported-input errors from transient storage/process failures. Expose manual retry and cancellation to admins.
7. Resume the queue after restart. An interrupted FFmpeg encode normally restarts that rendition; do not promise frame-level continuation unless separately implemented and tested.
8. Start with one heavy processing job globally, a bounded metadata queue, off-peak scheduling, and explicit disk-space/memory checks. Pause new work before exhausting storage.
9. Version recipes so a profile change schedules only required regeneration. Cleanup touches only known generated paths and never assets used by running jobs or active playback within the configured grace period.

## 4. DJI and media compatibility strategy

DJI documents **OSV for panoramic video and MP4 (HEVC) for flat video**, so the original brief's MP4/MOV assumption is incomplete. Its specifications list panoramic recording up to 7680 × 3840 and JPEG panoramas up to 15520 × 7760. These are camera specifications, not confirmation of browser-ready files. See [DJI format FAQ](https://www.dji.com/360/faq) and [DJI specifications](https://www.dji.com/360/specs).

| Input | Initial handling | Required proof |
|---|---|---|
| Ordinary JPEG/PNG | Index, extract metadata, generate oriented previews | EXIF orientation, transparency, and browser display verified |
| Equirectangular JPEG panorama | Classify using metadata plus explicit review when needed; tile for large images | Horizon, seam, poles, orientation, and original aspect ratio preserved |
| HEIC | Conditional decoder support; generate browser-friendly previews | Actual container decoder/build and orientation/color tested; graceful unsupported state otherwise |
| Ordinary MP4/MOV | Probe actual streams; direct-play only when supported, otherwise prepare compatible derivative | Container extension alone never establishes codec or browser support |
| Raw DJI OSV | Catalog and preserve; show `conversion_required` unless validated tooling exists | Actual sample probe and visual inspection; do not relabel the extension or assume FFmpeg performs stitching |
| DJI LRF companion | Planned: associate a verified companion with its OSV, show one recording, and prefer compatible LRF preview playback without encoding | Standalone local probe/delivery evidence exists; pairing, preview selection, projection, and device behavior require the [LRF preview acceptance checks](docs/lrf-preview.md) |
| DJI-exported spherical video | Accept a verified stitched equirectangular export as a derived import | Export retains the full sphere rather than a reframed flat view; metadata, color, stabilization, and audio checked |
| Unknown dual-fisheye / proprietary projection | Preserve and flag conversion required | A renderer accepting a projection does not establish correct camera calibration or stitching |

Proposed fallback: use DJI Studio or another validated desktop workflow to export a full spherical master on a capable computer, place that export in a separate NAS import folder, and link it to its original. Validate the installed tool/version and exact export procedure in Phase 0. Do not claim a supported unattended DJI conversion API without evidence.

Collect representative owner-provided samples: flat photo, large spherical photo, ordinary H.264 and HEVC videos, raw OSV, a full-sphere DJI export, and a high-bit-depth/D-Log M example if used. Record file hashes, ffprobe output, EXIF/XMP/spherical metadata, projection, frame rate, color space, bit depth, audio, and conversion history. A 2:1 aspect ratio is a hint, not sufficient proof of spherical projection. Store manual classification overrides in the database.

Do not confuse D-Log M with display-ready SDR or automatically treat every 10-bit file as HDR. Establish the appropriate tested color conversion; retain the original and conversion provenance.

### LRF-based preview requirement

Implement [DJI LRF companion previews](docs/lrf-preview.md) across Phase 2 (association and canonical catalog identity) and Phase 4 (preview-source selection and playback). Keep both source files read-only, expose one recording, and prefer a compatible LRF for preview/poster generation. A ready LRF preview does not clear the OSV's conversion-required state. Missing or incompatible LRFs use a ready compatible fallback or a visible unavailable state; no playback-time encoding. Validate LRF projection independently before enabling spherical viewing. The linked specification defines pairing evidence, ambiguity handling, lifecycle, authorization, schema needs, and acceptance tests. These requirements are pending, not covered by existing standalone LRF tests.

## 5. Renditions, delivery, and bandwidth

### Initial video profiles to benchmark

Use H.264 with a tested browser-compatible profile/level, 8-bit 4:2:0, and AAC audio for baseline derivatives. Preserve audio sync and source geometry; normalize frame rate only according to a documented profile. Start with up to 30 fps derivatives, avoid upscaling, and keep original frame-rate files intact.

The following are **starting encoder budgets, not quality guarantees**. Bitrates are video-only; add audio, protocol overhead, and burst headroom.

| Profile | Flat video bounds | Full-sphere 2:1 dimensions | Starting video bitrate | Purpose |
|---|---|---|---|---|
| Mobile low | Fit within 1280 × 720 | 1440 × 720 | 1.5–3 Mbps | Low-data fallback; visibly soft for 360° |
| Standard | Fit within 1920 × 1080 | 2160 × 1080 | 3–6 Mbps | Default candidate after device/network tests |
| Higher-quality 360, optional | Not required initially | 3840 × 1920 | 8–16 Mbps | Better viewport detail when decoding and bandwidth permit |
| Original | Unchanged | Unchanged | Source-dependent | Explicit user choice only when container, codec, projection, device, and bandwidth permit |

For portrait/other flat footage, preserve aspect ratio within the chosen bounds. For spherical media, never squeeze a 2:1 image into 16:9 to match a conventional resolution label. Display dimensions and estimated data use in quality selection. A sphere's full-frame resolution is spread over all viewing directions; a “1080p sphere” is not equivalent to a 1080p flat viewport.

Generate a baseline rendition first. Produce additional profiles according to configured demand, available space, and schedule; do not eagerly generate every possible output for the whole archive.

### Delivery sequence

- First implement progressive MP4 with fast-start layout in generated files, authenticated `GET`/`HEAD`, correct MIME types, backpressure, and `206`/`416` behavior for byte ranges. Seeking must not require downloading the entire file.
- Add precomputed HLS VOD when multiple qualities and variable bandwidth justify it. Test short segments, aligned keyframes across variants, accurate playlist bandwidth/codec declarations, audio continuity, seeking, and rendition switching. See [FFmpeg HLS documentation](https://ffmpeg.org/ffmpeg-formats.html#hls-2).
- Keep spherical projection and orientation as explicit application metadata; do not depend on transcoding or HLS packaging preserving every camera metadata field.
- Test native HLS on Safari and the selected JavaScript playback path on other browsers. Native playback can limit programmatic quality control; if manual quality selection needs separate URLs, preserve playback position and document the behavior.
- The [videojs-vr project](https://github.com/videojs/videojs-vr) describes mobile and desktop support, but compatibility with the selected Video.js version, HLS path, WebGL textures, and physical devices remains a release gate.
- Expose only ready derivatives. Unsupported originals can still be offered as authorized downloads with clear labeling; they must not be presented as guaranteed playable.
- If application streaming becomes a measured bottleneck, use Nginx internal redirects or an authorization subrequest for each resource. Generated directories must never become a public static alias.

For rough planning, `concurrent streams <= floor(0.65 × measured upload Mbps / selected total stream Mbps)`. This reserves headroom but does not account for every burst or competing NAS task. Example: 20 Mbps upload with 5 Mbps total streams suggests two simultaneous streams, subject to testing. At 5 Mbps, ten minutes consumes approximately 375 MB before transport overhead. Measure sustained upload from outside the home; a LAN speed test does not establish internet capacity.

## 6. Security, remote access, and PWA behavior

### Authentication and authorization

- Start with locally managed accounts and no public registration. Bootstrap the first admin through a documented one-time process; no shipped default credentials.
- Use a maintained password-hashing implementation, preferably Argon2id with settings benchmarked on the NAS, unique salts, and login rate limits. Keep password hashing off the request event loop where necessary.
- Use opaque server-side sessions in `HttpOnly`, `Secure`, appropriately `SameSite` cookies; rotate at login, expire idle/absolute sessions, and revoke on logout, account disable, or password reset. Do not store bearer credentials in localStorage.
- Protect state-changing requests against CSRF; use same-origin deployment and restrictive CORS. Trust forwarded headers only from configured proxies.
- Centralize object-level authorization and apply it to every representation of a media item. Test both unauthenticated access and access using a disabled/expired session.
- Resolve opaque IDs to internal paths; validate canonical root containment and derivative identifiers. Reject traversal, symlink escapes, arbitrary URLs, and shell commands supplied through APIs.
- Treat metadata as untrusted text. Escape filenames/titles, apply a practical Content Security Policy, and cap input dimensions, probe time, process output, and request sizes.
- Use least-privilege UIDs/GIDs, read-only roots, limited container capabilities, restricted outbound access where practical, secret files outside source control, and redacted bounded logs.
- By default, private media responses require revalidation and never enter shared/public caches. Session and sensitive API responses use `no-store`. Any offline exception must be intentional and per-user.

### Remote access options

| Option | Fit | Conditions |
|---|---|---|
| Tailscale private access | Recommended initial remote pilot for the owner's devices | Requires client enrollment and appropriate access rules; measure direct versus relayed throughput and configure valid HTTPS for browser features. Follow the [Synology integration documentation](https://tailscale.com/docs/integrations/synology). |
| Direct HTTPS reverse proxy | Browser access without a VPN client | Requires a suitable public route, DNS/certificate handling, firewall rules, and application security. Check CGNAT/double NAT first. Publish only the application virtual host. |
| Cloudflare Tunnel public hostname | Not the default for private high-bandwidth video | Cloudflare explicitly applies video/large-file restrictions to public-hostname Tunnel traffic on listed plans. Evaluate the exact applicable product before use; do not promise free unlimited streaming. See [Cloudflare video delivery policy](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/). |
| Other private VPN / approved relay | Fallback for routing constraints | Assess capacity, costs, dependencies, and authentication before selecting it. |

Do not expose DSM administration, SSH, SMB, container management, or database files publicly. Review default proxy hosts and shared listeners so an application port forward cannot accidentally publish DSM. A VPN/tunnel does not replace application-level media authorization.

### Mobile and offline rules

- Preserve the NiX visual direction: light background, self-hosted Open Sans with a system fallback, compact responsive gallery, restrained shadows, and minimal animation. Subtle neumorphism must not reduce contrast or hide control boundaries.
- Navigation: Home, Photos, Videos, 360° Media, Albums, Favorites, Recently Viewed, Settings. Collapse appropriately on phones; restrict administrative settings by role.
- Use cursor pagination, reserved thumbnail dimensions, viewport-based lazy loading, bounded prefetch, and lazy-loaded viewer bundles. Video never autoplays with sound as a requirement.
- Provide drag, pinch, keyboard controls, touch targets, labels, focus handling, and reduced-motion support. Request gyroscope permission only after a user gesture; preserve drag controls when sensors are denied or unavailable.
- Test HTTPS, inline video, orientation changes, screen lock/resume, native fullscreen, and browser/PWA differences on real iOS and Android devices. Offer an immersive in-page mode when native fullscreen would bypass spherical rendering or is unavailable.
- Cache versioned public app assets first. Offline personal thumbnails are opt-in, quota-bounded, and namespaced per account; purge them on logout/account switch and provide a clear-cache control.
- Previously downloaded private data cannot be remotely revoked while a device is offline. Show this limitation before enabling offline media and disable the feature on shared devices by default.
- Selected offline photos may follow thumbnail support after storage tests. Offline video/HLS is deferred. Browser eviction and service-worker lifecycle make offline storage best-effort; see [PWA caching guidance](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Caching).

## 7. Phased implementation plan

Complexity: **S** = contained work; **M** = several modules; **L** = significant integration; **XL** = high uncertainty or device/media work. These are relative estimates, not delivery promises. Re-estimate after Phase 0 using measured work and available developer time.

Dependency chain: `P0 -> P1 -> P2 -> P3 -> P4 -> P5 -> P6 -> P7`. P3/P4 share infrastructure; P4 video experiments should happen in P0 so a failed codec/rendering assumption does not surface late. P1 establishes HTTPS readiness and authorization; P6 validates external connectivity rather than introducing security for the first time.

### Phase 0 — Discovery and technical validation

**Objective:** Replace high-risk assumptions with evidence before application implementation.  
**Dependencies:** Owner-authorized read-only NAS access or supplied inspection output, representative media, physical test devices.  
**Complexity:** L; highest uncertainty.

**Tasks and technical work**

- [ ] Record DSM and Docker/Container Manager versions, installed RAM, CPU, filesystem, free space, current workloads, shares/permissions, and existing proxy configuration. Published DS920+ specifications identify a J4125 CPU and 4 GB base memory; verify the actual unit rather than assuming that configuration ([Synology specifications](https://global.download.synology.com/download/Document/Hardware/ProductSpec/DiskStation/20-year/DS920%2B/enu/Product_Spec_DS920%2B_enu.pdf)). *(Hardware partly verified 2026-11-05 from DSM: DS920+, J4125 4-core 2 GHz, **12 GB** RAM, thermal normal, cool fan mode — see `docs/discovery.md`. DSM/Container Manager versions, volumes, free space, shares, permissions and proxy configuration are still unknown.)*
- [ ] Inspect whether `/dev/dri` exists and whether a candidate FFmpeg build can actually use the exposed hardware. No driver installation or privileged-container workaround during discovery.
- [ ] Inventory library count/size, largest files/images, formats, metadata patterns, required users, and available derivative storage.
- [ ] Inspect/probe samples without modification. Benchmark authorized experiments on sample copies in a development environment; NAS benchmarks requiring a new runtime wait for explicit deployment authorization.
- [ ] Compare panorama viewers and video renderer integrations with the same samples and physical devices. Record versions, licensing, browser results, and maintenance signals.
- [ ] Measure preview/tile generation, representative encode speed, peak RAM, output size, and NAS impact where testing is authorized. If 8K processing is impractical, select external preparation with NAS playback storage.
- [ ] Record sustained upload, typical remote download, RTT, CGNAT/public reachability, and likely simultaneous viewers.
- [ ] Decide runtime, viewer, tile generator, database, baseline profiles, DJI import route, initial concurrency, and remote-access pilot. Record unresolved items honestly.

**Deliverables:** `docs/discovery.md`, `docs/compatibility-matrix.md`, benchmark results with environment details, dependency/license inventory, and initial architecture decision records under `docs/adr/`. If access is absent, produce an inspection checklist and mark NAS claims blocked/unverified.

**Acceptance and tests:** At least one verified photo panorama and one verified spherical video work in the selected prototype path on Windows, Android, and iOS; original hashes remain unchanged; one baseline processing profile has measured resource/throughput data; raw DJI handling has a documented supported or conversion-required outcome. Missing hardware/sample evidence cannot be marked passed. Local development may continue only with the affected assumptions explicitly recorded; NAS readiness remains open.

**Risks / mitigation:** Missing samples or NAS access -> isolate unresolved gates; archived viewer -> choose supported alternative; 8K decode/encode failure -> desktop preparation and lower-resolution derivatives.

### Phase 1 — Foundation, authentication, and persistent jobs

**Objective:** Establish a secure, reproducible application skeleton and safe storage access.  
**Dependencies:** Phase 0 architecture decisions; implementation authorization. NAS deployment additionally requires verified paths/settings and owner authorization.  
**Complexity:** L.

**Tasks and technical work**

- [x] Create frontend/backend/shared-module structure, lockfiles, lint/type checks, environment validation, and a minimal automated build. *(Verified locally: npm workspaces for `server` and `web`, committed `package-lock.json`, `npm run typecheck`, `npm run lint` (ESLint 10 flat config with typescript-eslint over server sources, tests and the Preact client) and `npm run build`; environment validation lives in `server/src/config.ts`. API and worker share `server/src` modules rather than a separate shared package.)*
- [x] Add versioned database migrations, account bootstrap, login/logout/session revocation, role enforcement, and CSRF protection. *(Verified locally: migrations `001`–`004` apply once; the bootstrap script requires an explicit password and refuses to overwrite; `auth.test.ts` covers login/logout, revocation on logout, disable and password change, viewer/admin separation and origin-based CSRF rejection.)*
- [x] Create Compose configuration for app and bounded worker, with sample environment file, health checks, restart policy, log rotation, and read-only original mounts. *(Verified by configuration inspection, not a container run: media mounts are `:ro`, only loopback is published, `/api/health` is health-checked, json-file logs rotate at 10 MB × 3, the worker is limited to 1 CPU / 1 GiB, and `.env.example` carries placeholders only.)*
- [x] Implement job states, transactional claims, leases, retries, idempotency keys, cancellation, and recovery before real media processing. *(Verified locally: `jobs.test.ts` covers duplicate claims, lease expiry and recovery, deduplication, backoff, retry, cancellation and paused queues.)*
- [x] Add authorized media-ID resolution and baseline HTTP delivery contracts. Keep host paths internal. *(Verified locally: every representation goes through the same session guard; ids resolve to validated paths with realpath containment; `range.test.ts` covers `200`, `206`, `HEAD` and `416`. Absolute host paths are never returned.)*
- [x] Build the NiX responsive shell and clear empty/error/loading states; establish local HTTPS testing and proxy settings. *(Verified locally: the shell and loading/empty/error/unsupported states are implemented; `proxy.test.ts` proves forwarded headers are ignored unless trusted, that trusted HTTPS yields `Secure` session cookies and scheme-correct CSRF, and a real self-signed TLS terminator serves health, HSTS, login and an authenticated session. The Nginx topology and DSM steps are documented in `docs/https-proxy.md`. No DSM proxy, certificate renewal or external route has been tested.)*

**Deliverables:** Reproducible local build and Compose files; new `README.md`, `ARCHITECTURE.md`, and `DATABASE.md` containing actual decisions and setup instructions; updated `changelog.md` and `prompt.md` reflecting the implemented foundation.

**Acceptance and tests:** A clean development setup builds from documented commands; schema persists across restarts; original mounts reject writes; no default credentials; viewer cannot call admin operations; sessions revoke correctly; duplicate/recovered jobs do not publish twice; unsafe paths fail. Test proxy headers, cookie settings, and process restart behavior.

**Risks / mitigation:** SQLite lock contention -> short transactions and bounded workers; permission mismatch -> documented UID/GID checks; secrets in logs -> redaction tests.

### Phase 2 — Media library and derivative pipeline

**Objective:** Deliver a usable catalog while processing safely in the background.  
**Dependencies:** Phase 1 storage, auth, schema, and queue.  
**Complexity:** L.

**Tasks and technical work**

- [x] Implement full/scheduled/manual scans, source versioning, stable-file detection, root health, tombstones, and duplicate grouping. *(Verified locally 2026-11-06 at test level: `scan.test.ts`, `schedule.test.ts` and `library-navigation.test.ts` cover add/change/missing, an unavailable root without tombstoning, stabilization, Unicode paths, symlink refusal, scheduled reconciliation, queued duplicate suppression and hash-confirmed duplicate groups that never delete files.)*
- [x] Extract EXIF/XMP/GPS and video metadata; preserve provenance and timezone uncertainty; classify flat/panorama/unknown media. *(Verified locally 2026-11-06: sharp/ffprobe/optional ExifTool probing records source, uncertainty, GPS and explicit projection provenance; `scan.test.ts`, `library-navigation.test.ts` (GPS bounding box), `companions.test.ts` and `rendition.test.ts` exercise classification, rotation, color and metadata persistence. Real DJI/HDR samples remain external.)*
- [x] Generate thumbnails and optimized flat previews with bounded resource use and explicit failure states. *(Verified locally: recipes `thumb-v1`, sharp decode failures become explicit `unsupported`/`failed` states.)*
- [x] Build cursor-paginated gallery, folder navigation, media detail, search, date/type/projection filters, GPS-coordinate filters, albums, favorites, and recent history. *(Verified locally: browse/search/date/type/projection in the UI; coordinates filter through a validated bounding box on `/api/library` and have no map UI yet.)*
- [x] Add admin queue visibility, progress, pause/resume, retry, cancel, disk usage, and unsupported-file summaries. *(Verified locally: durable pause/resume stored in `app_settings`, per-job progress, retry/cancel, free space and duplicate-group panels.)*

**Deliverables:** Working library vertical slice, seeded fixtures, scan/metadata documentation, updated schema and changelog.

**LRF companion extension — pending:**

- [x] Implement the [LRF association and identity contract](docs/lrf-preview.md): validated same-root/directory/stem pairing, versioned provenance, canonical OSV identity, one-item listing/counts/pagination, orphan handling, and preservation of albums/favorites/history. *(Verified locally 2026-11-05: `003_lrf_companions`, automatic pairing from either scan order, canonical SQL filtering, transactional user-state merge, persisted rejection. Browser/device playback and backup-restore evidence remain pending.)*
- [x] Verify scan-order independence, ambiguous/mismatched pairs, manual rejection persistence, source changes, missing roots/files, and restart behavior. *(Verified locally 2026-11-05: late arrival and either scan order converge; a changed companion suspends the preview until re-probing and is re-confirmed or left ambiguous; a deleted companion keeps the recording with `missing` status; an unavailable root tombstones nothing; cross-root, case-distinct, duplicate-candidate and conflicting-capture cases never auto-pair; reopening the database preserves the relationship and canonical resolution.)*
- [x] Verify relationship and user-state records after a database restore. *(Verified locally 2026-11-05 with `npm run backup` and an isolated restore: confirmed companion relation, canonical deep links, preview selection, favorites, album membership, playback position, overrides, durable settings and derivative keys all survived; foreign keys were intact and no migration was needed. NAS restore and derivative rebuilding remain Phase 7.)*

**Acceptance and tests:** New/changed media appears after successful scans; external deletion is represented without modifying source files; an unavailable root does not tombstone its contents; duplicate and corrupt files are visible; album/favorite/history records survive rescans and restarts. Test interrupted copies, Unicode names, symlink escapes, stale derivatives, disk-full errors, and interrupted worker recovery. Measure browsing on a 10,000-record fixture or the full smaller real library.

**Risks / mitigation:** Scan I/O disrupts NAS -> throttle and schedule; large decode memory -> pixel limits and isolated worker; HEIC codec absent -> visible unsupported state.

### Phase 3 — Immersive photo viewing

**Objective:** Deliver smooth spherical viewing without loading giant source images into mobile memory.  
**Dependencies:** Phase 2 metadata, previews, job pipeline, and protected delivery.  
**Complexity:** L.

**Tasks and technical work**

- [x] Integrate the selected viewer through a small adapter for load, dispose, orientation, zoom, and errors. *(Verified locally: Pannellum 2.5.7 lazy chunk, `destroy()` on unmount, reset view and motion-control button; no browser run.)*
- [x] Generate versioned multiresolution tiles offline; serve preview first and only required visible tiles afterward. *(Verified locally: `pano-sq-v1`, 126 tiles from a 4096 × 2048 fixture and from the supplied 15520 × 7760 DJI panorama (3.53 MB, 9.2 s), preview-first Pannellum config, authorized per-tile route. Browser tile loading is not yet exercised.)*
- [x] Add drag, pinch, keyboard controls, immersive/fullscreen modes, optional gyroscope, orientation reset, and next/previous navigation. *(Implemented 2026-11-06 and verified in headless Chrome: arrow/`+`/`-`/`[`/`]`/`F` keyboard map, zoom buttons, two-finger pinch (hfov 100° → 82°), native fullscreen with the toolbar still reachable plus a fixed-overlay fallback, reset, and previous/next chevrons with disabled end states. Mouse drag was verified in desktop Chrome 2026-11-05. Gyroscope/motion and physical iOS/Android touch remain unverified.)*
- [x] Store the panorama start view (yaw/pitch/roll) as a catalog orientation override and report tile readiness, failure and ineligibility separately in the viewer. *(Verified locally 2026-11-05: administrator-only audited `PATCH /api/media/:id/overrides`, saved direction returned by the Pannellum manifest, `tiles` status on media detail. Browser rendering of the saved view is not yet checked.)*
- [x] Add a projection override workflow in catalog metadata, including re-classification and tile re-queue. *(Verified locally 2026-11-05: administrator-only audited override; effective classification drives gallery filters, detail and tile delivery; a confirmed sphere queues tiles, a withdrawn one cancels queued work and returns `tiles_not_eligible`. Browser rendering of the switch is not yet checked.)*
- [x] Release textures/listeners when leaving a viewer and handle WebGL context loss or unsupported devices gracefully. *(Implemented and verified locally 2026-11-06 at lint/typecheck/build level only: a missing WebGL context, a render error and a lost context each produce an explained notice with *Try interactive view again* and *Show flat preview*; a browser-restored context rebuilds the viewer; listeners are aborted and `destroy()` runs on every rebuild and unmount. Forcing context loss in a browser, visual review and device behaviour are not yet exercised.)*

**Deliverables:** Protected tiled panorama viewer, tile recipe and schema, physical-device comparison results. *(Tile recipe and protected viewer are implemented and were exercised in desktop Chrome: tiles loaded, drag rotated the view, reset restored it, and the horizon and seams looked correct. Input modes (keyboard, pinch, immersive, previous/next) and the failure notices were exercised in headless Chrome on 2026-11-06. Physical-device comparison is still required.)*

**Acceptance and tests:** Largest representative panorama displays without downloading the full original; seams and poles are visually correct; drag/pinch work on physical iOS and Android; denied sensor permission preserves manual controls; repeated open/close cycles do not accumulate unbounded resources. Missing tiles, expired sessions, rotation, and background/resume have usable outcomes.

**Risks / mitigation:** Device texture/memory limits -> lower initial resolution and tiles; generator too expensive -> desktop generation or a bounded replacement; viewer regressions -> pinned versions and adapter boundary.

### Phase 4 — Video playback and DJI import workflow

**Objective:** Deliver ordinary and spherical playback using verified inputs and ready renditions.  
**Dependencies:** Phase 2 queue/delivery, Phase 0 codec and DJI decisions, Phase 3 viewer UX conventions.  
**Complexity:** XL.

**Tasks and technical work**

- [x] Generate baseline MP4 derivatives; offer original playback only when compatibility checks permit. *(Verified locally at file/API level: libx264 High@4.0 rendition with `+faststart`, ffprobe-checked and Range-served; browser playback and real-device seeking are not yet tested.)*
- [x] Integrate play/pause, seek, timeline, volume/mute where supported, quality choice, progress persistence, and spherical navigation. *(Verified 2026-11-06 in headless Chrome against a generated 1024 × 512 equirectangular clip: 15/15 checks covering the yaw/pitch mapping by sampled pixels, arrow/wheel/pinch/drag navigation, play/pause, seek, mute control, immersive fullscreen with reachable controls, playhead reporting and context-loss retry. Quality choice and position-preserving switching are implemented and API-tested; a real DJI export, device playback and quality switching with the spherical stage in a browser remain unverified.)*
- [ ] Preserve playback position when switching rendition; handle missing audio, variable frame rate, portrait rotation, and long files. *(The viewer saves and reapplies the playhead across a rendition switch. Display rotation from the container matrix, CFR normalization with a 30 fps ceiling, and audio-less sources are implemented and file/API-tested; long files and browser/device playback remain unverified.)*
- [x] Implement explicit `conversion_required`, `processing`, `ready`, and `failed` experiences for DJI/proprietary inputs. *(Verified at API/test level 2026-11-05: a permanent probe failure is recorded instead of leaving the item pending; raw OSV is conversion-required with DJI export guidance; the viewer renders the server's state and explanation. Browser and device display are not verified.)*
- [ ] Document and verify full-sphere desktop export/import, linking exports to raw originals with provenance. *(Linking implemented and API-tested 2026-11-06: **Admin → Spherical exports** links a present, equirectangular export to a raw OSV, records both source versions, the actor and a policy version in `media_relations`, offers the export's file or ready renditions as a `Spherical export` option while the original stays conversion-required, and suspends the link when either file changes. A real DJI Studio export, the desktop import run and device playback of an export remain unverified.)*
- [x] Keep color conversion and projection handling explicit; do not silently turn panoramic inputs into flat exports. *(Projection implemented and browser-verified 2026-11-06: each playback option reports its effective `projection`/`spherical` state, the viewer labels an equirectangular video, and a rendition must decode to its planned 2:1 sphere or the job fails. HDR/wide-gamut handling implemented and verified at file/API/test level 2026-11-06: PQ/HLG/BT.2020 is detected from declared transfer/primaries (never bit depth alone), excluded from direct play, tone-mapped into a BT.709 H.264 rendition whose color tags are verified, and labeled in the viewer. The fixture is a generated HLG/BT.2020 clip; a real DJI D-Log M/HDR file and device colour rendering remain unverified.)*

**Deliverables:** LAN MVP, codec/projection compatibility matrix, DJI workflow guide, playback measurements and known limitations.

**LRF companion extension — pending:**

- [x] Prefer an eligible LRF as the canonical recording's preview source and poster input; keep raw original conversion status separate, expose explicit quality choices, and use ready fallbacks without synchronous encoding. *(Verified locally at API/test level: a confirmed LRF is the first playback option and the poster source, its conversion state stays separate, and a changed or missing companion falls back without encoding. Browser and device playback remain unverified.)*
- [ ] Pass the [LRF delivery, authorization, projection, and device acceptance checks](docs/lrf-preview.md), including Range/HEAD, unmodified sources, independent projection classification, and playback-position handling.

**Acceptance and tests:** A representative spherical export plays and seeks on Windows, Android, and iOS; chosen rendition preserves geometry, color, and audio sync; playback progress resumes; Range tests cover valid, suffix, and invalid requests; every derivative/original requires authorization. A raw OSV without a proven decoder/stitching route shows conversion guidance. No user playback request launches synchronous transcoding.

**Risks / mitigation:** HEVC/8K unsupported -> prepared H.264 derivatives; plugin incompatibility -> validated alternate renderer; native fullscreen loses the sphere -> in-page immersive mode.

### Phase 5 — HLS, capacity, and performance tuning

**Objective:** Meet measured playback and gallery targets within NAS and network limits.  
**Dependencies:** Phase 4 playback baseline and measurements.  
**Complexity:** L.

**Tasks and technical work**

- [ ] Add precomputed multi-rendition HLS for approved profiles where benchmark results justify it; retain MP4 fallback. *(Deliberately deferred 2026-11-06: no NAS/network benchmark has met the roadmap's measurement gate; progressive authenticated MP4 remains the verified fallback.)*
- [ ] Implement adaptive selection where supported and explicit manual/data-saving settings.
- [ ] Tune worker concurrency, scheduling, disk reserve, output retention, thumbnail sizes, indexing queries, and viewer prefetch.
- [ ] Add streaming offload only if profiling identifies application streaming as a bottleneck.
- [ ] Measure latency, rebuffering, bytes transferred, resource use, job throughput, and active playback under simultaneous processing.

**Deliverables:** Documented profiles and capacity limits, benchmark report, storage estimate, and admin resource controls.

**Acceptance and tests:** HLS playlists/segments are individually protected; variant switching and seeking retain audio/video continuity; slow/variable network trials select a sustainable rendition or show a clear limitation; heavy work stays within configured limits and pauses at the disk reserve. Derivative regeneration and cache invalidation remain correct after profile changes.

**Risks / mitigation:** Storage multiplication -> generate limited profiles and retain policy; encoder overload -> off-peak/single-job processing; insufficient upload -> lower profile and honest concurrency limits.

### Phase 6 — Remote access and PWA

**Objective:** Make the validated application securely usable away from home and installable on phones.  
**Dependencies:** Phases 1–5 security/delivery and an approved remote route.  
**Complexity:** L.

**Tasks and technical work**

- [ ] Configure the selected authorized HTTPS remote route, certificate renewal, application-only proxy routing, and network restrictions.
- [ ] Verify direct/relayed throughput, session behavior, long playback, Range/HLS traffic, and timeout behavior over a real external connection.
- [x] Add manifest/icons, installation guidance for supported platforms, offline shell, update handling, and explicit offline-thumbnail controls. *(Implemented and verified locally 2026-11-06: `manifest.webmanifest`, PNG/maskable/apple icons, a versioned service worker that precaches the hashed shell and serves it offline, a user-controlled update prompt, platform install guidance, and a Settings opt-in. Headless Chrome: 11/11 checks, 0 manifest errors, 0 installability errors, controlled worker, offline reload rendered the offline notice. Physical installation remains open.)*
- [x] Implement per-user cache separation, quota limits, expiry, logout/account-switch cleanup, and offline messaging. *(Verified locally 2026-11-06: thumbnail-only caching under `nix360-offline-<user>`, 500-item / 100 MB / 30-day pruning, network-only cache names for other API responses, account switch purges other accounts, offline banner/session notice. Chrome check: 1 cached thumbnail, only thumbnail URLs, `200` from cache while offline, zero private caches after sign-out. Browser eviction and physical-device behavior remain best-effort/external.)*
- [ ] Validate mobile touch controls, permissions, rotation, safe areas, background/resume, and browser versus installed-PWA behavior.

**Deliverables:** Remote-access runbook, PWA build, real-device/network test matrix, cache/privacy documentation.

**Acceptance and tests:** Owner can authenticate and play media from outside the LAN; DSM/SSH/SMB remain unreachable through the public application route; unauthorized direct media URLs fail; installation works where supported; logout removes application-managed private caches. Test offline access, quota exhaustion, browser eviction, failed upgrades, expired sessions, and denied sensors. Complete at least a 30-minute remote playback trial on a sustainable profile.

**Risks / mitigation:** CGNAT -> approved private route; certificate failure -> documented renewal/recovery; OS background restrictions -> best-effort offline behavior and visible status.

### Phase 7 — Production readiness and recovery

**Objective:** Deliver a maintainable deployment with demonstrated security, backup, and rollback behavior.  
**Dependencies:** All earlier release criteria and documented exceptions.  
**Complexity:** M–L.

**Tasks and technical work**

- [x] Review object authorization, path handling, session security, exposed ports, dependency advisories, container privileges, and secrets management. *(Verified locally 2026-11-06: upgraded `sharp` 0.35.5 and `@fastify/static` 10.1.10, `npm audit --omit=dev` reports 0 vulnerabilities; existing auth/object/CSRF/Range tests pass; containers run uid/gid 1000, read-only root, `cap_drop: ALL`, `no-new-privileges`, loopback-only port, bounded logs and CPU/memory limits; `.env`/`data`/media/`.verify` are outside the image build context. NAS/remote checks remain external.)*
- [ ] Perform load and restart tests with playback, scanning, and one heavy job together; document supported concurrent users.
- [ ] Back up SQLite consistently using its backup mechanism or a coordinated stopped application, plus configuration, secrets, and non-reproducible metadata. Do not copy only an active WAL-mode `.sqlite` file. *(`npm run backup` now writes and verifies a consistent online snapshot locally; scheduling, off-device storage and configuration/secrets coverage remain open.)*
- [ ] Define separate original-media protection, derivative backup/regeneration policy, off-device backup storage, retention, and restore credentials.
- [ ] Restore into an isolated location, verify catalog/user data and media mappings, rebuild selected derivatives, and measure actual recovery time. *(Verified locally 2026-11-06: a live 270,336-byte backup (18 tables, schema 6) restored into an isolated Compose stack with the same media id, then the worker reconciled 3 missing derivative files and regenerated a 21,436-byte thumbnail without a rescan. Recovery-time measurement and a NAS restore remain open.)*
- [x] Document migrations, upgrades, database restore, image rollback, failure diagnosis, job recovery, and safe derivative cleanup. *(Completed 2026-11-06 in `docs/operations.md`; DSM installation/proxy/backup/rollback steps are in `docs/synology-deployment.md`.)*
- [ ] Complete installation and operational documentation; obtain owner authorization before production deployment if not already granted.

**Deliverables:** Versioned release, operational runbook, security/performance reports, backup/restore evidence, final documentation set.

**Acceptance and tests:** Deployment is reproducible from documentation; original test-file hashes remain unchanged; failed jobs and resource limits are visible; restore works independently of the original container; image rollback includes a compatible database restore path. Proposed initial catalog/config backup objective: at most 24 hours of lost changes. Recovery duration and original-media backup objectives must be measured/agreed before declaring production ready; do not invent an RTO.

**Risks / mitigation:** Untested backup -> mandatory restore exercise; irreversible migration -> pre-migration backup and compatibility notes; NAS failure -> off-device recovery assets and originals backup policy.

## 8. Performance budgets and measurement method

All numbers below are **provisional acceptance budgets** for Phase 0 calibration, not measured DS920+ results. Record approved changes with evidence rather than quietly marking failures passed.

Use a 10,000-item catalog fixture (or the full library if smaller), representative large panoramas/videos, and recorded browser/device versions. Measure cold and warm cache separately with prepared derivatives, one viewer, then two viewers, and finally one heavy background job. Record p50/p95 over at least 20 applicable startup trials; use sustained playback sessions for rebuffering and thermal/resource observations.

| Metric | LAN / healthy Wi-Fi | Remote Wi-Fi test: 20 Mbps effective, 50 ms RTT | Mobile test: 5 Mbps effective, 100 ms RTT |
|---|---|---|---|
| First useful gallery viewport | p95 ≤ 2 s | p95 ≤ 3 s | p95 ≤ 5 s |
| Warm gallery metadata API, server time | p95 ≤ 300 ms | Same server budget | Same server budget |
| First moving frame, ready compatible video | p95 ≤ 3 s | p95 ≤ 5 s | p95 ≤ 8 s using low profile |
| 360° interaction | Aim 60 fps desktop; sustained ≥ 30 fps on supported phones | Same rendering target after required data arrives | Lower resolution/detail if necessary |
| Rebuffering on sustainable rendition | < 1% of playback time after startup | < 1% under stable tested capacity | Document variable-network result and adaptation behavior |
| Initial gallery transfer | Target ≤ 1.5 MB including app shell and first thumbnail viewport; no original downloads | Same | Same; data-saving mode reduces prefetch |

Network figures are controlled test conditions, not assumptions about the owner's internet. Effective throughput cannot exceed NAS upload or a relay's capacity. If the actual route cannot sustain a profile, lower quality and document the limit rather than reporting the target as met.

Initial resource hypothesis: app + worker idle memory below 500 MiB total; one heavy job; worker memory cap initially around 1 GiB only if measured available RAM permits; conservative CPU quota approximately 1–2 cores. Phase 0 must validate these values against DSM and other workloads. Large-image tiling and 8K decoding may exceed the budget; choose off-NAS preprocessing instead of increasing limits blindly. During processing, browsing must remain within agreed latency budgets without sustained swapping or OOM kills.

Initial concurrency goal: two viewers using prepared renditions if network capacity permits. Expand only after load tests. Report source-minute processing time, peak RSS, CPU use, derivative bytes, and job completion rate; do not require realtime 8K encoding.

Estimate generated video storage with `duration_seconds × total_bitrate_bits_per_second / 8`, summed across selected profiles, then add measured tile/thumbnail overhead and temporary working space. Set an operator-configured free-space floor before processing starts.

## 9. Milestones and outstanding decisions

| Milestone | Completion evidence |
|---|---|
| M0 — Architecture validated | Phase 0 reports; exact stack and supported input/device matrix; unresolved gates identified |
| M1 — Safe foundation | Phase 1 authentication, read-only mounts, persistent jobs, reproducible build |
| M2 — Library usable | Phase 2 scan/metadata/gallery workflow with restart and missing-mount tests |
| M3 — Immersive photos | Phase 3 tiled viewer validated on physical phones |
| M4 — LAN MVP | Phase 4 ordinary and spherical playback plus documented DJI conversion route |
| M5 — Capacity established | Phase 5 delivery profiles, storage estimates, measured user/resource limits |
| M6 — Remote/PWA beta | Phase 6 external playback, installation, cache isolation, application-only exposure |
| M7 — Production v1 | Phase 7 security review, restore drill, operational docs, authorized deployment |

Resolve through inspection where possible; ask the owner only for missing inputs or decisions that cannot be inferred:

- Actual DSM/runtime/RAM configuration and safely accessible NAS inspection path.
- Original media root paths, approximate library size, derivative capacity, and existing backup arrangement.
- Representative raw DJI files and exported full-sphere samples; camera/firmware/export-tool versions.
- Primary phones/tablets, supported OS/browser versions, and expected simultaneous users.
- Household shared library versus separately private libraries.
- Measured upload and preferred private-VPN versus browser-only public access.
- Whether desktop DJI export and off-NAS heavy processing are acceptable.
- Acceptable remote data consumption and desired retention for generated media/offline thumbnails.

## 10. DeepSeek implementation handoff

Use this roadmap as the execution contract after the owner authorizes development.

1. Read the repository and applicable instructions before editing. Start with Phase 0; never claim a NAS inspection or media/device test that did not occur.
2. Confirm which architecture decisions are validated and which depend on unavailable evidence. Complete independent local work while keeping affected acceptance gates open.
3. Implement one verifiable vertical slice at a time. Prefer a small functional path from scan to protected thumbnail/viewer over broad collections of placeholder pages.
4. For each slice, state the intended behavior, affected modules, dependencies, and acceptance checks. Use existing authorization; do not repeatedly ask permission for routine local implementation choices.
5. Keep media processing out of request handlers, maintain read-only original mounts, and apply authorization to every delivery path from its introduction.
6. Run focused automated tests for identity/scanning, job recovery, auth/path safety, migrations, and streaming semantics. Use physical-device and visual tests for panorama geometry, color, gestures, and mobile playback.
7. Update checkboxes only when evidence exists. Record commands, versions, fixture hashes, device results, known limitations, and remaining work in the relevant docs and changelog. Separate “implemented” from “verified on NAS.”
8. Do not change the selected stack, add services, or expand scope without a recorded technical reason. Continue safe local work when NAS access is absent; do not fabricate deployment success.
9. Obtain authorization for NAS/network changes and production deployment if the owner has not already provided it. Never treat this planning document as permission to modify original media.
10. End each implementation session with completed changes, validation results, unresolved blockers, and the next concrete task.

**Current handoff:** Implementation has started and is recorded in [changelog.md](changelog.md). The Phase 1 foundation (auth, sessions, durable jobs, authorized delivery, NiX shell), the Phase 2 slice (read-only scan, probe, thumbnails/previews/posters, folder navigation, search, date and coordinate filters, content-hash duplicate reporting, favorites, history, albums, admin queue controls), a baseline H.264 video rendition pipeline, a lazy Pannellum tiled 360° photo viewer (`pano-sq-v1`) with an administrator-saved start view, projection overrides with tile re-queue and explicit tile-state reporting, and local Phase 0 discovery are implemented and verified locally. Phase 3 device acceptance remains open: tile loading, mouse drag and reset are now verified in headless desktop Chrome against the supplied panorama, with its horizon and seams reviewed. WebGL context loss, a missing WebGL context and render errors now produce an explained notice with retry and an explicit flat-preview fallback, rebuilt through `AbortController`-scoped listeners on every unmount (lint/typecheck/build evidence only; a forced context-loss browser run is not done). Touch/pinch, gyroscope, fullscreen, repeated open/close and physical iOS/Android behaviour remain unverified. The supplied 15520 × 7760 JPEG has been through the tile job locally (126 tiles, 3.53 MB). LRF companion pairing is now also verified against cross-root/case-distinct stems, duplicate candidates, conflicting capture times, unreadable files, source changes, missing files, root outages and a database restart, and preview selection is version-gated so changed bytes are never served under stale evidence; NAS restore and physical-device checks remain open. ESLint 10 with typescript-eslint is configured for both workspaces and passes with no findings. `npm run backup` writes a verified online SQLite snapshot, and an isolated restore confirmed catalog, companion-relationship and user-state recovery locally; NAS restore, derivative rebuilding and off-device backup storage remain open. With local HTTPS/proxy verification complete, every Phase 1 task now has local evidence; DSM proxy configuration, certificate renewal and NAS deployment remain open. No NAS inspection, NAS deployment, remote-access change, physical-device test, benchmark or NAS restore drill has occurred; those gates remain open and are not authorized by these documents.
