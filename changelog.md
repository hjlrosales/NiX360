# NiX 360 Media — Changelog

This file records actual project changes and their verification. Planned features and acceptance criteria belong in [ROADMAP.md](ROADMAP.md); implementation instructions belong in [prompt.md](prompt.md).

Dates use Asia/Manila time. No application release has been published.

## Unreleased

### 2026-11-06 — Optional environment-managed owner

**Roadmap:** Phase 1 account bootstrap and Phase 7 secrets/operations.
**Evidence level:** Implemented and **verified locally**, including password rotation and session-revocation tests. The local Compose deployment uses the feature; no NAS run occurred.

#### Added

- Optional `NIX_OWNER_LOGIN`, `NIX_OWNER_DISPLAY_NAME` and `NIX_OWNER_PASSWORD` settings create or synchronize one administrator before the API starts listening. With the password unset, existing database-managed behavior is unchanged.
- An unchanged password is verified without rehashing or revoking sessions. A changed password is Argon2id-hashed and revokes every existing session for that owner; a disabled or demoted configured owner is restored to an enabled administrator.
- Startup records password-free audit evidence and logs only the configured login and reconciliation result. The worker never performs account reconciliation.
- `.env.example`, the README, Synology deployment guide and operations runbook document setup, rotation, Compose recreation and the plaintext environment-secret tradeoff.

#### Verification

- `npm run typecheck`, `npm run lint` and `npm run build` — exit 0.
- `npm test` — 75 tests: 72 passed, 0 failed and 3 environment-dependent skips. New tests cover configuration validation, initial owner creation, unchanged-password session preservation, password rotation, session revocation, role/enabled restoration and exclusion of plaintext passwords from audit details.

#### Operational impact

- No migration or dependency change. Edit `NIX_OWNER_PASSWORD`, then run `docker compose up -d --force-recreate app`; `docker compose restart` alone does not reload `.env`.
- `.env` now contains an active local test owner and remains excluded by `.gitignore`. Production operators must restrict its permissions and encrypted backups because environment-managed mode stores the credential in plaintext configuration.

### 2026-11-06 — Owner-managed user accounts

**Roadmap:** Phase 1 authentication and household account administration.
**Evidence level:** Implemented and **verified locally** by frontend typecheck, lint and production build. The existing secured user API remains covered by the server authentication suite.

#### Added

- The Administration page now has a **Users** panel where an administrator can create viewer or administrator accounts with a username, display name and temporary password.
- Existing accounts can be enabled or disabled, promoted or demoted, and assigned a new password. Disabling an account or resetting its password revokes its existing sessions.
- The signed-in administrator cannot disable or demote their own account. Client-side validation mirrors the API’s username and 12-character password requirements, while the API remains authoritative.

#### Verification

- `npm run typecheck` — exit 0 for the server and web workspaces.
- `npm run lint` — exit 0.
- `npm run build` — exit 0: 22 modules; main 70.04 kB JS / 22.86 kB gzip; CSS 16.48 kB / 3.96 kB gzip.
- `npm test` — 73 tests: 70 passed, 0 failed, 3 skipped because Windows could not create symlinks and local OpenSSL was unavailable.

#### Operational impact

- No database migration, new dependency or configuration change. Rebuild the application image to publish the updated frontend.

### 2026-11-06 — PWA, deployment hardening and catalog-only recovery

**Roadmap:** Phase 6 (PWA/offline controls) and Phase 7 (security, backup/restore, operational documentation).
**Evidence level:** Implemented and **verified locally**, including a real image build, an isolated Compose stack, headless-Chrome PWA/cache checks, restart and an isolated restore. No NAS, remote-network, physical-device or real-DJI/HDR run.

#### Added

- **Installable PWA** — `web/public/manifest.webmanifest`, 192/512/maskable PNG icons, an Apple touch icon, and a versioned service worker. The worker precaches the hashed app shell discovered from `index.html`, serves it for offline navigation, caches runtime assets, and never caches API JSON, originals, previews, renditions or tiles.
- **Privacy-scoped offline thumbnails** — off by default in **Settings → Offline thumbnails**. Enabling it stores thumbnail responses only, in `nix360-offline-<user-id>`, bounded to 500 items / 100 MB / 30 days and pruned oldest-first. Other accounts' caches are removed on account activation; sign-out deletes all offline caches. The UI states the shared-device limitation and requests persistent storage best-effort.
- **Update and offline UX** — a controlled update prompt with `skipWaiting`/reload, an offline banner, and an offline session screen instead of a misleading login form. Install guidance covers Chromium install prompts and iOS Safari Add to Home Screen.
- **Disk-reserve enforcement** — `NIX_MIN_FREE_MB` (default 512) makes thumbnail, encode and tile jobs fail transiently below the floor rather than filling the data volume or publishing partial output.
- **Catalog-only recovery** — worker startup now reconciles missing derivative files, then queues a bounded regeneration set only for rows actually marked failed. This repairs a restored catalog whose derivative volume is empty without a rescan and without re-queueing unsupported/raw items.
- **Deployment hardening** — app and worker use read-only root filesystems, bounded `/tmp` tmpfs, `cap_drop: ALL`, `no-new-privileges`, loopback-only publication, and explicit CPU/memory limits. `.env`, `.verify`, data, media and SQLite files are excluded from the image build context.
- **Runbooks** — `docs/synology-deployment.md` (DSM/Container Manager, paths, PUID/PGID, proxy, certificates, bootstrap, backups, upgrade/rollback, acceptance checklist) and `docs/operations.md` (health, restarts, scans, disk reserve, backup/restore, upgrade, rollback, diagnosis, cleanup).
- **Dependencies** — `sharp` 0.35.5 and `@fastify/static` 10.1.10, including the corresponding `setHeaders`/sharp typing adaptations. No schema migration was added.

#### Verification

- `npm run lint` — exit 0. `npm run typecheck` — exit 0 (server + web). `npm run build` — exit 0: 22 modules, main 65.42 kB JS / 21.70 kB gzip, spherical stage 8.83 kB, panorama 62.04 kB, CSS 15.82 kB.
- `npm test` — **73 tests, 71 passed, 0 failed, 2 skipped** (the Windows symlink-creation cases). New suites: `pwa.test.ts` (manifest/icons/worker syntax boundary), `disk.test.ts` (reserve refusal), `recovery.test.ts` (missing derivative file reconciled and regenerated). A regression in the first recovery query re-queued canonical raw OSVs; it was fixed to require an actual failed derivative row, and the companion/recovery tests pass.
- `docker compose config -q` — exit 0. `docker build -t nix360-media:final .` — exit 0. The built runtime runs as uid/gid 1000; inspected containers show `readOnlyRootfs=true`, `CapDrop=[ALL]`, `no-new-privileges`, `/media` read-only, bounded JSON logs, app 1.5 CPU/768 MB and worker 1 CPU/1 GB.
- **Compose end-to-end smoke** (isolated stack, port 8790, generated admin): bootstrap 0, login 200, foreign-origin CSRF 403, scan 202, probe/pair/hash/thumbnail jobs succeeded, 15,520 × 7,760 metadata, thumbnail 200 `image/webp` with `no-store`, unauthenticated representations 401, Range 206 (100 bytes), HEAD 200, invalid Range 416, root healthy, 0 failed jobs, original SHA-256 unchanged. Restarting both services preserved health and the same media id, and the full smoke passed again.
- **PWA Chrome checks** — 11/11: manifest/installability errors 0, worker controlling the page, offline reload rendered the offline shell under `navigator.onLine=false`. Offline-cache check: one account-named cache, only thumbnail URLs, cached thumbnail returned `200` while offline, and zero `nix360-offline-*` caches after sign-out.
- **Backup/restore** — live backup `270,336` bytes, 18 tables, schema 6. Restored into an isolated Compose project: same media id, worker logged 3 missing derivative files and 1 regeneration set, thumbnail returned `200` with 21,436 bytes. No source file changed.
- `npm audit --omit=dev` — **0 vulnerabilities**. Full `npm audit` additionally reports **10 moderate dev-only `minimatch` advisories** through ESLint 10.14.0 / typescript-eslint; these packages are not in the production image, and the suggested "fix" downgrades ESLint across a breaking boundary, so it was not forced. Runtime exposure is zero.

#### Not run

NAS/Container Manager installation, DSM reverse proxy and certificate renewal, external-network throughput/session tests, 30-minute remote playback, physical iOS/Android install/touch/gyroscope/background behavior, real DJI OSV/LRF/export and HDR/D-Log M samples, browser playback of video/quality switching, large-library/concurrent-user load measurement, recovery-time measurement, off-device backup scheduling, and an image-rollback drill. HLS remains deferred by the roadmap measurement gate; progressive MP4 is the fallback.

#### Operational impact

- New `NIX_MIN_FREE_MB` setting (default 512; suggested production 2048).
- Existing `PUID:PGID` must own `/data`; read-only root means `/tmp` is provided as tmpfs.
- Dependency major upgrades require rebuilding the image; no migration is needed.
- Offline thumbnails are opt-in and cleared on sign-out; browsers may still evict them.

### 2026-11-06 — Explicit HDR/wide-gamut handling

**Roadmap:** Phase 4 (keep color conversion explicit; do not silently turn panoramic or HDR inputs into SDR exports).
**Evidence level:** Implemented and **verified at file, API and test level** with a generated HLG/BT.2020 clip. No real DJI D-Log M or other HDR source, visual colour review or device rendering was exercised.

#### Added

- **`006_color_metadata`** — `media_metadata` now stores `color_transfer` and `color_primaries` beside the existing color space, so HDR is identified from declared color, never from bit depth alone.
- **Classification and direct-play rules** — `hdrKind()` recognizes PQ (`smpte2084`), HLG (`arib-std-b67`) and BT.2020 wide gamut. Such sources are never advertised as direct-play; a 10-bit file with no color tags is not assumed to be HDR.
- **Tone-mapped SDR rendition** — PQ/HLG sources run through `zscale` linearization, `tonemap=hable`, and BT.709 output; wide-gamut SDR converts primaries/matrix without tone-mapping. Every H.264 rendition is now tagged BT.709 through x264's VUI, and publication fails if ffprobe does not report `color_transfer=bt709`/`color_primaries=bt709`.
- **Explicit presentation** — media detail returns the source's transfer, primaries and derived HDR kind; each playback option carries `toneMapped`. The conversion is labeled `Standard 1080p (HDR → SDR)`, and the viewer shows `HDR HLG/PQ source · tone-mapped to SDR`. Originals remain untouched and downloadable.

#### Verification

