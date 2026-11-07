# Operations runbook

Status: locally verified procedures are marked below. NAS and external-network execution remains an operator acceptance step; see [synology-deployment.md](synology-deployment.md).

All commands assume the project directory holds `docker-compose.yml` and a `.env` with production values. Never paste `.env` contents or passwords into tickets, screenshots or logs.

## Health and routine checks

```bash
docker compose ps
curl -fsS http://127.0.0.1:8787/api/health
docker compose logs --tail=100 app worker
```

Healthy means both services are `running`, the app is `healthy`, and `/api/health` returns `200 {"status":"ok","database":"ok"}`. The app and worker share one SQLite file. The worker being briefly idle is normal; paused is visible in **Admin** or through durable state.

Useful admin responses, all authenticated as an administrator:

- `GET /api/admin/status` — processing counts, queue state, roots, free bytes, unsupported items.
- `GET /api/admin/jobs` — queued/running/retry/failed jobs with sanitized errors.
- `GET /api/admin/unsupported` — files that need conversion or failed probing.
- `GET /api/admin/duplicates` — evidence only; nothing is deleted automatically.

## Restart and shutdown

```bash
docker compose restart app worker    # transient processes; state stays in /data
docker compose stop app worker       # stop both before copying/restoring the database
docker compose up -d                 # start; migrations apply at startup
```

The worker recovers jobs whose 60-second lease expired, reconciles derivative files that disappeared, and re-queues a bounded backlog. An interrupted FFmpeg encode restarts that rendition; there is no frame-level continuation.

### Rotate an environment-managed owner password

If `NIX_OWNER_PASSWORD` is configured, edit it in the protected `.env`, then use `docker compose up -d --force-recreate app`. A plain `docker compose restart` does not reload environment-file values. The API updates the Argon2id hash before listening and revokes the owner's existing sessions; the password itself is never logged. Verify a fresh sign-in, then update the encrypted `.env` backup.

## Scans and jobs

- **Admin → Media roots → Scan now**, or `POST /api/admin/roots/<id>/scan` as an administrator, queues a scan.
- Scheduled reconciliation uses `NIX_SCAN_INTERVAL_MINUTES`; `0` disables it. Scheduling does not replace manual scans.
- A missing/unreadable root becomes `unavailable` and tombstones nothing. Restore the mount and scan again.
- Pause the queue from **Admin** before heavy maintenance. Pause state survives restarts.
- A failed job can be retried from **Admin**; permanent unsupported states need a conversion/export, not blind retries.

### Disk reserve

`NIX_MIN_FREE_MB` (default 512) refuses new thumbnail, encode and tile work when the data filesystem is below the reserve. The job is retried later as a transient failure; the source is not marked failed. Free space is shown on the admin page. Disabling the reserve with `0` is appropriate only for a disposable test.

Space accounting: derivatives are regenerable, originals are not. Never delete or rewrite originals during cleanup. Delete only known generated assets under `NIX_DERIVATIVES_DIR`/`NIX_TEMP_DIR`, and only when no job or playback is using them. A source-version change already removes superseded version directories through normal processing.

## Backup

The catalog, users, overrides, relationships, favorites, albums, history and durable settings live in SQLite. Derivatives can be regenerated; originals live on read-only mounts and need their own independent backup policy.

### Consistent database snapshot

```bash
mkdir -p /volume1/docker/nix360/backups
docker compose exec -T app node server/src/scripts/backup.ts \
  --out /data/backups/library-$(date +%Y%m%d-%H%M).sqlite
```

The script uses SQLite's online backup API, verifies page integrity and foreign keys on a temporary copy, then publishes by rename. Do not copy only the live `library.sqlite` file while WAL is active. Do not use `--force` with a timestamped destination; an existing backup is never overwritten implicitly.

Schedule this with DSM **Control Panel → Task Scheduler** (user-defined script) after confirming the Container Manager `docker compose` path, and retain copies off the NAS. A NAS-local copy is staging, not disaster protection. Back up `.env` separately in an encrypted store because it contains the cookie/origin configuration; never commit it.

Suggested initial objective: at most 24 hours of catalog/config loss. This is a proposed objective, not a measured guarantee.

