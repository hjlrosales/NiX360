import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isoAfter, nowIso } from '../config.ts';
import { getRow, getRows, run, transaction } from '../db/sqlite.ts';
import { isPermanent, sanitizeError } from './errors.ts';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'paused' | 'cancelled' | 'retry_wait';
export type JobKind =
  | 'scan_root'
  | 'probe_media'
  | 'thumbnail'
  | 'hash_media'
  | 'video_rendition'
  | 'pair_companion'
  | 'pano_tiles';

export type Job = {
  id: string;
  kind: string;
  media_id: string | null;
  source_version: number | null;
  profile_version: string | null;
  dedupe_key: string;
  payload: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  progress: number;
  last_error: string | null;
  error_kind: 'transient' | 'permanent' | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

const ACTIVE_STATUSES = "('queued', 'running', 'retry_wait', 'paused')";

export type EnqueueInput = {
  kind: JobKind;
  dedupeKey: string;
  mediaId?: string | null;
  sourceVersion?: number | null;
  profileVersion?: string | null;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  nextRunAt?: string;
};

/**
 * Enqueues work unless an equivalent job is already active. Deduplication is
 * scoped to active jobs only, so completed work can be requested again (for
 * example a manual rescan) without replaying finished jobs.
 */
export function enqueue(db: DatabaseSync, input: EnqueueInput): string | null {
  return transaction(db, () => {
    const existing = getRow<{ id: string }>(
      db,
      `SELECT id FROM jobs WHERE dedupe_key = ? AND status IN ${ACTIVE_STATUSES} LIMIT 1`,
      input.dedupeKey,
    );
    if (existing) return null;

    const id = randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO jobs (id, kind, media_id, source_version, profile_version, dedupe_key, payload, status,
                         priority, attempts, max_attempts, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?)`,
    ).run(
      id,
      input.kind,
      input.mediaId ?? null,
      input.sourceVersion ?? null,
      input.profileVersion ?? null,
      input.dedupeKey,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 0,
      input.maxAttempts ?? 4,
      input.nextRunAt ?? now,
      now,
      now,
    );
    return id;
  });
}

/**
 * Claims the next runnable job with a single atomic statement. Claiming bumps
 * the attempt counter and installs an expiring lease so a crashed worker's job
 * becomes claimable again after recovery.
 */
export function claimNext(db: DatabaseSync, workerId: string, leaseMs: number): Job | null {
  const now = nowIso();
  const row = db
    .prepare(
      `UPDATE jobs
          SET status = 'running', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
              attempts = attempts + 1, updated_at = ?
        WHERE id = (
          SELECT id FROM jobs
           WHERE status IN ('queued', 'retry_wait') AND next_run_at <= ?
           ORDER BY priority DESC, next_run_at ASC
           LIMIT 1
        )
        RETURNING *`,
    )
    .get(workerId, isoAfter(leaseMs), now, now, now) as Job | undefined;
  return row ?? null;
}

export function heartbeat(db: DatabaseSync, jobId: string, workerId: string, leaseMs: number): boolean {
  const now = nowIso();
  return (
    run(
      db,
      `UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND lease_owner = ? AND status = 'running'`,
      now,
      isoAfter(leaseMs),
      now,
      jobId,
      workerId,
    ) === 1
  );
}

export function setProgress(db: DatabaseSync, jobId: string, workerId: string, progress: number): void {
  const bounded = Math.max(0, Math.min(1, progress));
  run(
    db,
    `UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'`,
    bounded,
    nowIso(),
    jobId,
    workerId,
  );
}

export function completeJob(db: DatabaseSync, jobId: string, workerId: string): boolean {
  const now = nowIso();
  return (
    run(
      db,
      `UPDATE jobs SET status = 'succeeded', progress = 1, lease_owner = NULL, lease_expires_at = NULL,
              last_error = NULL, error_kind = NULL, finished_at = ?, updated_at = ?
        WHERE id = ? AND lease_owner = ? AND status = 'running'`,
      now,
      now,
      jobId,
      workerId,
    ) === 1
  );
}

/**
 * Records a failure. Permanent errors and exhausted retries end as `failed`;
 * everything else is scheduled with exponential backoff.
 */
export function failJob(db: DatabaseSync, job: Job, workerId: string, error: unknown): JobStatus {
  const now = nowIso();
  const message = sanitizeError(error);
  const permanent = isPermanent(error);
  const exhausted = job.attempts >= job.max_attempts;
  const nextStatus: JobStatus = permanent || exhausted ? 'failed' : 'retry_wait';
  const backoffMs = Math.min(300_000, 5_000 * 2 ** Math.max(0, job.attempts - 1));

  run(
    db,
    `UPDATE jobs SET status = ?, error_kind = ?, last_error = ?, lease_owner = NULL, lease_expires_at = NULL,
            next_run_at = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND status = 'running'`,
    nextStatus,
    permanent ? 'permanent' : 'transient',
    message,
    nextStatus === 'retry_wait' ? isoAfter(backoffMs) : now,
    nextStatus === 'failed' ? now : null,
    now,
    job.id,
    workerId,
  );
  return nextStatus;
}

/**
 * Returns jobs whose lease expired (worker crash, container kill) to the queue
 * without incrementing attempts again.
 */
export function recoverExpiredLeases(db: DatabaseSync): number {
  const now = nowIso();
  return run(
    db,
    `UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
            next_run_at = ?, last_error = COALESCE(last_error, 'recovered expired lease'), updated_at = ?
      WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    now,
    now,
    now,
  );
}

export function retryJob(db: DatabaseSync, jobId: string): boolean {
  const now = nowIso();
  return (
    run(
      db,
      `UPDATE jobs SET status = 'queued', attempts = 0, next_run_at = ?, last_error = NULL, error_kind = NULL,
              lease_owner = NULL, lease_expires_at = NULL, finished_at = NULL, updated_at = ?
        WHERE id = ? AND status IN ('failed', 'cancelled', 'paused', 'retry_wait')`,
      now,
      now,
      jobId,
    ) === 1
  );
}

export function cancelJob(db: DatabaseSync, jobId: string): boolean {
  const now = nowIso();
  return (
    run(
      db,
      `UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
              finished_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'retry_wait', 'paused')`,
      now,
      now,
      jobId,
    ) === 1
  );
}

export function jobCounts(db: DatabaseSync): Record<string, number> {
  const rows = getRows<{ status: string; count: number }>(db, 'SELECT status, COUNT(*) AS count FROM jobs GROUP BY status');
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = Number(row.count);
  return counts;
}

export function listJobs(db: DatabaseSync, limit = 50): Job[] {
  return getRows<Job>(db, 'SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', Math.min(200, Math.max(1, limit)));
}

export function getJob(db: DatabaseSync, jobId: string): Job | undefined {
  return getRow<Job>(db, 'SELECT * FROM jobs WHERE id = ?', jobId);
}

/**
 * Global processing switch. It lives in the database so a restart or a second
 * worker cannot silently ignore an administrator's pause.
 */
export function isQueuePaused(db: DatabaseSync): boolean {
  const row = getRow<{ value: string }>(db, `SELECT value FROM app_settings WHERE key = 'queue.paused'`);
  return row?.value === 'true';
}

export function setQueuePaused(db: DatabaseSync, paused: boolean): void {
  run(
    db,
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('queue.paused', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    paused ? 'true' : 'false',
    nowIso(),
  );
}