- `npm run lint` — exit 0. `npm run typecheck` — exit 0 for both workspaces. `npm run build` — exit 0 (21 modules; main 57.58 kB JS / 19.21 kB gzip, stage 8.83 kB, panorama 62.04 kB, CSS 15.19 kB).
- `npm test` — **69 tests, 67 passed, 0 failed, 2 skipped** (the Windows symlink cases).
- New `rendition.test.ts` coverage generates a 10-bit HEVC HLG/BT.2020 fixture, confirms ffprobe retained its transfer, then asserts: `direct_play = 0`; the published rendition is H.264 `yuv420p` tagged `bt709`/`bt709`; media detail reports `hdr: 'hlg'` with the original transfer/primaries; the only playback option is a `toneMapped` rendition labeled `HDR → SDR`; and no job failed. Unit assertions cover PQ/HLG/BT.2020 classification, that 8-bit or undeclared colour is not called HDR, and the two filter chains. Existing rendition, rotation, migration and backup tests still pass.
- The color-tag enforcement initially failed the pre-existing HEVC and rotation fixtures because FFmpeg 9's MP4 muxer wrote only the matrix; the encoder now sets x264's VUI explicitly, and all six rendition tests pass.

#### Not run

A real DJI D-Log M or HDR camera file, visual review of highlight retention/banding, device colour rendering (HDR displays included), HDR passthrough or Dolby Vision, HDR still photos, and a NAS run.

#### Documentation

`DATABASE.md` records `006` and the new columns; `README.md`, `ARCHITECTURE.md`, `docs/compatibility-matrix.md` and the Phase 4 colour item describe the detection, conversion and its remaining evidence gaps.

### 2026-11-06 — DJI full-sphere export linking

**Roadmap:** Phase 4 (link full-sphere exports to raw originals with provenance; DJI import workflow).
**Evidence level:** Implemented and **verified at API and test level**. No real DJI Studio export, desktop import run or device playback was exercised.

#### Added

- **`005_stitched_exports`** — a partial unique index keeps one confirmed export per raw original; the relation reuses the version and provenance fields established for LRF companions.
- **`server/src/media/exports.ts`** — validates a link (raw `.OSV`/dual-fisheye source only, present equirectangular export, no self-links), stores both source versions, the acting administrator and `policyVersion` as JSON provenance, resolves the link only while both versions still match, supports unlinking, and lists raw originals and export candidates for the administrator.
- **Playback through the export** — media detail offers the linked export's direct-play file or ready H.264 renditions as `Spherical export` options ahead of the unplayable raw file. The recording reports `ready` while `originalConversionRequired` stays true, so the raw original's conversion state is not hidden. A changed original or export suspends the selection until it is re-confirmed.
- **Administrator workflow** — `GET/POST /api/admin/exports` with audit events, and an **Admin → Spherical exports** panel that lists confirmed links and links a chosen raw original to a chosen equirectangular video. Both camera/export files remain untouched and untranscoded by the link itself.

#### Verification

- `npm run lint` — exit 0. `npm run typecheck` — exit 0 for both workspaces. `npm run build` — exit 0 (21 modules; main 57.39 kB JS / 19.13 kB gzip, stage 8.83 kB / 3.74 kB, panorama 62.04 kB, CSS 15.19 kB).
- `npm test` — **68 tests, 66 passed, 0 failed, 2 skipped** (the Windows symlink cases). New `exports.test.ts` coverage:
  - rejects a self-link, missing ids, a non-OSV source and a flat export;
  - links an equirectangular export and serves `/api/media/sphere/original` as the first playback option, labeled `Spherical export`, `spherical: true`, with the recording `ready` and the original still conversion-required;
  - offers `/api/media/sphere/rendition?profile=h264-1080-v1` when the export has no direct-play path but a ready rendition;
  - refuses the viewer role, lists the relation/original/candidates for an administrator, unlinks, restores `conversion_required`, and records both audit events;
  - suspends playback when either file's `source_version` changes and re-links against the new version.
- Migration expectations in `migrations.test.ts` and `backup.test.ts` were updated for `005`; the backup/restore drill still passes.

#### Not run

A real DJI Studio export and desktop import, playback of a linked export on any device, audio sync, an export shorter or longer than its original (timeline equivalence is not yet checked), and a NAS run.

#### Documentation

`README.md`, `ARCHITECTURE.md`, `DATABASE.md`, `docs/compatibility-matrix.md` and the Phase 4 roadmap item record the workflow, its version gating and its remaining evidence gaps.

### 2026-11-06 — Navigable spherical video

**Roadmap:** Phase 4 (spherical navigation; play/pause, seek, timeline, volume/mute, immersive playback).
**Evidence level:** Implemented and **verified in headless Chrome (15/15 checks)** against the real Preact component, a real WebGL context and a generated 1024 × 512 equirectangular H.264 clip with markers at known longitudes and latitudes, plus lint/typecheck/test/build.

#### Added

- **`web/src/sphere-video.tsx`** — a dependency-free WebGL stage in its own lazy chunk (8.8 kB JS, 3.7 kB gzip). A hidden video element supplies frames, a full-screen quad turns each fragment into a camera ray, and the ray's longitude/latitude sample the equirectangular texture. Drag, two-finger pinch, wheel, arrow keys, `+`/`-`, space and `F` are owned by the stage; play/pause, a seek timeline, mute and immersive controls sit inside the wrapper so native fullscreen keeps them reachable.
- **Viewer integration** — an equirectangular playback option now mounts the stage instead of a plain video; the last reported playhead is carried across a quality switch, and closing or moving away saves the position. Arrow-key item navigation yields to the stage while it is mounted.
- **Graceful degradation** — a browser without WebGL gets an explanation and an explicit *Use flat video* action; a lost context offers *Try spherical view again*, and a successful retry renders the sphere again.
- **First-frame handling** — after metadata the stage seeks a hair past zero, because a paused video at time zero can otherwise hold a blank frame and render a black sphere.

#### Verification

- `npm run lint`, `npm run typecheck`, `npm run build` — exit 0 (21 modules; stage chunk 8.83 kB JS / 3.74 kB gzip). `npm test` — **65 tests, 63 passed, 0 failed, 2 skipped**; server behaviour is unchanged.
- **Headless Chrome 1280 × 800 with SwiftShader, 15/15 checks**, sampling the composited canvas rather than trusting component state:
  - Projection: yaw 0/pitch 0 sampled the frame-centre red marker (254,0,0); `ArrowRight` × 15 (yaw +90°) sampled the green marker at u = 0.75; `ArrowUp` × 11 (pitch +44°) sampled the blue marker at v ≈ 0.25.
  - Input: a 750 px left drag reached the east marker; wheel zoom grew the red marker from 231,968 to 301,814 pixels; a two-finger pinch grew it to 591,766.
  - Playback: Play advanced to 0.31 s, Pause held the playhead at 0.87 s, the seek input moved it to 2.00 s, and positions were reported to the parent.
  - Immersive entered native fullscreen with the controls and *Exit immersive* still reachable.
  - Context loss produced the *360° video stopped* notice with retry and flat-video actions; retrying rendered the red marker again.
- The temporary harness page, fixture video and Chrome profile were removed; no test hook ships.

#### Not run

A real DJI spherical export, quality switching with the spherical stage in a browser, audio sync (the fixture is silent), physical Windows/Android/iOS devices, the Safari/iOS fullscreen fallback, and HDR sources.

#### Documentation

`README.md`, `ARCHITECTURE.md`, `docs/compatibility-matrix.md` and the Phase 4 roadmap item now record the stage and its evidence; the remaining spherical-video gaps are listed explicitly.

### 2026-11-06 — Spherical video labeled explicitly; sphere renditions geometry-checked

**Roadmap:** Phase 4 (keep color conversion and projection handling explicit; do not silently turn panoramic inputs into flat exports).
**Evidence level:** Implemented and **verified locally** at lint, typecheck, test and build level. No spherical video playback has been exercised in a browser, and HDR/color management and the spherical video renderer remain open.

#### Added

- **Projection travels with each representation.** Every `playbackOptions` entry now reports the effective `projection` of the file it serves and a derived `spherical` flag, so the client never infers a video's geometry from the recording or a filename. A confirmed LRF preview reports its own independently probed projection.
- **The viewer says when a 360° video is flat.** Selecting an equirectangular representation shows *360° video — spherical navigation is not available yet, so the full equirectangular frame is shown flat.* instead of presenting the frame as an ordinary video.
- **A flattened sphere cannot be published.** The rendition publisher now compares the ffprobe-decoded frame size with the planned target, and an equirectangular source must stay 2:1 within 2%; otherwise the job fails permanently and leaves the source untouched.

#### Verification

- `npm run lint` — exit 0. `npm run typecheck` — exit 0 for both workspaces (an earlier run caught the missing server-side option fields, fixed before this result).
- `npm test` — **65 tests, 63 passed, 0 failed, 2 skipped** (the two Windows symlink cases). New assertions: `sphereFrameProblem` accepts 2160×1080 and 1920×960, rejects 1920×1080 as a 16:9 flattening, rejects an empty frame, and every playback option of a sphere-classified source reports `spherical: true` with `projection: 'equirectangular'`.
- `npm run build` — exit 0, 20 modules; main 54.33 kB JS (18.48 kB gzip), Pannellum chunk 62.04 kB JS (19.83 kB gzip), main CSS 13.52 kB (3.47 kB gzip), panorama CSS 9.50 kB (2.54 kB gzip).
- **Not run:** spherical MP4 playback and seeking in a browser or on a device; HDR/wide-gamut tonemapping; the spherical video renderer; NAS deployment.

#### Documentation

- `README.md` and `ARCHITECTURE.md` describe the labeled flat presentation and the 2:1 publication check; `docs/compatibility-matrix.md` replaces the stale “not browser verified” rows with the 2026-11-06 headless-Chrome evidence and the new spherical-video handling.

### 2026-11-06 — Viewer input modes and browser-verified failure recovery

**Roadmap:** Phase 3 (drag, pinch, keyboard controls, immersive/fullscreen modes, orientation reset, next/previous navigation; recoverable viewer failures).
**Evidence level:** Implemented and **verified in headless Chrome** (28/28 automated checks) against the real Pannellum 2.5.7 build and a real `pano-sq-v1` pyramid generated from the supplied 15520 × 7760 DJI panorama, plus lint/typecheck/test/build. No physical iOS/Android, gyroscope or Safari run.

#### Added

