# Phase 0 — Discovery and technical validation

Status: **partial**. Local environment and supplied sample media were inspected. The NAS was not inspected directly; the owner supplied its hardware summary (recorded below). Network path, DSM configuration and physical devices remain unverified. Claims below are limited to what was actually run or supplied.

Date: 2026-11-05 (Asia/Manila).

## Development environment (verified)

| Item | Observed |
|---|---|
| OS | Windows (win32), commands run in Git Bash |
| Node.js | v26.8.2 (server runs TypeScript natively via type stripping; `node:sqlite` available) |
| npm | 11.19.0 |
| FFmpeg/ffprobe | 9.0.1-full_build (gyan.dev), GPL build with libx264/libx265, HEVC and Vulkan/VAAPI/AMF/CUDA support compiled in |
| Docker | 29.6.2 client available |
| ESLint | 10.14.0 flat config with `@eslint/js` 10.0.1, typescript-eslint 8.72.1 and globals 17.14.0 (dev-only; `npm run lint`) |
| ExifTool | **not installed locally**; the container image installs `libimage-exiftool-perl` |
| SQLite | via `node:sqlite` (`DatabaseSync`), WAL and savepoints verified |

## NAS hardware (supplied by the owner from DSM, 2026-11-05)

| Item | Reported value |
|---|---|
| Model | Synology DS920+ |
| Serial number | `2160TERCXRA2M` |
| CPU | Intel Celeron J4125, 4 cores, 2 GHz |
| Total physical memory | **12 GB** (not the 4 GB base configuration) |
| Thermal status | Normal |
| Fan speed mode | Cool mode |

Implications, recorded as expectations rather than measurements:

- 12 GB RAM clears the main memory concern for 8K JPEG decode/probing, but peak worker RSS still has to be measured before raising the 1 GiB worker cap. The cap stays as configured until a benchmark exists.
- A J4125 (4 cores, no Hyper-Threading) is the same class of CPU assumed by the roadmap; software transcoding of 119 Mb/s 100 fps HEVC remains impractical, so the DJI export route and lower-resolution derivatives stay the plan.
- The serial number is recorded for inventory only. It must not be published in screenshots, logs, or support requests.

Still unverified on the NAS: DSM version, Container Manager/Docker version, filesystem and volume layout, free space, share paths and UID/GID mapping, `/dev/dri` presence or usable hardware decode/encode, existing reverse proxy/HTTPS configuration, current workloads, network upload/download, CGNAT status, physical phones/tablets.

## Sample media (owner-provided, read-only)

Hashes are SHA-256 of the supplied files.

| File | Size | SHA-256 |
|---|---|---|
| `CAM_20261027103139_0014_D.OSV` | 106,919,206 B | `323f05d3234e43223401130f0c09be876ad826e17e8e5e7658307a27a901e0fd` |
| `CAM_20261027103139_0014_D.LRF` | 7,808,910 B | `3e8425ab505a56707471babac583bb2d056b8d590ca45d39f14d73bfbb06203a` |
| `CAM_20261027135051_0053_D.JPG` | 14,741,504 B | `ecд7864bff2fa3d3b171cef2cbc108722e56c71c8e515e939a78094559aa64d9` |

### Probe results

**`.JPG` — DJI Osmo panorama**

- 15520 × 7760, 2:1, baseline JPEG, `yuvj420p`, 8-bit, ~295 Mb/s single image.
- XMP: `GPano:ProjectionType="equirectangular"`, `UsePanoramaViewer="True"`, full panorama 15520 × 7760.
- Camera tags: `Osmo OQ001`.
- Declaration is explicit, so classification does not rely on the 2:1 ratio.

**`.LRF` — low-resolution companion video**

- MP4/MOV container, brand `isom/iso2/avc1/mp41`, `encoder=Osmo 360`.
- Streams: H.264 High L5.2 2048 × 1024 @ 25 fps (7.16 s), AAC LC 48 kHz stereo, two `CAM meta` data streams, one 688 × 344 MJPEG thumbnail stream.
- H.264 8-bit + AAC in MP4 is a browser-compatible baseline, so direct play can be offered after probing (no derivative needed initially).

**`.OSV` — raw panoramic video**

- MP4/MOV container, 8 streams, ~119.3 Mb/s, 7.168 s, `encoder=Osmo 360`.
- Streams: **two** HEVC Main 10 1920 × 1920 @ 100 fps video streams (dual fisheye), AAC audio, four data streams, one 688 × 344 MJPEG thumbnail stream.
- No spherical metadata and no stitched equirectangular frame. FFmpeg does not perform the camera-specific stitching.
- Handling: catalogue as `dual_fisheye` → `unsupported` with a conversion-required reason. A full-sphere export from DJI Studio (verified on a capable desktop) is the supported route; provenance will be stored in `media_relations`.

## Decisions taken from this evidence

1. Projection classification must prefer file metadata; 2:1 alone maps to `unknown` + `aspect_hint`.
2. Raw OSV is never relabelled or presented as playable.
3. Video direct-play is decided from container/codec/bit-depth, not the extension (the `.LRF` extension is a DJI convention around an MP4 file).
4. HEVC Main 10 at 100 fps cannot be a playback baseline; it stays an original until an H.264 derivative exists.
5. The 15,520 × 7,760 JPEG needs tiled delivery; a single full-resolution texture is not acceptable on phones. The preview derivative is capped at 4096 px wide, and Phase 3 `pano-sq-v1` cube tiles are now generated (source capped to 8192 × 4096, 2048 px faces, 126 WebP tiles). The real sample has not yet been through the job or a browser.

## Open gates

- **NAS**: no inspection, no deployment, no benchmark. Hardware transcoding, real free space and UID/GID mapping are unverified.
- **Viewers**: Pannellum, Marzipano and Photo Sphere Viewer have not been compared with these samples on real devices.
- **Devices**: no iOS/Android/desktop browser testing; gyroscope, fullscreen and background/resume behaviour unknown.
- **Video derivatives**: no encoder profile has been benchmarked; HLS is not implemented.
- **ExifTool on NAS**: installed in the image but not yet exercised against real photos there.
- **Network**: sustained upload/download and remote route unmeasured.
- **Restore drill**: an isolated local restore from `npm run backup` was verified on 2026-11-05; no NAS restore, derivative rebuild or measured recovery time exists.
- **HTTPS/proxy**: the app's cookie, CSRF and forwarded-header behaviour and a local self-signed TLS terminator were verified on 2026-11-05; no DSM reverse proxy, certificate issuance/renewal, external route or throughput test exists.
