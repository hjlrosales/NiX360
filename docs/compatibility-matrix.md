# Media compatibility matrix

Based on actual probes of the supplied samples (see [discovery.md](discovery.md)) plus the code paths implemented in this iteration. "Browser playable" is a statement about container/codec, not a device test — no physical device has been tested yet.

| Input | Detected | Current handling | Browser playable? | Next action |
|---|---|---|---|---|
| JPEG, flat | sharp dimensions, EXIF orientation applied to derivatives | thumbnail (400 px) + preview (1600 px), `flat` projection | Yes (original and preview) | Physical-device check of orientation/color |
| JPEG, DJI panorama 15520 × 7760 | XMP `GPano:ProjectionType=equirectangular` | `equirectangular`, 4096 px preview plus a `pano-sq-v1` cube pyramid (126 WebP tiles) and lazy Pannellum viewer; flat preview until tiles are ready | Interactive path implemented; tiles, input modes and failure recovery exercised in headless Chrome on 2026-11-06 | Physical-device seam/pole/gesture check |
| 2:1 image without spherical metadata | aspect hint only | `projection='unknown'`, `projection_source='aspect_hint'`; no tiles are generated | Yes as a flat image | Manual classification override UI |
| PNG/WebP/TIFF/BMP/GIF | sharp decode | thumbnail + preview | Yes (derivatives) | Verify transparency and 16-bit handling |
| HEIC/HEIF | sharp build dependent | if decode fails → `unsupported` + reason | Only if derivatives exist | Test with a real HEIC sample and the image's libvips build |
| MP4/MOV H.264 8-bit + AAC (e.g. `.LRF`) | ffprobe | `direct_play=true`, poster generated, original streamed with Range | Yes | Device playback + seek verification |
| MP4/MOV HEVC (flat) | ffprobe | `unsupported` ("needs H.264 derivative") — not silently played | Safari only, unverified | Phase 4: H.264 baseline derivative |
| HDR (PQ/HLG) or BT.2020 video | ffprobe `color_transfer`/`color_primaries` | stored explicitly, never direct-play; the SDR H.264 rendition is tone-mapped through linear light and published with BT.709 tags; the viewer labels `HDR HLG/PQ source · tone-mapped to SDR` | The SDR rendition only | Real DJI D-Log M/HDR sample and device colour check |
| DJI `.OSV` (dual-fisheye HEVC 10-bit) | two equal square video streams; a `.osv` that ffprobe cannot parse is still recorded | `dual_fisheye`, `unsupported`, conversion guidance stored; an unparseable `.osv` is `unsupported` with the same DJI export guidance instead of staying `pending`. A linked equirectangular export supplies labeled playback while the original stays conversion-required | Export only, through a linked full-sphere export | Import a DJI Studio export and link it in **Admin → Spherical exports** (API-tested; real export not yet run) |
| Truncated/corrupt media | probe throws | `failed` with a sanitized reason, `retryable` in the API experience | No | Administrator retries after checking the source copy |
| Equirectangular MP4 with spherical side data | ffprobe `side_data_list` | `equirectangular` + direct-play rules; playback options report `spherical`; an in-page WebGL stage wraps the frame around a sphere with drag/pinch/wheel/key controls, play/seek/mute/immersive; sphere renditions must stay 2:1 | Interactive path implemented; mapping, navigation, playback, immersive and context recovery verified in headless Chrome 2026-11-06 | Real DJI export, device playback, audio sync and quality switching in the app |
| MKV/AVI/WebM/3GP | extension allowlist, ffprobe | catalogued; direct play only if H.264/AAC in MP4/MOV container | Rarely | Derivative pipeline (Phase 4) |
| Unknown/proprietary projections | no metadata | `unknown`; no conversion claims | No | Keep visible as unsupported with reason |
| Non-media files, hidden files, symlinks | scan policy | skipped, counted in scan stats | — | None |

## Planned paired LRF previews

The standalone `.LRF` row above describes local probe/delivery support only. Automatic OSV/LRF association, a single canonical gallery item, and preferred LRF preview playback are **pending** under [lrf-preview.md](lrf-preview.md). The paired feature must leave the OSV conversion-required state intact, classify LRF projection independently, and use a labeled flat preview until spherical layout is confirmed. Physical-device playback, spherical rendering, source switching, and fallback behavior require separate acceptance evidence.

## Rules encoded in the implementation

- Extension and aspect ratio never establish codec support or a spherical projection.
- Raw OSV is preserved and labelled conversion-required.
- A probe that cannot read a file is recorded as `failed` (retryable); an unparseable raw OSV is recorded as `unsupported` with DJI export guidance. Neither is left looking like it is still processing.
- The media-detail `experience` object (`ready`, `processing`, `conversion_required`, `failed`) is derived on the server; clients do not infer playback outcomes from `processing_state` alone.
- A 2:1 sphere is never squeezed into 16:9; panorama previews keep 2:1. A published rendition must decode to its planned size, and an equirectangular source must stay 2:1 within 2% or the job fails.
- A spherical video renders in the WebGL stage; when WebGL is unavailable the viewer shows an explanation and falls back to the flat video with native controls.
- A linked stitched export is version-gated: if either the raw original or the export changes, its playback disappears until an administrator re-confirms the link. Raw originals are never decoded or exported by the server.
- Panorama tiles are generated only for a confirmed equirectangular projection at least 4096 px wide; the 4096 px preview stays available as the fallback.
- The interactive viewer is not evidence of correct geometry on a device: seams, poles, horizon, drag/pinch and gyroscope still need a browser and physical phones.
- Audio sync and stabilization for DJI exports remain unverified until Phase 4 device tests. HDR/wide-gamut conversion is implemented and verified locally with a generated HLG clip: the source is classified from its transfer/primaries, excluded from direct play, and the rendition is tagged BT.709 after tone-mapping. A real DJI D-Log M file and device colour rendering remain unverified.

## Device / browser status

| Platform | Status |
|---|---|
| Windows Chrome/Edge | Photo panorama exercised in desktop Chrome (2026-11-05); viewer input modes and failure notices in headless Chrome (2026-11-06); spherical video stage verified in headless Chrome (2026-11-06) with a generated clip |
| Android Chrome | Untested |
| iOS Safari | Untested; HEVC/`.OSV`/HLS behaviour unknown |
| Tablet | Untested |