- **Keyboard control of the sphere.** Arrow keys pan, `+`/`-` zoom, `[`/`]` change item and `F` toggles immersive mode. The handler ignores modified keystrokes and typing targets, and Pannellum's own keyboard control is disabled so a key moves the view once.
- **Immersive mode that keeps its controls.** The viewer fullscreens the panorama wrapper rather than Pannellum's canvas, so the toolbar and previous/next arrows stay reachable. Browsers without element fullscreen (iOS Safari) fall back to a fixed overlay; both paths re-measure the renderer and clear on exit or Escape.
- **On-stage zoom, immersive and navigation controls.** `−`/`+` buttons, an *Immersive* toggle with a pressed state, and previous/next chevrons disabled at the ends of the set.
- **Pinch and wheel zoom.** Pannellum's two-finger pinch is kept and the stage now declares `touch-action: none`/`overscroll-behavior: contain` so the browser does not consume the gesture; wheel zoom is enabled (`mouseZoom: true`), matching the existing viewer hint.
- **A load watchdog for unreachable tiles.** Pannellum reports a missing pyramid as endless loading and never raises `error`. After 20 seconds without a `load` event the stage shows the explained failure with *Try interactive view again* and *Show flat preview* instead of a permanent loader.

#### Changed

- The Pannellum control bar is replaced by app controls (`showControls: false`) so buttons match the dark viewer, carry labels for screen readers, and survive into immersive mode.
- The render-failure copy now covers an unloadable pyramid as well as a renderer failure.

#### Verification

- `npm run lint`, `npm run typecheck`, `npm run build` — exit 0. `npm test` — **65 tests, 63 passed, 0 failed, 2 skipped** (the two Windows symlink cases); server behaviour is unchanged.
- **Headless Chrome (1280 × 800, DevTools protocol), 28/28 checks**, with the real lazy-loaded Pannellum bundle and a generated multires pyramid:
  - Keyboard: ArrowRight yaw 0° → 6°, ArrowUp pitch 0° → 4°, `+` hfov 100° → 85°, `-` 85° → 100°, and `[`/`]` changed the selected item.
  - Buttons: zoom in 100° → 85°, zoom out 85° → 100°; next/previous chevrons changed item and were disabled at the first/last item.
  - Immersive: native `document.fullscreenElement` was set, the toolbar and *Exit immersive* label stayed reachable, and exiting restored the inline stage.
  - Pinch: a two-finger touch spread over the canvas changed hfov 100° → 82°.
  - Context loss: `WEBGL_lose_context.loseContext()` on the live canvas produced the *360° view stopped* notice with both actions; `restoreContext()` removed it, rebuilt one viewer (count 1 → 2) and `isLoaded()` returned true again.
  - Unsupported WebGL: the probe produced *Interactive view unavailable* with the WebGL explanation, no viewer was constructed, and *Show flat preview* reached the parent.
  - Unreachable tiles: the watchdog produced the explained notice and *Try interactive view again* rebuilt exactly one viewer (1 → 2).
- The harness page, generated tiles and Chrome profile were temporary and removed; no test-only hook ships in the app.

#### Not run

Physical iOS/Android touch and pinch, gyroscope permission and motion, the Safari/iOS overlay fallback, real GPU resets, background/resume, phone fullscreen, visual review on a device, and repeated open/close memory measurement. NAS deployment remains out of scope.

### 2026-11-06 — Recoverable panorama failures and explicit viewer teardown

**Roadmap:** Phase 3 (release textures/listeners when leaving a viewer; handle WebGL context loss or unsupported devices gracefully).
**Evidence level:** Implemented and **verified locally at lint, typecheck and build level**. No browser context-loss simulation, visual review or physical-device run.

#### Fixed