## Restore

1. Take a fresh snapshot of the current catalog and copy it aside as the rollback point.
2. `docker compose stop app worker`.
3. Keep the old `library.sqlite`, `-wal` and `-shm` files; do not overwrite the only copy.
4. Copy a verified backup to `NIX_DATA_HOST/library.sqlite`, remove stale `library.sqlite-wal`/`library.sqlite-shm` beside it, and make the file readable/writable by `PUID:PGID`.
5. `docker compose up -d`. Migrations apply only when the backup predates the code.
6. Check `/api/health`, sign in, and verify gallery counts, relationships, favorites/albums/history and overrides.
7. If the derivative volume was also lost, the worker startup marks missing derivative rows failed and queues a bounded regeneration set. Watch **Admin → Jobs** until thumbnails return. Originals are never re-encoded as part of this repair.

Local evidence (2026-11-06): a restored catalog with a deleted thumbnail file was reconciled by the worker and the thumbnail was regenerated without rescanning or touching the source. The isolated database restore drill is in `server/tests/backup.test.ts`; NAS restore and recovery-time measurement remain operator gates. Do not claim a recovery-time objective until measured on the DS920+.

## Upgrade

1. Back up the catalog and `.env`; record the currently running image tag/digest.
2. Review the latest [changelog](../changelog.md) for migrations and operational changes.
3. Build or pull the new image, then `docker compose up -d`.
4. Migrations run at startup inside transactions and are recorded in `schema_migrations`.
5. Verify health, sign-in, one thumbnail, one video rendition and an admin scan queue.

## Rollback

1. Stop the app and worker.
2. Restore the previous image tag/digest.
3. Restore the pre-upgrade database snapshot if the new version applied a migration that the old code cannot read. Migrations are forward-only; do not assume an older image can open a newer schema.
4. Start, verify health and catalog counts, then resume processing.

Keep the pre-upgrade backup until the new version has passed its acceptance checks. Image rollback without a compatible database restore is not a complete rollback.

## Failure diagnosis

| Symptom | Check | Action |
|---|---|---|
| `/api/health` 503 or `database:error` | `docker compose logs app`; data path ownership; free space | Restore the data mount, fix `PUID:PGID` or free space, restart. Do not delete the database. |
| App healthy, library empty | Admin roots health; `NIX_MEDIA_ROOTS` container paths; scan jobs | Fix mount/path, rescan. A missing root is not proof of deletion. |
| Worker idle but jobs queued | Queue paused; worker logs; container limits | Resume the queue; inspect the failed job's sanitized error; increase limits only with measured evidence. |
| Jobs stay `retry_wait` with free-space error | `NIX_MIN_FREE_MB`; data volume usage | Free generated space or move data; do not disable the reserve in production. |
| `SQLITE_BUSY` repeatedly | Database on SMB/NFS; long transactions; competing processes | Move the database to a local filesystem, keep one API and one worker, restart. |
| Thumbnails/videos 404 after restore | Derivative files missing; admin jobs | Worker startup repairs a bounded set; retry/scan if the item remains unavailable. |
| PWA will not install | HTTPS, manifest, service worker registration | Use HTTPS (or localhost); check DevTools → Application; installation is not available on every browser. |
| Offline thumbnails absent | Settings toggle; Cache Storage; account switch/logout | Re-enable for the current account. Signing out intentionally deletes them. |
| Login rejects a correct password | Account disabled; login rate limit; cookie origin/scheme | Check the user's enabled state, wait for the rate window, confirm `NIX_PUBLIC_ORIGIN` and proxy scheme. |

## Security operations

- Keep port 8787 on `127.0.0.1`; only the reverse proxy should be externally reachable.
- Do not expose DSM (5000/5001), SSH, SMB, Container Manager or the SQLite file.
- The API and worker run as `PUID:PGID`, read-only root filesystems, no added capabilities and `no-new-privileges`.
- Rotate an exposed admin password immediately, which revokes that user's other sessions.
- `npm audit --omit=dev` must be reviewed on each dependency change. The 2026-11-06 upgrade removed all reported production advisories; that is point-in-time evidence, not a guarantee.
