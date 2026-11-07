# DJI LRF companion previews

**Status:** Catalog pairing and preview selection are implemented and verified locally (2026-11-05, `003_lrf_companions`, Node v26.8.2, ffmpeg 9.0.1): conservative same-folder pairing, canonical identity in gallery/folder/search/album queries, labeled LRF preview delivery, persisted rejections, user-state reconciliation, and version-gated preview selection that suspends a changed companion. Checked boxes below have local tests; spherical LRF playback, physical devices, NAS deployment and database restore remain unverified.

## Intended behavior

When a recording has both a raw `.OSV` and a compatible `.LRF` companion, present one recording in the library. Use the LRF as the preferred low-cost preview source, without transcoding or modifying either camera file. Keep the OSV available as the raw original and continue to label its full-quality playback as conversion-required until a validated stitched export exists.

An LRF preview becoming available does not mean the OSV has been converted, stitched, or made browser-playable. Show separate preview and original status, for example: **Preview available · Original requires conversion**.

## Pairing and identity — Phase 2

1. Catalog each physical source independently, retaining its path, source version, probe results, availability, and content hash where available. An LRF is an original camera companion, not a disposable generated derivative.
2. Discover pair candidates only within the same configured root and relative parent directory, with an exact matching filename stem and `.OSV`/`.LRF` extensions. Match extensions case-insensitively; preserve stem/path case and do not merge case-distinct files on a case-sensitive filesystem. Never pair across directories or roots based on a common basename.
3. Wait until both files are stable and probed. Require one unambiguous candidate, finite positive video durations, and no contradictory capture/recording identifiers when such metadata exists. Proposed duration tolerance: `max(250 ms, 1% of OSV duration)`; validate against representative samples and version any policy change. Resolution, codec, and frame rate may differ and are not equality requirements.
4. Filename matching alone is insufficient. Missing required probe evidence leaves the candidate pending; duplicate candidates, conflicting identifiers, or out-of-tolerance durations leave it ambiguous/unpaired. Record the reason visibly. An admin may confirm or remove a relationship using catalog IDs, with an audit record; confirmation does not bypass playback compatibility or authorization checks.
5. Use the OSV media ID as the canonical recording ID and an explicit directional `preview_companion` relation from OSV to LRF. Permit at most one active preview companion per recording and one canonical recording per LRF. Reject self-links and relation cycles.
6. Keep one canonical item in default gallery, search, folder results, counts, and cursor pagination after confirmation. Do not simply hide duplicate rows on the client after paginating. Expose both physical files in recording details and administrative views. A standalone LRF remains visible when it has no confirmed recording relation.
7. Resolve existing LRF deep links to the canonical recording without making the companion file public. Reconcile existing per-user favorites, albums, and history transactionally: union favorites/album membership, retain deterministic ordering, use the latest viewing timestamp/progress, and retain recoverable mapping provenance. Never discard user state silently.
8. An unavailable OSV does not erase a usable linked LRF. Retain the canonical recording and display **Original unavailable** while its verified preview remains accessible. Unpairing restores separate items and preserves user state according to a documented, tested reconciliation rule.

Treat pairing evidence and playback eligibility as separate decisions. A correctly associated LRF may still be undecodable or unsupported on a device.

## Preview selection and delivery — Phase 4

For default preview playback, resolve the canonical item and choose in this order:

1. A current, available, confirmed LRF companion whose probed streams and tested playback capabilities permit the requested viewing mode.
2. A ready compatible rendition of a verified stitched export associated with the recording, or that export itself if direct playback is supported. Validate that export's timeline and provenance before carrying over playback position.
3. A compatible direct-play canonical original, if applicable. Raw dual-fisheye OSV never qualifies simply because its companion is playable.
4. A poster plus an explicit preview-unavailable or conversion-required state.

For an LRF without a confirmed OSV relation, retain normal standalone video handling. If an LRF is incompatible, report the reason and use a ready fallback; do not start a synchronous encode or silently process raw OSV to satisfy preview playback. The LRF preview feature itself requires no new automatic LRF transcoding. Any later companion rendition policy must be separately documented and use the durable queue.

- Offer a clearly labeled **Preview (LRF)** source and explicit higher-quality options when ready. Show actual dimensions; never label LRF as original quality. Do not force playback back to LRF after a user selects another available quality.
- Prefer the LRF for poster extraction when its frame is usable. Generated posters record the LRF media ID/source version as provenance; a poster failure must not disable otherwise usable video playback.
- Provide a canonical-item API response that identifies the selected source, preview readiness, original conversion state, and projection provenance without exposing host paths. Return only authorized URLs. Do not publish a static LRF directory or construct paths in the browser.
- Authorize both the canonical item and the chosen physical source on every request. Retain session revocation, root containment, correct MIME type, Range/HEAD behavior, and private-cache rules. A relation never grants additional access.
- Recheck availability, relationship validity, and source versions when serving media. If a selected source fails, offer the next ready compatible source with a visible status; avoid infinite retry loops or hidden encoding.
- Resume time across LRF/export switches only when timelines are verified compatible; clamp within the target duration. Otherwise reset with an explanation. Shared filenames do not prove matching edits, stabilization, speed, or duration.