- **A panorama failure dropped the interactive view without explaining it.** `PanoStage` rendered its own “Interactive view unavailable” notice, but the parent handled the error by setting the tile manifest to `null`, unmounting the stage immediately. The user saw the flat preview with no reason and no route back to the 360° view. Failures now stay in the stage with the cause and a **Try interactive view again** button, and **Show flat preview** is an explicit choice; the viewer records the fallback in its status line.
- **A lost WebGL context killed the sphere silently.** A GPU reset or a long-backgrounded tab left Pannellum painting a dead canvas. The adapter now watches `webglcontextlost`/`webglcontextrestored` on the host in the capture phase (the events do not bubble and Pannellum's canvas may not exist yet), calls `preventDefault()` so restoration stays possible, explains the state, and rebuilds the viewer automatically when the browser restores the context.

#### Added

- A WebGL capability probe before mounting, so a browser that cannot create a context is told why the panorama cannot render instead of showing an empty 360° panel.
- Listener teardown through one `AbortController` per mount, aborted before `destroy()` and `replaceChildren()`. A retry is one rebuilt viewer instance rather than an accumulating stack of instances, textures and timers.
- `.pano-failure` overlay styling for the dark viewer stage, with the two actions and NiX-consistent buttons.

#### Verification

- `npm run lint` — exit 0.
- `npm run typecheck` — exit 0 for both workspaces.
- `npm test` — **65 tests, 63 passed, 0 failed, 2 skipped** (the two Windows symlink cases). No server behaviour changed, so the suite is a regression check only.
- `npm run build` — exit 0, 20 modules; main bundle 54.03 kB JS (18.36 kB gzip), lazy Pannellum chunk 59.45 kB JS (18.98 kB gzip), main CSS 12.47 kB (3.21 kB gzip), panorama CSS 9.50 kB (2.54 kB gzip).
- **Not run:** forcing context loss in a browser, visual review of the new notice, automatic restore after a GPU reset, repeated open/close memory measurement, background/resume, fullscreen and physical iOS/Android behaviour. These remain Phase 3 acceptance gaps.

#### Documentation

- `README.md` records the recoverable failure behaviour, `ARCHITECTURE.md` replaces the “falls back to the flat preview” sentence with the actual failure and context-loss flow, and `ROADMAP.md` checks the Phase 3 teardown task with this evidence and updates the handoff.

#### Remaining work

- Phase 3 device acceptance is still the gate: touch/pinch, gyroscope permission, fullscreen/immersive, background/resume and repeated open/close on physical hardware. The “drag, pinch, keyboard, immersive and navigation” task and the Phase 4 spherical-video renderer stay open.

### 2026-11-05 — Local HTTPS, proxy trust and reverse-proxy runbook

**Roadmap:** Phase 1 final task (local HTTPS testing and proxy settings).
**Evidence level:** **Verified locally at test level**, including a real self-signed TLS terminator. No DSM/Nginx deployment, certificate issuance/renewal or external connection.

#### Added

- `server/tests/proxy.test.ts`: forwarded protocol headers are ignored with `NIX_TRUST_PROXY=false`; with trust enabled they drive CSRF's expected origin and the login response carries `HttpOnly; Secure; SameSite=Strict`; and a minimal local HTTPS terminator built on `node:https` proxies real TLS traffic to Fastify, including health, HSTS, login and an authenticated session. The certificate is generated per run with OpenSSL; the test skips when OpenSSL is unavailable.
- `docs/https-proxy.md`: the loopback topology, required environment values, an Nginx server block, an unverified DSM reverse-proxy outline, a verification checklist, the local evidence and the remaining gates.

#### Verification

- `npm run lint` — exit 0.
- `npm run typecheck` — exit 0 for both workspaces.
- `npm test` — **65 tests, 63 passed, 0 failed, 2 skipped** (the two Windows symlink cases). The new proxy suite is fully executed, not skipped.
- `npm run build` — exit 0; sizes unchanged (main 53.89 kB JS / 18.32 kB gzip, Pannellum chunk 58.08 kB / 18.48 kB gzip, main CSS 12.00 kB, panorama CSS 9.50 kB).
- TLS drill with OpenSSL 3.5.6: a self-signed `localhost` certificate and Node HTTPS proxy served `/api/health` (`200`, HSTS present), accepted a login (`200`, `Secure` session cookie), and resolved `/api/auth/me` as the owner through the proxy.
- **Not run:** a DSM or Nginx deployment, certificate issuance or renewal, HTTP/2, a real external route, remote playback, Range traffic through a proxy, or throughput measurement.

#### Documentation

- `README.md` gains the HTTPS section and a proxy-ready bullet, clarifies `NIX_TRUST_PROXY`, and records that HTTPS is not deployed; `.env.example` warns that proxy trust requires a loopback-only app port.
- `ROADMAP.md` checks the final Phase 1 task with this evidence and updates the handoff: every Phase 1 task now has local evidence; `docs/discovery.md` adds the HTTPS/proxy gate.

#### Remaining work

- Phase 1 is locally complete, but NAS deployment and a real DSM reverse proxy with certificate renewal are still open. Phase 6 owns external reachability, remote playback and throughput. Device/browser acceptance for panorama controls and video playback remains open.

### 2026-11-05 — Verified online backup and restore drill

**Roadmap:** Phase 2 (relationship and user-state records after a database restore) and Phase 7 backup/restore groundwork.
**Evidence level:** **Verified locally at test level.** No NAS restore, derivative rebuild or recovery-time measurement.

#### Added

- `server/src/db/backup.ts`: `backupDatabase()` snapshots the live WAL-mode catalog through `node:sqlite`'s online backup API, so the API and worker keep running. The copy is written beside the destination, checked with `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, then renamed into place. A failed check deletes the partial file, an existing destination is never replaced implicitly, and a cross-filesystem destination falls back to a controlled copy.
- `npm run backup -- --out <file> [--force]` (`server/src/scripts/backup.ts`): resolves the configured `NIX_DATA_DIR`, refuses a missing database or an existing file without `--force`, and reports bytes, table count and applied schema versions.
- `server/tests/backup.test.ts`: a seeded catalog with a confirmed OSV/LRF relation, metadata, a tiles derivative, an override, a favorite, an album item and playback history is backed up, copied into an isolated directory, reopened and compared row by row.

#### Verification

- `npm run lint` — exit 0.
- `npm run typecheck` — exit 0 for both workspaces.
- `npm test` — **62 tests, 60 passed, 0 failed, 2 skipped** (Windows symlink privileges).
- `npm run build` — exit 0; bundle sizes unchanged (main 53.89 kB JS / 18.32 kB gzip, Pannellum chunk 58.08 kB / 18.48 kB gzip, CSS 12.00 kB).
- Restore drill: the snapshot is self-contained (no `-wal` beside it); a write made after the snapshot is absent from the restored copy and still present in the live database; the restore needs no migrations; media availability, the confirmed relation and its provenance, `canonicalMediaId`/`companionPreview` resolution, favorites, album membership, `position_seconds = 42`, the projection override and the derivative storage key all survive; foreign keys and page integrity are clean; the restored copy is immediately writable; an existing destination is rejected; a non-database file fails verification.
- **Not run:** a NAS restore, derivative rebuilding, recovery-time measurement, off-device backup storage, and backup while a heavy job writes concurrently.

#### Documentation

- `README.md` gains a backup section; `DATABASE.md` replaces the raw shell snippet with the command and a restore runbook; `ROADMAP.md` records the Phase 1 implementation evidence and the Phase 2 restore check, and annotates the remaining Phase 7 backup/restore work; `docs/discovery.md` updates the restore gate.

#### Remaining work

- Schedule backups to off-device storage, include configuration/secrets and non-reproducible metadata, rebuild derivatives after a restore, and measure recovery time on the NAS (Phase 7). Local HTTPS/proxy verification also remains open in Phase 1.

### 2026-11-05 — ESLint configuration for both workspaces

**Roadmap:** Phase 1 (lint/type checks in the foundation task).
**Evidence level:** **Verified locally.**

#### Added

- Root `eslint.config.js` (flat config) and `npm run lint`, using ESLint 10.14.0 with `@eslint/js` 10.0.1 recommended rules, typescript-eslint 8.72.1 recommended rules and `globals` 17.14.0. It covers `server/src`, `server/tests` and the Preact client in `web/src`, and ignores `dist`, `node_modules`, `data`, `Testmedia` and `.verify`.
- Two intentional adjustments instead of blanket disables: empty `catch` blocks are allowed for cleanup paths that ignore an already-failed close, and `_`-prefixed unused arguments, variables and caught errors are permitted for contract signatures.

#### Fixed

- Findings the new rules reported in existing code: `freeBytes` was assigned `null` a second time in a catch where it was already null; a migration failure discarded its original error; `PANO_MIN_SOURCE_WIDTH`, a shadowed `needsRendition` local, `run` in `media/tiles.ts`, and an unused `execFileAsync`/`promisify` pair were dead code; `entries` in the scanner was declared `let` but assigned once; a `tiles` test declared an unused `t`.
- The migration error now carries the original exception as its `cause`, so a failed upgrade keeps its diagnostic context instead of only a message.

#### Verification

- `npm run lint` — exit 0, no findings.
- `npm run typecheck` — exit 0 for both workspaces.
- `npm test` — **60 tests, 58 passed, 0 failed, 2 skipped** (Windows symlink privileges).
- `npm run build` — exit 0; main bundle 53.89 kB JS (18.32 kB gzip), lazy Pannellum chunk 58.08 kB JS (18.48 kB gzip), CSS 12.00 kB (3.14 kB gzip).
- **Not run:** no editor or CI integration for lint yet. `npm audit` reports **13 advisories (11 moderate, 2 high)** in the runtime tree, including libvips/libheif/librsvg CVEs inherited through `sharp`; the suggested fix is the breaking upgrade to `sharp@0.35.5`. It was left for the Phase 7 dependency review rather than applied untested inside a lint change.

#### Documentation

- `README.md` lists `npm run lint` with the other verification commands, `ROADMAP.md` checks off the Phase 1 foundation task and records the lint status in the handoff, and `docs/discovery.md` records the tool versions.

#### Remaining work

- Local HTTPS/proxy verification remains open in Phase 1. Dependency-advisory triage remains part of the Phase 7 review; the observed `sharp` upgrade is breaking and needs its own image-output verification.

### 2026-11-05 — Companion selection safety and Phase 2 pairing verification

**Roadmap:** Phase 2 LRF companion extension (ambiguous/mismatched pairs, source changes, missing roots/files, restart) and Phase 4 preview selection.
**Evidence level:** **Verified locally at API/test level** with FFmpeg 9.0.1 fixtures and catalog-row cases. No browser, device, NAS or database-restore exercise.

#### Fixed

- **Changed companion bytes could be served under recorded evidence.** The confirmed relationship stores the source versions it was validated against, but `companionPreview()` returned it regardless. After an LRF (or the OSV) was replaced, detail still offered “Preview (LRF)” and the poster source still pointed at it, while the probe metadata described the previous file. Selection is now version-gated: the relationship is used only while `source_version` and `related_version` equal both files' current `media.source_version`. A change suspends the preview until the durable `pair_companion` job re-confirms it from fresh probe evidence; if the new evidence is ambiguous, the recording keeps its playback options but no preview, rather than presenting mismatched bytes as the verified companion. Detail, playback options and poster generation share the gate.

#### Added

- `DJI LRF companion safety rules` test suite. Catalog-row cases prove that the same stem in another root, a case-distinct stem, two same-stem candidates, and conflicting certain capture timestamps cannot produce a relationship; ambiguous evidence is recorded in `companion_checks`. A new end-to-end fixture covers a truncated LRF (probe failure stays `failed` and the pair stays `pending`), a companion rewritten to a different duration (preview suspended, then `ambiguous` instead of re-confirmed), a return to the original duration (re-confirmed at the new source version and preview offered again), deletion of the companion (recording retained with `missing` status and no preview), an unavailable root (nothing tombstoned, relationship intact) and reopening the database file (relationship, canonical deep-link resolution and preview lookup preserved).
- The orphan-LRF test now also asserts that an unpaired LRF is its own recording with direct original playback, rather than only being counted in the gallery.

#### Verification

- `npm run typecheck` — exit 0 for both workspaces.
- `npm test` — **60 tests, 58 passed, 0 failed, 2 skipped** (Windows symlink privileges). The focused `companions` suite passes 6/6.
- `npm run build` — exit 0; main bundle 53.89 kB JS (18.32 kB gzip), lazy Pannellum chunk 58.08 kB JS (18.48 kB gzip), CSS 12.00 kB (3.14 kB gzip).
- **Not run:** browser or device playback after a source change, a real DJI OSV/LRF pair, NAS timing, and a database-restore drill (Phase 7).

#### Documentation

- `ARCHITECTURE.md` no longer describes companion preview selection as planned; it documents the implemented flow and the version gate. `DATABASE.md` records the selection invariant, and `docs/lrf-preview.md` and `ROADMAP.md` check off the pairing, orphan, source-change, missing-file, root-outage and restart checks with their evidence. Database restore and physical-device checks remain open.

#### Remaining work

- Restore-drill evidence for relationship and user-state records, spherical LRF playback, physical iOS/Android playback, and the remaining Phase 4 DJI export workflow.

### 2026-11-05 — Explicit conversion, processing and failure experiences

**Roadmap:** Phase 4 (explicit `conversion_required`, `processing`, `ready` and `failed` experiences for DJI/proprietary inputs).
**Evidence level:** **Verified at API/test level** with synthetic fixtures. No browser or device run.

#### Fixed

- **Unreadable files and raw DJI OSV stayed “Processing” forever.** A permanent probe failure only failed the job, leaving `media.processing_state` at `pending`; the gallery kept promising a preview that would never arrive. The probe handler now records the outcome before re-throwing: an unreadable file becomes `failed` with the sanitized reason, and a raw `.osv` becomes `unsupported` with DJI export guidance.
- **A retryable failure was presented as “Conversion required”.** The gallery and viewer collapsed `unsupported` and `failed` into one label. They are now distinct: conversion required means an external export is needed; failed means processing did not complete and can be retried.
- A video with no `playbackOptions` was reported as `originalConversionRequired` even while still queued. That flag now follows the derived state, so a queued video reads `processing` rather than “convert this”.

#### Added

- `describeExperience()` and the media-detail `experience` object — `{ state, title, detail, retryable }` computed once on the server from the processing state, the availability of a playable representation and the stored reason. Clients no longer reinterpret several columns independently.
- Gallery badges distinguish “Requires conversion” from “Processing failed”; the viewer renders the server's title and explanation, adds retry guidance for retryable failures, and keeps the server's state after the detail request succeeds.

#### Verification

- `npm run typecheck` — exit 0.
- `npm test` — **57 tests, 55 passed, 0 failed, 2 skipped** (Windows symlink privileges). New suite `server/tests/experience.test.ts`.
- Unit coverage: ready; `pending` and `processing`; unsupported; failed; and a `ready` video with no playable stream, which is reported as conversion required.
- End-to-end: a synthetic `.osv` is catalogued `unsupported` with DJI Studio guidance and its detail reports `conversion_required`, `retryable: false` and `originalConversionRequired: true`; a truncated `.mp4` becomes `failed` with `retryable: true` and `originalConversionRequired: false`; a queued video reports `processing`; every probe job ends in a terminal `failed` state rather than staying in `retry_wait`.
- `npm run build` — exit 0; viewer bundle 53.89 kB JS (18.32 kB gzip), Pannellum chunk 58.08 kB (18.48 kB gzip), CSS 12.00 kB (3.14 kB gzip).
- **Not run:** the new notices in a browser, physical-device behaviour, a real raw DJI OSV, long files and NAS timing.

#### Remaining work

- Spherical navigation still needs a validated renderer; the documented DJI full-sphere export/link workflow and real-device playback remain open.

### 2026-11-05 — Display rotation and frame-rate normalization for video

**Roadmap:** Phase 4 (portrait rotation, variable frame rate, missing audio).
**Evidence level:** **Verified at file/API/test level** with FFmpeg 9.0.1 fixtures. No browser or device playback was exercised.

#### Fixed

- **Portrait phone clips were encoded into a landscape box.** Probing ignored the container's display matrix, so a 1920 × 1080 coded frame displayed portrait was catalogued and bounded as 1920 × 1080; FFmpeg's autorotation then squeezed the upright frame into that landscape target. Probe now reads the display matrix (or the legacy `rotate` tag), stores the correction in `media_metadata.rotation_degrees` (migration `004_video_rotation`) and records the **displayed** dimensions. Projection hints, rendition bounds and the viewer all use those dimensions. Some muxers write a quarter turn as `-90` and others as `270`; both normalize to 90.

#### Added

- Rendition encoding normalizes timing: `-fps_mode cfr` is always applied, and sources above 30 fps are re-timed with `-r 30`. Variable-rate phone clips get constant timestamps, and encode cost stays inside the documented profile budget.
- Media detail exposes `rotationDegrees`; the viewer shows a *Rotated 90°/180°* note so a portrait clip is not silently presented as landscape metadata.

#### Verification

- `npm run typecheck` — exit 0.
- `npm test` — **55 tests, 53 passed, 0 failed, 2 skipped** (Windows symlink privileges).
- Unit coverage: display-matrix `-90`, `270` and `180`, the legacy `rotate` tag, absent rotation, and quarter-turn dimension swapping (including unknown dimensions).
- End-to-end fixture: 1600 × 900 at 60 fps H.264 re-muxed with `-display_rotation 90`. Probe records `rotation_degrees = 90` and 900 × 1600 display dimensions; the only derivative is the data saver, sized 406 × 720 because FFmpeg autorotated before scaling; the silent source stays silent (no audio stream) and the output reports `avg_frame_rate` 30 fps.
- `npm run build` — exit 0; viewer bundle 53.32 kB JS (18.14 kB gzip), Pannellum chunk 58.08 kB (18.48 kB gzip), CSS 12.00 kB (3.14 kB gzip).
- **Not run:** playing a rotated clip in a browser or on a phone, rotation combined with spherical projection, real variable-frame-rate capture, long-file encodes and NAS timing.

#### Remaining work

- Long files, device playback and browser behaviour for rotated clips remain unverified; spherical navigation and the DJI export workflow are still open in Phase 4.

### 2026-11-05 — Precomputed MP4 quality options

**Roadmap:** Phase 4 (precomputed MP4 quality options and explicit quality choice).
**Evidence level:** **Verified at file/API/test level.** No browser or device playback of a quality switch was exercised.

#### Added

- A second versioned rendition profile, `h264-720-v1` (*Data saver 720p*): 1280 × 720 for flat footage, 1440 × 720 for a 2:1 sphere, with the same libx264 High@4.0, CRF 21, 8-bit 4:2:0, AAC and `+faststart` verification as the standard profile. It is queued only when the source is larger than the profile, so small clips and already-small direct-play files do not grow the archive for nothing.
- `video_rendition` jobs carry their profile in `profile_version`; an unknown profile is a permanent failure instead of a silent fallback encode.
- Media detail returns `playbackOptions` best first: confirmed compatible LRF preview, verified direct-play original, then ready renditions (standard before data saver), each with kind, profile recipe, URL, dimensions and bytes. `playback` remains the first option, so the default choice is unchanged.
- `GET /api/media/:id/rendition?profile=<recipe>` serves one profile through the existing authorized Range/HEAD/ETag path. An unknown profile name returns `400 invalid_profile`; a known but unencoded profile returns `404 rendition_not_ready`; without `?profile=` the standard rendition is preferred.
- The viewer shows a **Quality** selector whenever more than one representation is playable, labeled with dimensions and file size. Switching saves the current position, reloads the source and reapplies that position on `loadedmetadata`, so it never restarts from zero.

#### Verification

- `npm run typecheck` — exit 0.
- `npm test` — **53 tests, 51 passed, 0 failed, 2 skipped** (Windows symlink privileges).
- New assertions cover profile bounds for flat and spherical sources and the `needsRendition` threshold. A new end-to-end test encodes a 1600 × 900 H.264 clip that is direct-playable: only `h264-720-v1` is generated (1280 × 720), detail lists `original` then `rendition`, the data saver serves a `206` byte range as `video/mp4`, an unencoded profile returns `404`, an unknown profile `400`, the original still returns `200`, and no job failed.
- `npm run build` — exit 0; viewer bundle 53.20 kB JS (18.11 kB gzip), lazily loaded Pannellum chunk 58.08 kB (18.48 kB gzip), CSS 12.00 kB (3.14 kB gzip).
- **Not run:** playing a quality switch in a browser, seeking after a switch, physical devices, adaptive/HLS switching, and NAS timing for a second profile.

#### Operational impact

- Sources above 720p can now hold two renditions. The data saver is the smaller copy and only exists where it downscales, but the archive grows by roughly one additional low-bitrate encode per large video; retention rules apply per profile.

#### Remaining work

- Adaptive/HLS delivery (Phase 5), spherical video navigation, device playback verification and the DJI full-sphere import workflow remain open.

### 2026-11-05 — Desktop browser check of the tiled 360° viewer (tile URL fix)

**Roadmap:** Phase 3 (browser tile loading, drag and reset; seam review).
**Evidence level:** **Verified in headless Chrome** (Chrome on Windows, software WebGL via ANGLE/SwiftShader) against a freshly generated `pano-sq-v1` pyramid from the supplied 15520 × 7760 DJI panorama. Physical devices, touch input, gyroscope and NAS behaviour remain unverified.

#### Fixed

- **Every panorama tile request returned 404.** Pannellum composes URLs as `basePath + path` without inserting a separator, but the manifest returned `/api/media/<id>/tiles`, so the browser requested `/api/media/<id>/tilesl1/f0_0.webp` and the viewer sat on “Click to Load Panorama”. The tile manifest now returns `/api/media/<id>/tiles/`, and the `tiles` test asserts both the trailing slash and that the composed `l3/f0_0.webp` URL resolves to a real tile.

#### Verification

- Disposable workspace (`.verify/`, removed afterwards) with a copy of `Testmedia/CAM_20261027135051_0053_D.JPG` as the only media root; scanning, probing, thumbnail and tile jobs completed in 14 s; API and worker ran from the same source tree against a scratch SQLite database.
- Headless Chrome: gallery loaded, the item opened, and the Pannellum canvas mounted. **25 tile responses, all HTTP 200, no 404s, no console errors, no uncaught exceptions.**
- **Drag:** a 240 px pointer drag produced a 43.29 mean pixel difference from the initial frame, and the frame showed the same enclosure from a different yaw.
- **Reset view:** the third frame is pixel-identical to the first (mean difference 0.00), so reset returns exactly to the saved start direction.
- **Visual review** of all three frames: level horizon, no visible cube-face seam, no missing/black tiles, consistent rafters and subjects across the rotation. The administrator `Projection` selector and `Set start view` button were visible in the viewer.
- `npm run typecheck` — exit 0; `npm test` — **52 tests, 50 passed, 0 failed, 2 skipped**; no web bundle change, so the recorded build sizes still apply.
- **Not run:** physical iOS/Android touch and pinch, gyroscope permission, fullscreen/immersive mode, repeated open/close memory measurement, WebGL context-loss handling, tile-generation timing and peak memory on the NAS, and a browser pass over a projection switch or a saved start view.

#### Remaining work

- Physical-device checks are still the gate for Phase 3 acceptance; the desktop browser evidence does not establish mobile behaviour.

### 2026-11-05 — Projection override with tile re-queue

**Roadmap:** Phase 3 (projection override workflow in catalog metadata, including re-classification and tile re-queue).
**Evidence level:** Implemented and **verified locally at the server, API and build level**. No browser, NAS or physical-device run was performed.

#### Added

- `PATCH /api/media/:id/overrides` now also accepts `projection` (`flat`, `equirectangular`, `dual_fisheye`, `unknown`, or `null` to fall back to probe evidence). It stays administrator-only and audited, and it is still restricted to photos: spherical video classification waits for a validated video renderer.
- `EFFECTIVE_PROJECTION_SQL` in `server/src/media/projection.ts` (`COALESCE(override, probed)`) is now the single classification used by gallery/search filters and pagination, album items, media detail and the tile manifest. `metadata.projectionSource` reports `override` while an override exists, so a manual decision is never presented as extracted metadata.
- Saving `equirectangular` queues `pano_tiles` immediately when the source is at least 4096 px wide; saving another projection cancels queued `pano_tiles` work and makes both tile routes answer `404 tiles_not_eligible`, so a withdrawn sphere is not served from a stale pyramid. Restoring the sphere reuses the existing pyramid instead of re-encoding it.
- Viewer: administrators get a projection selector next to the 360° status line. The viewer refetches detail and switches between the flat preview and the interactive view without a page reload, and it now reads the effective projection rather than the gallery row's stale value.

#### Verification

- `npm run typecheck` — exit 0 for both workspaces.
- `npm test` — **52 tests, 50 passed, 0 failed, 2 skipped** (Windows symlink privileges). The rewritten `overrides` suite covers an API re-classification queueing tiles, effective projection in gallery filters, `projectionSource = override`, a failed job reporting `failed` with its reason, cancelling queued tile work when the sphere is withdrawn, `404 tiles_not_eligible` for a withdrawn sphere, `null` falling back to the probed `aspect_hint`, pyramid reuse after the classification returns, unauthenticated `401`, viewer `403`, invalid projection claims and out-of-range axes returning `400`, unknown media returning `404`, saved orientation reaching the Pannellum manifest, partial updates preserving other axes, audit parity with accepted changes, and an unchanged source SHA-256.
- `npm run build` — Vite 7.3.7, 20 modules; main bundle 52.32 kB JS (17.85 kB gzip), the lazy Pannellum chunk 58.08 kB JS (18.48 kB gzip) + 9.50 kB CSS (2.54 kB gzip).
- **Not run:** switching the projection from the viewer, seam/pole review of a re-classified photo, gestures, gyroscope and NAS behaviour. (The viewer itself was later opened in Chrome; see the browser-check entry above.)

#### Remaining work

- Re-classification does not regenerate the existing preview thumbnail, which keeps the geometry chosen for its original classification; the pyramid, filters and viewer behaviour update immediately.

### 2026-11-05 — Panorama start view and explicit tile states

**Roadmap:** Phase 3 (projection/orientation overrides in catalog metadata; useful pending/failed tile states).
**Evidence level:** Implemented and **verified locally at the server, API and build level**. No browser, NAS or physical-device run was performed.

#### Added

- `PATCH /api/media/:id/overrides` (administrator only, audited as `media.overrides_changed`) stores the panorama start view as `yaw/pitch/roll` in `media_overrides`. Each axis is optional, bounded (yaw and roll ±180°, pitch ±90°), and a partial update preserves the axes it does not mention. LRF deep links resolve to the canonical recording first, videos are rejected with `not_a_photo`, and no source file is touched.
- The authorized tile manifest already applied `media_overrides`; the viewer now exposes an administrator-only **Set start view** button in the panorama tools that saves the current direction and then resets to it.
- Media detail returns `tiles: { state, recipe, reason } | null` from `panoramaStatus()` in `server/src/media/tiles.ts`. States are `ready`, `pending` (queued or never queued), `failed` (with the sanitized job error) and `ineligible` (not a photo, unconfirmed projection, source narrower than 4096 px, or missing source). The viewer shows the matching sentence instead of one generic flat-preview note.

#### Verification

- `npm run typecheck` — exit 0 for both workspaces.
- `npm test` — **52 tests, 50 passed, 0 failed, 2 skipped** (Windows symlink privileges). The new `overrides` suite covers the unconfirmed-projection state, the not-yet-queued state, a generated pyramid reporting `ready`, a failed job reporting `failed` with its reason, unauthenticated `401`, viewer `403`, empty/mistyped/out-of-range payloads returning `400`, unknown media returning `404`, saved orientation appearing in the Pannellum manifest, partial updates preserving other axes, an explicit `null` clearing one axis, audit rows, and an unchanged source SHA-256.
- `npm run build` — Vite 7.3.7, 20 modules; main bundle 51.85 kB JS (17.71 kB gzip), the lazy Pannellum chunk unchanged at 58.08 kB JS (18.48 kB gzip) + 9.50 kB CSS (2.54 kB gzip).
- **Not run:** rendering the saved start view in a browser, seam/pole review, gesture and gyroscope checks, and NAS behaviour. The Phase 3 visual/device acceptance gate remains open.

#### Remaining work

- A projection override (re-classifying a 2:1 photo and re-queuing its tiles) is still open; only the orientation override is stored today.
### 2026-11-05 — Video playback position persistence

**Roadmap:** Phase 4 (progress persistence).
**Evidence level:** Implemented and **verified locally at the API and build level**; no browser or physical-device playback was exercised.

#### Added

- Media detail now returns `playbackPositionSeconds` for the signed-in user from `viewing_history`. Opening an item still records recency with no position, and the SQL `COALESCE` keeps an existing resume point instead of erasing it.
- The viewer resumes a saved position only when it is at least 5 s and at least 10 s before the end, then shows “Resumed at m:ss”. Progress is saved in 5 s steps while playing, on pause, and when the viewer closes or moves to another item. Reaching the end resets the position to 0 so a finished video starts over.
- Resume state remains per user and per canonical recording: existing companion merging already moves `viewing_history.position_seconds` with the recording, and the detail request resolves LRF deep links to that recording before reading history.

#### Verification

- `npm run typecheck` — exit 0 for both workspaces.
- `npm test` — **51 tests, 49 passed, 0 failed, 2 skipped** (Windows symlink privileges). The new `history` suite checks the unauthenticated response, initial `null`, whole-second storage, opening without a position preserving 42 s, malformed/negative positions being ignored, an update to 12 s, per-user isolation, and the 0 s reset after completion.
- `npm run build` — main bundle 50.85 kB JS (17.44 kB gzip); the lazy Pannellum chunk is unchanged at 57.87 kB JS (18.42 kB gzip).
- **Not run:** actual playback/resume in Chrome, iOS Safari or Android, seeking behaviour on the H.264 rendition and LRF preview, backgrounding, or resume across devices.

#### Remaining work

- Device-level playback verification, quality selection (a direct-play original and a rendition are currently mutually exclusive), spherical video navigation and the DJI full-sphere import workflow remain open in Phase 4.

### 2026-11-05 — Phase 3 tiled 360° photo viewing

**Roadmap:** Phase 3 (viewer adapter, versioned multiresolution tiles, controls, cleanup).
**Evidence level:** Implemented and **verified locally at the server, API and build level**, using both a generated 4096 × 2048 fixture and the supplied 15520 × 7760 DJI panorama (Node v26.8.2, ffmpeg 9.0.1, sharp 0.34). A browser and physical iOS/Android devices were **not** exercised, so the Phase 3 visual/device acceptance gate remains open.

#### Added

- **Tile recipe `pano-sq-v1`** in `server/src/media/tiles.ts`: 2048 px cube faces, 512 px WebP tiles, Pannellum pyramid levels `l1` (1 tile/face) through `l3` (4 × 4 tiles/face) — **126 tiles**, measured at 3,535,092 B (3.5 MB) for the supplied DJI panorama. Only photos with an explicit `equirectangular` projection and source width ≥ 4096 px are queued; unconfirmed 2:1 images stay flat.
- **Offline generation** in the worker (`pano_tiles` job, lowest priority) so gallery thumbnails and playback are never delayed. The source is capped to 8192 × 4096, projected to one 6 × 1 cube strip by `ffmpeg -vf v360=e:c6x1:...:out_forder=fbudlr`, sliced into Pannellum face order (`f, b, u, d, l, r`) and tiled with sharp. Outputs publish into `<media-id>/v<source-version>/pano-sq-v1/` with the manifest renamed last; the single `tiles` derivative row points at the manifest. Re-running reuses a ready pyramid, and source-version changes regenerate it.
- **Authorized API**: `GET /api/media/:id/tiles` returns the Pannellum multires configuration (base path, path template, tile/resolution/levels, preview URL, orientation overrides from `media_overrides`), and `GET /api/media/:id/tiles/:level/:file` serves one tile after session auth and strict level/face/index/path validation. Both return `401` without a session and `404` for missing or malformed tiles; no host path leaves the server.
- **Viewer adapter** `web/src/pano.tsx`: Pannellum 2.5.7 (MIT) mounted through a small load/dispose boundary, with drag, pinch, keyboard, fullscreen, reset-view, and an opt-in motion button shown only when orientation is supported. The viewer chunk is lazy-loaded only for a ready panorama; unmount calls `destroy()` and clears the container. A WebGL error or missing tiles falls back to the existing flat preview and a visible note.
- **Pannellum code-splitting**: the main bundle stays at 49.96 kB JS (17.11 kB gzip); the viewer loads as a separate 57.87 kB JS (18.42 kB gzip) + 9.50 kB CSS (2.54 kB gzip) chunk.

#### Verification

- `npm run typecheck` — exit 0 for both workspaces.
- `npm test` — **50 tests, 48 passed, 0 failed, 2 skipped** (Windows symlink privileges). The new `tiles` suite checks eligibility, 126 generated tiles, manifest/config fields, `image/webp` delivery, `401` without a session, rejection of invalid levels/faces/indices, idempotent re-runs, and an unchanged source SHA-256. Face orientation is proven by projecting a colour-coded equirectangular fixture: the level-1 `f`, `r`, `b`, `l`, `u` and `d` tiles average red, blue, green, yellow, white and black respectively, so the ffmpeg strip order and the Pannellum letter mapping agree rather than merely producing tiles.
- `npm run build` — Vite 7.3.7, 20 modules; output sizes above.
- **Real sample:** a temporary copy of `Testmedia/CAM_20261027135051_0053_D.JPG` (15520 × 7760, XMP equirectangular) was scanned and processed in a disposable workspace. `probe_media`, `hash_media`, `thumbnail` and `pano_tiles` all succeeded; the pyramid held 126 tiles at 3,535,092 B and the whole run (scan through tiles) took 9.19 s on this Windows development machine. The original was never written to, and the temporary workspace was removed. This is a local development timing, not a NAS measurement.
- **Not run:** visual seam/pole/horizon review, browser interaction, physical iOS/Android drag/pinch, gyroscope permission, background/resume, WebGL context loss, repeated open/close memory measurement, NAS tile-generation timing/RAM, and partial (non-360 × 180) panoramas.

#### Operational impact

- Tile generation is the most expensive photo job so far: six 2048² faces and 126 WebP encodes from a capped 8192 × 4096 source, at the lowest queue priority. The supplied DJI panorama produced 3.53 MB of derivatives in the 9.19 s local run; the original is read-only and unchanged.
- The existing 4096 px preview is still generated and shown while tiles are missing, so an unsupported or failed tile job never blocks the photo itself. Tile failures do not flip `media.processing_state`.

#### Remaining work

- Open the generated DJI pyramid in a browser and inspect seams, poles, horizon and colour; verify drag/pinch/keyboard/fullscreen and gyroscope permission on physical phones; measure repeated open/close and confirm NAS generation time and peak memory. Keep the Phase 3 acceptance checks open until then.

### 2026-11-05 — DJI LRF companion pairing and preview selection

**Roadmap:** Phase 2 (companion association and canonical catalog identity) and Phase 4 (preview source selection).
**Evidence level:** Implemented and **verified locally** with generated 320×180 fixtures (Node v26.8.2, ffmpeg 9.0.1). The real 106.9 MB OSV / 7.8 MB LRF sample pair was not scanned, and browser playback, physical devices, restart/restore and NAS deployment remain untested.

#### Added

- Migration `003_lrf_companions`: `media_relations` gains `status` (`proposed`/`confirmed`/`rejected`), `policy_version`, both validated source versions, `updated_at`; partial unique indexes enforce one active companion per recording and one recording per companion while keeping rejected rows. New `companion_checks` table stores visible pending/ambiguous/rejection evidence, and `derivatives.source_media_id` records which physical file a poster was decoded from.
- `pair_companion` job, queued after every successful probe. Evaluation is identical from either file, so LRF-first, OSV-first and late arrivals converge. Candidates must share the root, exact parent directory and exact filename stem with opposite `.osv`/`.lrf` extensions; extensions match case-insensitively, stems do not.
- Pairing policy `1`: both files need probe evidence and finite positive durations; duration tolerance is `max(250 ms, 1 % of the OSV duration)`; certain capture timestamps must agree within 2 s. Violations leave the pair unconfirmed with a recorded reason. Nothing pairs across directories or roots.
- Canonical identity: confirmed companions are excluded from gallery, search, date/coordinate filters, cursor pagination, folder navigation (counts and listings) and album items. Folder exclusion is applied after the existing bounded 50,000-row query; the paginated gallery excludes in SQL. An LRF deep link resolves to the OSV recording.
- Recording detail now returns `canonicalId`, `requestedId`, a `companion` descriptor, `originalConversionRequired` and a `playback` choice: confirmed compatible LRF → ready H.264 rendition → verified direct-play original. The companion preview URL is the authorized `/api/media/<id>/original` route, so Range/HEAD/ETag, MIME type and session checks are unchanged.
- Posters are decoded from the confirmed LRF when it is available, with `source_media_id` provenance; a changed companion regenerates the canonical poster through the normal thumbnail job, and an unsupported original keeps its `unsupported` state rather than being flipped to ready.
- Admin API `GET/POST /api/admin/companions` lists confirmed pairs and undecided checks and supports `confirm`, `reject` (persists across scans until reset or a source-version change) and `reset`, with audit events. The admin page gained a companions panel; the viewer plays the labeled LRF preview, offers a separate preview download, and keeps "original requires conversion" visible.
- Confirmation merges user state transactionally: favorites keep the earliest timestamp, album membership keeps an existing position, viewing history keeps the latest timestamp and its playback position. Unpairing restores two items and intentionally leaves the merged state on the recording.

#### Verification

- `npm run typecheck` — exit 0 for both workspaces.
- `npm test` — **48 tests, 46 passed, 0 failed, 2 skipped** (Windows symlink privileges). New `companions` suite covers: automatic pairing with recorded policy/provenance; one gallery item, folder count, and search result per recording; companion detail resolving to the OSV; `video/mp4` `206` range delivery of the LRF and `401` without a session; poster provenance pointing at the LRF; unchanged SHA-256 of both source files; orphan LRF visible before its OSV arrives; late-arrival convergence; no cross-directory pairing; rejection surviving a rescan; duration mismatch recorded as `ambiguous` rather than paired; admin confirmation; and migration of favorites, album items and viewing position.
- `npm run build` — 42.22 kB JS (14.22 kB gzip) + 11.37 kB CSS (3.01 kB gzip).
- **Not run:** the real Testmedia OSV/LRF pair (the 106.9 MB OSV was too large for the automated fixture), browser playback/seeking of the preview, physical iOS/Android devices, NAS scanning, case-insensitive-filesystem ambiguity, restart/restore, and backup drills.

#### Operational impact

- Pairing is cheap: directory-scoped queries plus metadata reads, no media decode and no new transcode of either camera file.
- A confirmed LRF adds no derivative storage beyond the canonical poster it replaces; the LRF itself is never converted by this feature.

#### Remaining work

- Spherical LRF validation and projection review, browser/device playback checks, Phase 4 quality selection, restart/restore of relationship state, and the Phase 7 backup drill.

### 2026-11-05 — LRF companion preview implementation contract

**Roadmap:** Phase 2 (companion association/canonical catalog identity) and Phase 4 (preview selection/delivery).
**Evidence level:** Proposed feature; documentation updated. Existing standalone LRF tests do not verify this workflow.

#### Added / Changed

- Added [docs/lrf-preview.md](docs/lrf-preview.md) with conservative OSV/LRF matching, ambiguity handling, canonical gallery identity, preserved user state, source-version lifecycle, and a no-encode preview preference.
- Defined ready-source fallback, separate OSV conversion and preview status, independent LRF projection validation, authorized Range delivery, and pending acceptance checks.
- Linked the contract from the roadmap, implementation prompt, README, architecture, database, and compatibility documentation. Added unchecked Phase 2/4 tasks and identified database invariants that need future implementation.
- Corrected the roadmap's stale planning-only status to reflect the existing implementation records while keeping LRF companion work pending.

#### Verification

- Inspected existing LRF scan/MIME support, the initial `media_relations` schema, and recorded sample evidence to distinguish standalone support from the planned companion workflow.
- Checked updated documentation for consistent status, relative links, duplicate headings, and balanced fenced blocks. No application tests, device playback tests, or media conversions were run for this documentation change.

#### Operational impact / Next task

- Documentation only; no application code, database migration, media files, or deployment settings changed.
- Next implementation task: Phase 2 companion matching and canonical recording identity, followed by Phase 4 source selection. All feature acceptance checks in the new specification remain pending.

### 2026-11-05 — Baseline H.264 video renditions

**Roadmap:** Phase 4 (baseline MP4 derivatives; originals only when compatibility permits).
**Evidence level:** Implemented and **verified locally** with a generated 10-bit HEVC fixture (ffmpeg 9.0.1). Browser playback, device seeking and NAS encode throughput are **not** tested.

#### Added

- `video_rendition` job and `h264-1080-v1` recipe: libx264 High profile level 4.0, CRF 21, 8-bit 4:2:0, AAC 160 kb/s stereo, `+faststart`. Frames are fitted to 1920×1080, or 2160×1080 for a 2:1 sphere, without upscaling; dimensions are rounded to even values for 4:2:0.
- FFmpeg is spawned without a shell, reports progress from `-progress pipe:1`, runs under a duration-derived timeout, and is killed if the worker's lease is lost. Exit failures are classified permanent (undecodable/unsupported) or transient (I/O, timeout, interruption).
- Output verification before publication: ffprobe must report H.264 8-bit 4:2:0 and the file must carry `moov` before `mdat`, so seeking never requires the whole file. Anything else is a permanent failure rather than a quietly different rendition.
- Publication is atomic (temp file → rename) and idempotent; the derivative is recorded as kind `video` with recipe version, bytes and dimensions, and stale source versions are removed.
- `GET /api/media/:id/rendition` is authorized like every other representation, streams through the same Range/HEAD/ETag path and returns `video/mp4` only for a ready rendition. Media detail exposes `renditionUrl`; the viewer uses it when present and otherwise the original.
- Probing no longer declares an incompatible video unsupported: it queues encoding. A dual-fisheye original still reports conversion-required and never receives a rendition.
- Poster extraction now seeks to 0 s for clips shorter than 2.5 s, and a poster failure no longer makes a direct-play video unusable.

#### Verification

- `npm run typecheck` — exit 0 for both workspaces.
- `npm test` — **45 tests, 43 passed, 0 failed, 2 skipped** (Windows symlink privileges). The new suite checks profile dimensions (no upscaling, even sizes, sphere geometry) and encodes a 320×180 10-bit HEVC clip end to end: H.264/yuv420p output, `moov` before `mdat`, ready state, derivative row, `206` for a byte range, `401` unauthenticated, `renditionUrl` in detail, and no failed jobs.
- `npm run build` — 39.31 kB JS (13.48 kB gzip) + 11.37 kB CSS (3.01 kB gzip).
- **Not run:** browser playback/seeking, physical devices, long-file encodes, real NAS timing, HLS or adaptive quality.

#### Operational impact

- Encoding is the heaviest job in the system (libx264 `veryfast` on 4 cores). It is queued, not synchronous, and respects the durable queue pause; a video is only shown as ready once its rendition exists.
- Derivative storage grows with duration × selected bitrate; retention and disk-floor checks are still Phase 5 work.

#### Remaining work

- Browser/device playback verification, adaptive quality and HLS (Phase 5), tiled panorama viewing (Phase 3), and a NAS encode benchmark remain open.

### 2026-11-05 — NAS hardware record, scheduled scans and unsupported-file review

**Roadmap:** Phase 0 (owner-supplied NAS hardware), Phase 2 (scheduled reconciliation, failed/unsupported visibility).
**Evidence level:** Hardware is **reported by the owner from DSM**, not measured by the implementer. Application changes are **verified locally** (Windows, Node v26.8.2). No NAS deployment or benchmark.

#### Recorded

- `docs/discovery.md` now records the actual unit: Synology **DS920+**, serial `2160TERCXRA2M`, Intel **Celeron J4125** (4 cores, 2 GHz), **12 GB** RAM, thermal status normal, fan mode cool.
- Written as expectations, not measurements: 12 GB clears the memory concern for 8K decode/probing but does not justify raising the 1 GiB worker cap without a benchmark; the 4-core J4125 still makes software transcoding of 119 Mb/s 100 fps HEVC impractical, so the DJI export route stands.
- The serial number is inventory data only and must stay out of screenshots, logs and support requests.

#### Added

- `NIX_SCAN_INTERVAL_MINUTES` (default `0`, disabled): the worker queues a reconciliation scan for every root whose last successful scan is older than the interval, or that has never completed one. Existing active scans deduplicate, so the check is safe to run repeatedly; it runs at worker start and at most once a minute, and is skipped while the queue is paused.
- Admin page now lists unsupported and failed files with their recorded reason, using the existing `/api/admin/unsupported` endpoint.

#### Verification

- `npm run typecheck` — exit 0 for both workspaces.
- `npm test` — **43 tests, 41 passed, 0 failed, 2 skipped** (Windows symlink privileges). New coverage: scheduling disabled at zero interval, a root with an aged-out scan queued exactly once with its `scan_root` payload, a recently scanned root left alone, and a never-scanned root queued.
- `npm run build` — 39.20 kB JS (13.45 kB gzip) + 11.37 kB CSS (3.01 kB gzip).
- **Not run:** worker scheduling over a real interval (tested by calling the due-check directly with injected timestamps), NAS benchmarks, browser review of the new admin panel.

#### Remaining work

- Still unverified on the NAS: DSM and Container Manager versions, volumes/free space, share paths and UID/GID, `/dev/dri` usability, proxy configuration, sustained throughput. Phase 3 (tiled viewing) has not started.

### 2026-11-05 — Library navigation, duplicate evidence and queue control

**Roadmap:** Phase 2 (folder navigation, search, date/coordinate filters, duplicate grouping, admin queue controls).
**Evidence level:** Implemented and **verified locally** (Windows, Node v26.8.2, ffmpeg 9.0.1). Not verified on the NAS, in a browser, or on a device.

#### Added

- Migration `002_navigation_duplicates_queue`: `app_settings` (durable `queue.paused`), a relative-path index for folder navigation and a GPS index for coordinate filters. Existing installations migrate in place.
- `hash_media` job: streams SHA-256 of the original (1 MiB chunks, abortable, size recheck) and records `content_hash`. It is enqueued after every successful probe, including unsupported files, and is skipped for stale source versions. A changed file clears its hash during the scan.
- Duplicate reporting: `GET /api/admin/duplicates` groups identical content with counts, total bytes and paths; `duplicateSummary` adds group count and reclaimable bytes to `/api/admin/status`; media detail exposes `contentHash` and `duplicateCount`. Nothing is deleted or merged automatically.
- Folder navigation: `GET /api/folders?path=` returns immediate child folders with counts plus the number of files directly in the requested folder. Paths are catalog-derived, traversal and absolute paths are rejected with `400`, and result sets are bounded (50,000 rows, explicit `truncated` flag).
- Gallery filters: `folder` (root-relative prefix), `from`/`to` dates (falling back to catalog insertion time when capture metadata is absent) and a validated GPS bounding box (`latMin`, `latMax`, `lonMin`, `lonMax`; all four required, ranges checked, inverted boxes rejected).
- Durable queue control: `POST /api/admin/queue` with `{ paused }`, checked by the worker before **every** claim, not just at startup. Admin UI exposes a single Pause/Resume button that follows the persisted state.
- Photos view now has file-name search, breadcrumb folder navigation, folder chips with counts, and From/To date inputs; the admin page shows duplicate groups.

#### Verification

- `npm run typecheck` — exit 0 for both workspaces.
- `npm test` — **39 tests, 37 passed, 0 failed, 2 skipped** (Windows symlink privileges). The two new suites cover: nested-folder listing and traversal rejection, folder-filtered listings, file-name search, date-range filtering including malformed input, GPS bounding-box matching and partial/inverted range rejection, identical-copy hashing with duplicate reporting and viewer access denial, and durable pause preventing a claim until resume.
- `npm run build` — 38.52 kB JS (13.27 kB gzip) + 11.37 kB CSS (3.01 kB gzip).
- `docker compose config` still validates (unchanged deployment files).
- **Not run:** browser or device interaction, NAS deployment, real ExifTool capture dates, scheduled reconciliation scans.

#### Operational impact

- The new migration runs automatically on API/worker start. `app_settings` starts unpaused.
- Hashing adds one read pass per file after its first probe; large video libraries will read every original once at import time, which is why it is a separate queued job rather than part of the probe.
- Coordinate filtering is a bounding box over stored GPS values only; there is no map or geocoding provider.

#### Remaining work

- Scheduled reconciliation scans, ExifTool verification against real photos, and a map-style coordinate picker are still open in Phase 2. Lint and local HTTPS/proxy verification remain open in Phase 1.

### 2026-11-05 — Phase 1 foundation and first library vertical slice

**Roadmap:** Phase 1 (foundation, auth, jobs, delivery, shell), Phase 2 (scan/probe/thumbnail slice), Phase 0 (local discovery).
**Evidence level:** Implemented and **verified locally** on Windows (Node v26.8.2, npm 11.19.0, ffmpeg/ffprobe 9.0.1). **Not verified on the NAS or on any physical device.**

#### Added

- npm workspace with `server/` (Fastify, TypeScript run natively by Node 24+ type stripping) and `web/` (Preact + Vite). `npm run typecheck`, `npm test`, `npm run build`.
- Versioned SQLite schema (`server/src/db/migrations/001_initial.sql`) covering users, sessions, roots, scan runs, media, metadata, overrides, relations, derivatives, jobs, albums, favorites, history and audit events; savepoint-based transactions; WAL/foreign-key pragmas.
- Authentication: Argon2id hashes, opaque session tokens stored as SHA-256, `HttpOnly`/`SameSite=Strict` cookies, idle and absolute expiry, revocation on logout/disable/password change, enabled-user checks on every request, origin-based CSRF rejection, login throttling, audit events, and a one-time `bootstrap-admin` script with no default credentials.
- Durable job queue: active-job deduplication, atomic claim with `UPDATE … RETURNING`, expiring leases with heartbeats, exponential backoff, permanent/transient classification, manual retry/cancel, expired-lease recovery and worker startup reconciliation.
- Read-only scanner: configured roots only, hidden/system directories skipped, symlinks refused, stability window for in-progress copies, source-version bump on size/mtime change, Unicode paths, tombstones only after a complete successful scan, root health tracking.
- Media probing: sharp for images, ffprobe for video, optional ExifTool for capture date/GPS. Projection is trusted only from metadata (`GPano`/`GSpherical`, spherical side data); 2:1 without metadata is stored as `unknown` with `aspect_hint`. Dual-fisheye detection and conversion-required reasons. Direct-play detection from container/codec/bit depth rather than extension.
- Derivative pipeline (`thumb-v1`): 400 px thumbnail, 1600 px preview (4096 px wide for equirectangular), video poster; written under `data/temp`, published by rename, recorded transactionally, stale versions removed from disk and catalog. `sharp.cache({ files: 0 })` prevents originals from being held open on Windows.
- Authorized delivery of original/thumbnail/preview/poster with single-range `206`, suffix ranges, `416` with `bytes */size`, `HEAD` with correct length, ETag/`304`, and `private, no-store` caching. Ids resolve to validated paths with `realpath` containment.
- Library API: cursor-paginated gallery with type/projection/search/favorite/history filters, media detail, favorites, viewing history, and owner-scoped album create/list/items.
- Admin API: status counts, free space, roots with manual scan, job listing/retry/cancel, user create/update/disable with session revocation, unsupported-media summary.
- NiX light-theme SPA: login, home/photos/videos/360°/albums/favorites/recently viewed/settings/admin, lazy thumbnails, skeleton/empty/error/processing/unsupported states, media viewer with favorite, download, keyboard navigation and history recording.
- Dockerfile (multi-stage, ffmpeg + exiftool + tini, non-root), `docker-compose.yml` with API + memory/CPU-limited worker, read-only media mounts, healthcheck, log rotation, `.env.example`.
- `README.md`, `ARCHITECTURE.md`, `DATABASE.md`, `docs/discovery.md`, `docs/compatibility-matrix.md`, `docs/adr/0001`, `docs/adr/0002`.

#### Changed

- Nested queue enqueues inside scan transactions no longer fail: the transaction helper uses `SAVEPOINT` instead of `BEGIN`.
- HEAD responses write headers directly so Fastify does not clear the entity length; `416` replies keep a JSON content type instead of inheriting `image/jpeg`.

#### Verification

- `npm run typecheck` — exit 0 for both workspaces.
- `npm test` — 35 tests, 33 passed, 0 failed, 2 skipped (symlink-escape tests require Windows developer mode/privileges). Covers auth/authorization/CSRF/session expiry and revocation, path traversal and symlink containment, job dedupe/claim/retry/recovery/idempotent completion, migrations and foreign keys, scan add/change/missing/unavailable-root/symlink behaviour, probe+thumbnail pipeline, and Range/HEAD/416/ETag delivery.
- `npm run build` — 34.66 kB JS (12.15 kB gzip) + 9.98 kB CSS (2.75 kB gzip) in `web/dist`.
- End-to-end smoke run against the supplied `Testmedia/` samples (API + worker, temp data dir): 6/6 jobs succeeded. Results: `CAM_…JPG` → equirectangular (source `metadata`), ready, 15520 × 7760, 21 KB thumbnail and 999 KB preview; `CAM_…LRF` → H.264 8-bit direct play, ready, poster; `CAM_…OSV` → dual fisheye, unsupported with stitching guidance. Delivery: thumbnail/preview/poster `200 image/webp`, `Range` `206` (1024 bytes), `HEAD 200`, unauthenticated `401`, impossible range `416`. Sample SHA-256 hashes unchanged after the run.
- Environment observation: ffmpeg 9.0.1 full build, ExifTool absent locally (container installs it), Node v26.8.2 with `node:sqlite`.
- **Not run:** `docker build`/`docker compose up`, browser or device checks, NAS inspection/benchmarks, HLS, tiling, real ExifTool image metadata, backup/restore drill.

#### Operational impact

- New configuration: `NIX_MEDIA_ROOTS`, `NIX_DATA_DIR`, `NIX_PUBLIC_ORIGIN`, `NIX_COOKIE_SECURE`, `NIX_TRUST_PROXY`, session windows, `NIX_LOGIN_RATE_LIMIT_MAX`, `NIX_STABILITY_WINDOW_SECONDS`, tool paths.
- Migration `001_initial` is the first schema; no prior data exists to migrate. The database must live on a local filesystem (WAL), not SMB/NFS.
- Runtime requires Node 24+ because the server is executed as TypeScript. Bind-mounted `/data` must be writable by the compose `PUID`/`PGID`.
- Originals are only ever read; the smoke run's hashes confirm this locally.

#### Remaining work

- Lint configuration is not yet present (Phase 1 task 1 caveat); local HTTPS/proxy verification is still open (Phase 1 task 6 caveat).
- NAS discovery/benchmarks, tiled panorama viewer (Phase 3), video derivatives/HLS (Phases 4–5), folder navigation, search UI, GPS filters, job pause/resume, duplicate grouping, and ExifTool verification on real photos remain.

### 2026-11-05 — Planning and implementation handoff

**Status:** Documentation completed; application implementation has not started.

#### Added

- `ROADMAP.md` with the architecture proposal, storage/catalog design, media processing contracts, security requirements, provisional performance budgets, and eight development phases with acceptance criteria.
- `prompt.md` with implementation and resume instructions, original-media protection rules, architecture constraints, focused testing expectations, evidence labels, and documentation responsibilities for DeepSeek or another developer.
- `changelog.md` with the initial project record and conventions for tracking implementation work.

#### Planning refinements

- Identified viewer maintenance and actual DJI sample compatibility as explicit validation gates.
- Placed durable processing jobs and media authorization in the foundation work.
- Distinguished spherical video dimensions from conventional flat-video resolution labels.
- Defined a desktop conversion fallback for unsupported DJI originals, subject to sample validation.
- Separated local implementation, target-NAS verification, physical-device verification, and production readiness.
- Updated the roadmap to reference the implementation companion documents and the canonical lowercase `changelog.md` filename.

These are documented decisions and proposals, not implemented application capabilities.

#### Verification

- Inspected the supplied project brief and local project directory during roadmap preparation; no existing application or applicable repository instructions were found at that time.
- Researched official product documentation and upstream projects for the roadmap; source links are recorded in that document.
- Reviewed the companion documents against the roadmap for scope, phase order, authorization boundaries, and implementation status.
- Checked document presence, relative Markdown links, consistent changelog filename casing, and balanced fenced blocks locally.
- No application tests, builds, containers, NAS benchmarks, sample conversions, or physical-device playback tests were run. There is no application code to validate yet.

#### Operational impact

- Documentation only. No application version, database migration, package installation, container deployment, or network change.
- Original media and NAS configuration were not modified.

#### Outstanding gates and next step

- All implementation phases remain pending. Published product information does not complete Phase 0 validation.
- Actual DSM/runtime/RAM/storage configuration, media paths, sample-file compatibility, physical-device behavior, and external bandwidth remain unverified.
- No deployment authorization is implied by these documentation changes.
- **Next task when implementation is authorized:** begin Phase 0 discovery and record verified facts, selected versions, experiments, and missing inputs in `docs/discovery.md` and the relevant compatibility/decision reports.

## How to maintain this file

1. Add dated entries under **Unreleased**, newest first. Keep historical entries intact; explain material corrections rather than silently rewriting prior results.
2. Describe completed behavior or documentation changes. Keep future tasks in the roadmap, with only the immediate next step or relevant blocked gate noted here.
3. Use applicable categories such as **Added**, **Changed**, **Fixed**, **Security**, **Removed**, **Verification**, and **Operational impact**. Omit empty categories.
4. Name the affected roadmap phase or task. Distinguish **Implemented**, **Verified locally**, **Verified on NAS**, **Verified on device**, and **Blocked**, as defined in `prompt.md`.
5. Record meaningful test commands, outcomes, and environment. Link to detailed evidence when available. Record failed or unavailable checks and their implications; “not run” is never a pass.
6. Note migrations, configuration changes, new dependencies, regeneration requirements, backup needs, and rollback constraints when relevant. Do not include secrets, credentials, or private media paths.
7. When an actual version is released, move its changes into a version-and-date section. Keep **Unreleased** for subsequent changes; do not invent a release tag or imply deployment merely because code was written.

### Future implementation entry template

Copy and fill only the fields relevant to real completed work. This example is a template, not a project event.

```markdown
### YYYY-MM-DD — Concrete change title

**Roadmap:** Phase N — task or milestone.
**Evidence level:** Implemented / Verified locally / Verified on NAS / Verified on device.

#### Added / Changed / Fixed

- Observable behavior delivered and why it matters.

#### Verification

- Command or manual scenario; environment; result; link to evidence if available.
- Checks not run, the reason, and any acceptance gate still open.

#### Operational impact

- Migration, configuration, storage, dependency, deployment, or rollback implications.

#### Remaining work

- Specific unresolved issue or blocked input and the next concrete task.
```
