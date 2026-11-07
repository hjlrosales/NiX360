# Synology DS920+ deployment

Status: the application, container image, Compose topology and local smoke checks are implemented. **Nothing in this document has been executed on the owner's NAS.** DSM/Container Manager versions, shares, certificates, proxy behavior and real playback remain operator acceptance gates. Follow [operations.md](operations.md) for day-2 maintenance.

Examples use `/volume1/docker/nix360` and `nix.example.com`. Replace both; do not copy private hostnames, serial numbers, passwords or media names into the repository.

## Prerequisites

- Synology DS920+ (x86-64), DSM 7.2 or newer, Container Manager installed.
- At least 2 GB free on the Docker volume beyond the media library; the worker reserve defaults to 512 MB and the suggested production value is at least 2048 MB.
- Existing photo/video shares. They are mounted **read-only** and are never written by the app.
- An HTTPS hostname and certificate, or a private-access route (for example Tailscale) that provides HTTPS. PWA installation/service workers require a secure context.
- SSH access for ownership checks and the initial `id` lookup; Container Manager alone is enough for routine operation.
- The project files (or a built image) on the NAS or a workstation that can reach it.

## Directory layout

```text
/volume1/photo/                         -> /media/photos    read-only
/volume1/video/                         -> /media/videos    read-only
/volume1/docker/nix360/
  .env                                  not in source control
  docker-compose.yml
  data/
    library.sqlite
    derivatives/
    temp/
    backups/
```

The database must be on a local filesystem, not an SMB/NFS bind. WAL requires same-host access. Derivatives and temporary files must be on the same filesystem as their final paths so publication can use atomic rename.

Create and own the writable paths for the container's PUID/PGID:

```bash
# Run as the DSM administrator. Replace 1026:100 with the output of `id <user>`.
sudo mkdir -p /volume1/docker/nix360/data/{derivatives,temp,backups}
sudo chown -R 1026:100 /volume1/docker/nix360/data
sudo chmod 750 /volume1/docker/nix360/data
```

Media shares stay owned by their existing accounts and read-only to the container. Do not run `chown` over the media library.

## Build the image

The Compose file builds locally. On the NAS:

```bash
cd /volume1/docker/nix360
docker build --platform linux/amd64 -t nix360-media:local .
```

If building on a workstation, build for `linux/amd64`, save the image and load it in Container Manager/SSH. Pin the digest/tag used for the release and record it with the backup. A DS920+ J4125 does not support every acceleration path; baseline processing uses CPU only and the worker is limited to 1 CPU / 1 GiB.

## Configure `.env`

Start from `.env.example`. A production example:

```dotenv
NIX_DATA_HOST=/volume1/docker/nix360/data
MEDIA_PHOTOS=/volume1/photo
MEDIA_VIDEOS=/volume1/video
NIX_PUBLISH_PORT=8787
PUID=1026
PGID=100

NIX_MEDIA_ROOTS=[{"id":"photos","name":"Photos","path":"/media/photos"},{"id":"videos","name":"Videos","path":"/media/videos"}]
NIX_PUBLIC_ORIGIN=https://nix.example.com
NIX_COOKIE_SECURE=true
NIX_TRUST_PROXY=true

NIX_SESSION_IDLE_MINUTES=240
NIX_SESSION_ABSOLUTE_DAYS=30
NIX_LOGIN_RATE_LIMIT_MAX=10
NIX_STABILITY_WINDOW_SECONDS=60
NIX_SCAN_INTERVAL_MINUTES=0
NIX_MIN_FREE_MB=2048
```

Rules:

- `NIX_MEDIA_ROOTS` uses **container** paths (`/media/photos`), not DSM host paths.
- `NIX_DATA_HOST` and `MEDIA_*` are host paths consumed by Compose.
- Keep `NIX_PUBLISH_PORT` bound to loopback in the Compose file. Never publish 8787 on all interfaces.
- `NIX_TRUST_PROXY=true` is safe only while the app port is proxy-only; it makes forwarded scheme/host headers authoritative.
- `NIX_COOKIE_SECURE=true` with an HTTP origin prevents sign-in (cookies are not sent). Use HTTPS in production; plain HTTP is only for a disposable local smoke test.

File permissions: `.env` must not be world-readable and must never be committed. `chmod 600 /volume1/docker/nix360/.env`.

## Configure or bootstrap the administrator

There are no default credentials. The bootstrap requires an explicit password of at least 12 characters and refuses to replace an existing admin without `--force`.

```bash
cd /volume1/docker/nix360
docker compose run --rm \
  -e NIX_ADMIN_LOGIN=owner \
  -e NIX_ADMIN_PASSWORD='use-a-long-unique-passphrase' \
  app node server/src/scripts/bootstrap-admin.ts
```

The command writes the admin to the data volume and applies migrations. Sign in at the HTTPS origin afterwards. Do not keep the password in shell history on a shared account; use the Container Manager task environment or a temporary protected file.

For an owner account managed through `.env`, set all three values instead:

```dotenv
NIX_OWNER_LOGIN=owner
NIX_OWNER_DISPLAY_NAME=Owner
NIX_OWNER_PASSWORD=a-unique-passphrase-of-at-least-12-characters
```

At API startup the account is created if absent and kept enabled with the administrator role. An unchanged password is not rehashed and does not revoke sessions. To rotate it, edit `NIX_OWNER_PASSWORD`, then recreate the app container so Compose reloads `.env`:

```bash
docker compose up -d --force-recreate app
```

The changed password is hashed into SQLite and all existing sessions for that owner are revoked. The worker receives the same Compose environment but never reconciles accounts. This convenience keeps a plaintext credential in `.env` and exposes it to local Container Manager administrators through container inspection; prefer the one-time bootstrap when that tradeoff is unacceptable. Keep `.env` mode `600`, include it only in encrypted configuration backups, and never commit or paste it into logs.

## Start and verify

```bash
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8787/api/health
```

Expected: `{"status":"ok","database":"ok"}` and both services running, with the app `healthy`. The worker waits for the app health check, recovers expired leases, reconciles missing derivatives and resumes the queue.

Then:

1. Sign in as the admin.
2. **Admin → Media roots** should show both configured roots as healthy after the first scan.
3. **Scan now** for each root; watch **Admin → Jobs**.
4. Open a photo thumbnail, one video, and a verified 360° item.
5. Confirm the original media hash is unchanged and the source mount is still read-only (`docker inspect` shows `:ro`).

## Reverse proxy and certificate

Use the existing DSM reverse proxy or one Nginx instance. Keep the application on `127.0.0.1:8787`.

DSM outline (verify on the installed DSM version):

1. **Control Panel → Login Portal → Advanced → Reverse Proxy → Create**.
2. Source: HTTPS, `nix.example.com`, port 443.
3. Destination: HTTP, `localhost`, port 8787.
4. Attach the existing certificate; enable HTTP/2 if the proxy supports it.
5. Ensure `Host`, `X-Forwarded-For` and `X-Forwarded-Proto` reach the app. DSM versions differ; `NIX_PUBLIC_ORIGIN` makes CSRF independent of the protocol header, but the session cookie still needs the browser to use HTTPS.
6. Forward only the application virtual host. Do not expose DSM administration, SSH, SMB, Container Manager or port 8787.

Nginx example and header notes are in [https-proxy.md](https-proxy.md). The app sends HSTS; do not add a second HSTS header at the proxy. Certificate renewal remains a DSM/Nginx responsibility and is not tested here.

Firewall: allow 443 from the intended source only. Block 8787 externally. If using a private VPN/tunnel, keep the same application authentication and object authorization; the route does not replace them.

## Backups

Create the backup directory and schedule a consistent snapshot (see [operations.md](operations.md#backup)):

```bash
docker compose exec -T app node server/src/scripts/backup.ts \
  --out /data/backups/library-$(date +%Y%m%d-%H%M).sqlite
```

Use DSM Task Scheduler for daily execution and Hyper Backup/rsync for an encrypted off-device copy. Back up `.env` separately; it contains no media but does contain deployment configuration. Originals need their own independent backup policy — derivatives are regenerable, originals are not.

## Upgrade and rollback

1. Back up the catalog and `.env`; record the image digest.
2. Build/pull the new image and `docker compose up -d`.
3. Verify health, login, a thumbnail, a rendition and the admin queue.
4. If rollback is needed, stop both services, restore the previous image digest, and restore the pre-upgrade catalog when the newer migration is not readable by the older code. Migrations are forward-only.

Details and failure diagnosis: [operations.md](operations.md#upgrade) and [operations.md](operations.md#rollback).

## Operator acceptance checklist

These are **not** satisfied by local tests and must be recorded with dates, DSM/Container Manager versions, certificate/proxy details and device/browser versions.

- [ ] `docker compose config` and the image build succeed on the NAS.
- [ ] App and worker start non-root, with read-only root filesystems, dropped capabilities and resource limits.
- [ ] `/api/health` is healthy; both services restart without losing catalog state.
- [ ] An admin bootstrap, sign-in, scan, processing and authorized delivery work end to end on the NAS.
- [ ] Every private representation returns `401` without a session; Range/HEAD/416 work through the proxy.
- [ ] Original sample hashes are unchanged after scanning and playback.
- [ ] A consistent backup restores into an isolated location; at least one derivative regenerates.
- [ ] The app port is unreachable externally; DSM/SSH/SMB are not exposed through the application hostname.
- [ ] Certificate issuance/renewal and HTTPS redirects work for the real hostname.
- [ ] Remote playback is measured over the real route for at least 30 minutes; no invented throughput claims.
- [ ] PWA installation and offline-shell behavior are checked on physical iOS/Android; gyroscope, touch, background/resume and safe areas are recorded.
- [ ] A real DJI OSV/LRF/export and a real HDR/D-Log M sample are checked; conversion-required and color labels are honest.
- [ ] Recovery duration and the original-media backup objective are measured and agreed before calling this production-ready.

Until those are recorded, the repository is a **locally verified deployment candidate**, not a NAS-verified production deployment.
