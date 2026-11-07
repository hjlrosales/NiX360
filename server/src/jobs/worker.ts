import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.ts';
import { claimNext, completeJob, failJob, heartbeat, isQueuePaused, recoverExpiredLeases, setProgress } from './queue.ts';
import { handlerFor, enqueueBacklog, enqueueMissingDerivatives } from './handlers.ts';
import { PermanentJobError, sanitizeError } from './errors.ts';
import { reconcileDerivatives } from '../media/thumbnails.ts';
import { enqueueDueScans } from '../media/scan.ts';

export type WorkerOptions = {
  db: DatabaseSync;
  config: AppConfig;
  signal: AbortSignal;
  leaseMs?: number;
  pollMs?: number;
  /** Process at most one job then return (used by tests). */
  once?: boolean;
  log?: (message: string) => void;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Single heavy worker loop. Jobs are claimed atomically with expiring leases so
 * another process can recover a crashed worker's work.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const { db, config, signal } = options;
  const leaseMs = options.leaseMs ?? 60_000;
  const pollMs = options.pollMs ?? 1_000;
  const log = options.log ?? (() => {});
  const workerId = `${os.hostname().slice(0, 32)}:${process.pid}:${randomUUID().slice(0, 8)}`;

  const recovered = recoverExpiredLeases(db);
  if (recovered > 0) log(`recovered ${recovered} expired job lease(s)`);
  const rebuilt = reconcileDerivatives(db, config);
  if (rebuilt > 0) log(`marked ${rebuilt} missing derivative file(s) for regeneration`);
  const backlog = enqueueBacklog(db);
  if (backlog > 0) log(`queued ${backlog} pending media item(s)`);
  // A restored catalog can be complete while the derivative volume is empty.
  // Startup reconciliation has marked those rows failed; re-queue a bounded
  // number so ready media becomes viewable again without a full rescan.
  const regenerated = enqueueMissingDerivatives(db);
  if (regenerated > 0) log(`queued ${regenerated} missing derivative set(s) for regeneration`);

  // Scheduled reconciliation never replaces manual scans; it only re-queues a
  // root whose last successful scan has aged out (or never completed).
  const scanIntervalMs = config.scanIntervalMinutes * 60_000;
  if (scanIntervalMs > 0) {
    const scheduled = enqueueDueScans(db, scanIntervalMs);
    if (scheduled.length > 0) log(`queued ${scheduled.length} scheduled reconciliation scan(s)`);
  }
  let lastScheduleCheck = Date.now();
  const scheduleCheckMs = 60_000;

  let pauseLogged = false;
  while (!signal.aborted) {
    // A paused queue is durable state: check it before every claim instead of
    // trusting an in-memory flag that a restart would lose.
    if (isQueuePaused(db)) {
      if (options.once) return;
      if (!pauseLogged) {
        log('queue is paused; worker is idle');
        pauseLogged = true;
      }
      await delay(pollMs);
      continue;
    }
    pauseLogged = false;

    if (scanIntervalMs > 0 && Date.now() - lastScheduleCheck >= scheduleCheckMs) {
      lastScheduleCheck = Date.now();
      const scheduled = enqueueDueScans(db, scanIntervalMs);
      if (scheduled.length > 0) log(`queued ${scheduled.length} scheduled reconciliation scan(s)`);
    }

    const job = claimNext(db, workerId, leaseMs);
    if (!job) {
      if (options.once) return;
      await delay(pollMs);
      continue;
    }

    const handler = handlerFor(job.kind);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const heartbeatTimer = setInterval(() => {
      if (!heartbeat(db, job.id, workerId, leaseMs)) controller.abort();
    }, Math.max(1_000, Math.floor(leaseMs / 3)));

    try {
      if (!handler) throw new PermanentJobError(`No handler registered for job kind ${job.kind}`);
      await handler({
        db,
        config,
        job,
        workerId,
        signal: controller.signal,
        reportProgress: (progress) => setProgress(db, job.id, workerId, progress),
      });
      const completed = completeJob(db, job.id, workerId);
      log(`job ${job.kind} ${job.id} ${completed ? 'succeeded' : 'lease lost before completion'}`);
    } catch (error) {
      if (signal.aborted) {
        // Shutdown: leave the job running so its lease expires and it is retried.
        log(`job ${job.kind} ${job.id} interrupted by shutdown`);
        break;
      }
      const status = failJob(db, job, workerId, error);
      log(`job ${job.kind} ${job.id} ${status}: ${sanitizeError(error)}`);
    } finally {
      clearInterval(heartbeatTimer);
      signal.removeEventListener('abort', onAbort);
    }

    if (options.once) return;
  }
}