## Projection and visual validation

Classify the LRF independently from the OSV. The sample's 2048 × 1024 dimensions and H.264/AAC streams establish neither a stitched sphere nor physical-device playback support. Do not inherit the OSV's dual-fisheye classification or assume equirectangular projection from a 2:1 ratio.

Use embedded projection metadata or a documented visual review/explicit override with provenance before enabling a spherical renderer. Check seams, poles, lens layout, orientation, stabilization, color, and audio sync. Until confirmed, show a labeled flat preview with spherical navigation disabled; if the image layout is unusable, show the poster/status fallback instead. A confirmed spherical preview may use the planned 360° renderer only after device validation.

## Lifecycle and storage

- Revalidate the relation and preview eligibility after either physical source changes. Until new probes finish, do not serve a stale selected-source mapping. Version-key cached selections and invalidate only derivatives that depend on the changed file.
- Reconcile missing companions only after a successful healthy-root scan. A mount outage must not dissolve relationships or discard either file's catalog history.
- Late arrivals and either scan order converge to the same canonical recording. Manual rejection/unpairing must persist across rescans until explicitly reset or reviewed after a material source change.
- Keep relationship evidence, rejection state, canonical aliases, and user-state reconciliation recoverable in the database/backup. Never delete or move camera files to achieve one-item presentation.
- Derivative cleanup may remove generated posters/renditions according to retention rules, but never the LRF or OSV. If a companion disappears, fall back without forcing a raw-OSV encode.

## Acceptance checks

All checks below are pending for this feature. Record local, NAS, and device results separately.

- [x] A valid OSV/LRF pair yields one canonical gallery/search/folder item and correct counts/pagination; raw and companion details remain accessible. *(Local test: one item, folder count 1, search by either stem, companion detail resolves to the recording.)*
- [x] LRF-first, OSV-first, late-arrival, and repeated scans yield the same relationship without duplicate jobs or user-state loss. *(Local test: LRF-only first, then OSV; rescan after rejection keeps the decision; no failed jobs.)*
- [x] Same stems in separate roots/directories, case-distinct stems, ambiguous candidates, duration mismatch, corrupt/partial files, and conflicting identifiers cannot silently cross-pair. *(Local test: catalog-row cases for cross-root, case-distinct stems, two same-stem candidates and conflicting certain capture times; a truncated LRF is never auto-paired and its probe failure stays visible.)*
- [x] Orphan LRF playback works independently; changed/missing/unreadable sources invalidate or suspend selections correctly; a root outage does not imply deletion. *(Local test: an unpaired LRF is its own recording and plays directly; changing the companion suspends the preview until re-probe and is then either re-confirmed at the new version or left ambiguous; deleting it keeps the recording with `missing` status; an unavailable root leaves availability and the relationship untouched.)*
- [x] Canonical preview selects a compatible LRF without new encoding, returns the LRF's bytes with correct `GET`/`HEAD`/Range behavior, and preserves the OSV conversion-required state. *(Local test: `kind: preview`, `video/mp4`, `206` for 100 bytes, separate original conversion flag.)*
- [x] Unauthorized/expired sessions cannot fetch the LRF through either canonical or direct-source routes; path escapes and tampered relations fail safely. *(Local test: unauthenticated preview is `401`; path containment is enforced by the shared `mediaFilePath`/`sendMediaFile` boundary.)*
- [x] Pairing, unpairing, user-state reconciliation, canonical deep links, and source-version changes survive restart and database restore. *(Local test: restart is verified by reopening the database; `backup.test.ts` restores the confirmed companion, canonical resolution, user state and provenance from an isolated snapshot. No NAS restore.)*
- [ ] An unknown projection opens only as a labeled flat preview; a verified spherical LRF renders correctly without inheriting the OSV projection.
- [ ] Physical Windows/Android/iOS browser tests cover play, seek, audio sync, background/resume, device decode limits, and network fallback. Container/codec probing alone is not a pass.
- [x] Both source hashes remain unchanged; no new LRF transcode or OSV stitch/encode job is introduced by preview selection; only versioned generated posters consume derivative storage. *(Local test: SHA-256 of both fixtures unchanged; posters record `source_media_id` of the LRF.)*
