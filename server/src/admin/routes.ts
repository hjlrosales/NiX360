import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.ts';
import { nowIso } from '../config.ts';
import { getRow, getRows, run } from '../db/sqlite.ts';
import { audit, requireAdmin } from '../auth/routes.ts';
import { hashPassword, passwordProblem } from '../auth/password.ts';
import { revokeUserSessions } from '../auth/session.ts';
import { cancelJob, enqueue, isQueuePaused, jobCounts, listJobs, retryJob, setQueuePaused } from '../jobs/queue.ts';
import { duplicateSummary, listDuplicateGroups } from '../media/hash.ts';
import { enqueueScan } from '../media/scan.ts';
import { THUMBNAIL_RECIPE } from '../media/thumbnails.ts';
import {
  linkExport,
  listExportCandidates,
  listExportLinks,
  listExportOriginals,
  unlinkExport,
} from '../media/exports.ts';
import {
  companionSummary,
  confirmCompanion,
  listCompanionChecks,
  listCompanionRelations,
  loadCompanionMedia,
  rejectCompanion,
  resetCompanion,
} from '../media/companions.ts';

export type AdminDeps = { db: DatabaseSync; config: AppConfig };

export function registerAdminRoutes(app: FastifyInstance, { db, config }: AdminDeps): void {
  app.get('/api/admin/status', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;

    const mediaCounts = getRows<{ media_type: string; processing_state: string; count: number }>(
      db,
      'SELECT media_type, processing_state, COUNT(*) AS count FROM media GROUP BY media_type, processing_state',
    ).map((row) => ({ ...row, count: Number(row.count) }));

    const roots = getRows<Record<string, unknown>>(
      db,
      `SELECT id, name, mount_path, health, last_scan_id, last_success_at FROM library_roots ORDER BY name`,
    ).map((root) => ({
      id: root.id,
      name: root.name,
      health: root.health,
      lastScanId: root.last_scan_id,
      lastSuccessAt: root.last_success_at,
    }));

    let freeBytes: number | null = null;
    try {
      const stats = await fs.promises.statfs(config.dataDir);
      freeBytes = stats.bavail * stats.bsize;
    } catch {
      // Free space is reported as unknown rather than failing the dashboard.
    }

    const unsupported = getRow<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count FROM media WHERE processing_state IN ('unsupported', 'failed')`,
    );
    const duplicates = duplicateSummary(db);

    return reply.send({
      media: mediaCounts,
      jobs: jobCounts(db),
      roots,
      unsupportedCount: Number(unsupported?.count ?? 0),
      duplicateGroups: duplicates.groups,
      duplicateReclaimableBytes: duplicates.reclaimableBytes,
      companions: companionSummary(db),
      queuePaused: isQueuePaused(db),
      dataFreeBytes: freeBytes,
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      exiftoolConfigured: config.exiftoolPath !== null,
    });
  });

  app.get('/api/admin/jobs', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    const query = request.query as { limit?: string };
    const limit = Number(query.limit ?? 50);
    return reply.send({
      jobs: listJobs(db, Number.isFinite(limit) ? limit : 50).map((job) => ({
        id: job.id,
        kind: job.kind,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        progress: job.progress,
        lastError: job.last_error,
        nextRunAt: job.next_run_at,
        createdAt: job.created_at,
        mediaId: job.media_id,
      })),
    });
  });

  app.post('/api/admin/jobs/:id/retry', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    const { id } = request.params as { id: string };
    if (!retryJob(db, id)) return reply.code(409).send({ error: 'not_retryable' });
    audit(db, admin.id, 'admin.job_retry', id);
    return reply.send({ ok: true });
  });

  app.post('/api/admin/jobs/:id/cancel', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    const { id } = request.params as { id: string };
    if (!cancelJob(db, id)) return reply.code(409).send({ error: 'not_cancellable' });
    audit(db, admin.id, 'admin.job_cancel', id);
    return reply.send({ ok: true });
  });

  app.get('/api/admin/roots', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    const roots = getRows<Record<string, unknown>>(
      db,
      'SELECT id, name, mount_path, health, last_success_at FROM library_roots ORDER BY name',
    ).map((root) => ({
      id: root.id,
      name: root.name,
      health: root.health,
      lastSuccessAt: root.last_success_at,
    }));
    return reply.send({ roots });
  });

  app.post('/api/admin/roots/:id/scan', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    const { id } = request.params as { id: string };
    const root = getRow<{ id: string }>(db, 'SELECT id FROM library_roots WHERE id = ?', id);
    if (!root) return reply.code(404).send({ error: 'not_found' });
    const jobId = enqueueScan(db, id, 10);
    audit(db, admin.id, 'admin.scan_requested', id);
    return reply.code(jobId ? 202 : 200).send({ queued: jobId !== null, jobId });
  });

  app.get('/api/admin/users', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    const users = getRows<Record<string, unknown>>(
      db,
      'SELECT id, login, display_name, role, enabled, created_at, updated_at FROM users ORDER BY login',
    ).map((user) => ({
      id: user.id,
      login: user.login,
      displayName: user.display_name,
      role: user.role,
      enabled: user.enabled === 1,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    }));
    return reply.send({ users });
  });

  app.post('/api/admin/users', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    const body = (request.body ?? {}) as {
      login?: unknown;
      displayName?: unknown;
      password?: unknown;
      role?: unknown;
    };
    const login = typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const role = body.role === 'admin' ? 'admin' : 'viewer';
    if (!/^[a-z0-9._-]{3,64}$/.test(login)) return reply.code(400).send({ error: 'invalid_login' });
    if (displayName === '' || displayName.length > 100) return reply.code(400).send({ error: 'invalid_display_name' });
    if (typeof body.password !== 'string') return reply.code(400).send({ error: 'invalid_request' });
    const problem = passwordProblem(body.password);
    if (problem) return reply.code(400).send({ error: 'weak_password', message: problem });
    if (getRow(db, 'SELECT id FROM users WHERE login = ?', login)) {
      return reply.code(409).send({ error: 'login_taken' });
    }

    const id = randomUUID();
    const now = nowIso();
    run(
      db,
      'INSERT INTO users (id, login, display_name, password_hash, role, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      id,
      login,
      displayName,
      await hashPassword(body.password),
      role,
      now,
      now,
    );
    audit(db, admin.id, 'admin.user_created', id);
    return reply.code(201).send({ id, login, displayName, role, enabled: true });
  });

  app.patch('/api/admin/users/:id', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { enabled?: unknown; role?: unknown; password?: unknown };

    const target = getRow<{ id: string; role: string; enabled: number }>(
      db,
      'SELECT id, role, enabled FROM users WHERE id = ?',
      id,
    );
    if (!target) return reply.code(404).send({ error: 'not_found' });

    if (typeof body.enabled === 'boolean') {
      if (!body.enabled && target.id === admin.id) return reply.code(409).send({ error: 'cannot_disable_self' });
      run(db, 'UPDATE users SET enabled = ?, updated_at = ? WHERE id = ?', body.enabled ? 1 : 0, nowIso(), id);
      if (!body.enabled) revokeUserSessions(db, id);
    }
    if (body.role === 'admin' || body.role === 'viewer') {
      if (target.id === admin.id && body.role !== 'admin') return reply.code(409).send({ error: 'cannot_demote_self' });
      run(db, 'UPDATE users SET role = ?, updated_at = ? WHERE id = ?', body.role, nowIso(), id);
    }
    if (typeof body.password === 'string') {
      const problem = passwordProblem(body.password);
      if (problem) return reply.code(400).send({ error: 'weak_password', message: problem });
      run(db, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(body.password), nowIso(), id);
      revokeUserSessions(db, id);
    }

    audit(db, admin.id, 'admin.user_updated', id);
    const updated = getRow<Record<string, unknown>>(
      db,
      'SELECT id, login, display_name, role, enabled FROM users WHERE id = ?',
      id,
    );
    return reply.send({
      id: updated?.id,
      login: updated?.login,
      displayName: updated?.display_name,
      role: updated?.role,
      enabled: updated?.enabled === 1,
    });
  });

  app.get('/api/admin/unsupported', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    const rows = getRows<Record<string, unknown>>(
      db,
      `SELECT m.id, m.rel_path, m.media_type, m.processing_state, md.unsupported_reason
         FROM media m LEFT JOIN media_metadata md ON md.media_id = m.id
        WHERE m.processing_state IN ('unsupported', 'failed')
        ORDER BY m.updated_at DESC LIMIT 200`,
    ).map((row) => ({
      id: row.id,
      fileName: String(row.rel_path).split('/').pop(),
      type: row.media_type,
      state: row.processing_state,
      reason: row.unsupported_reason,
    }));
    return reply.send({ items: rows });
  });

  /** Duplicate candidates confirmed by content hash; nothing is deleted here. */
  app.get('/api/admin/duplicates', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    const groups = listDuplicateGroups(db);
    return reply.send({
      groups,
      reclaimableBytes: duplicateSummary(db).reclaimableBytes,
      truncated: groups.length >= 100,
    });
  });

  app.post('/api/admin/queue', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    const body = (request.body ?? {}) as { paused?: unknown };
    if (typeof body.paused !== 'boolean') return reply.code(400).send({ error: 'invalid_request' });
    setQueuePaused(db, body.paused);
    audit(db, admin.id, body.paused ? 'admin.queue_paused' : 'admin.queue_resumed', null);
    return reply.send({ queuePaused: body.paused });
  });

  /** Confirmed OSV/LRF relationships plus pairs that could not be decided. */
  app.get('/api/admin/companions', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    return reply.send({
      relations: listCompanionRelations(db),
      checks: listCompanionChecks(db),
      summary: companionSummary(db),
    });
  });

  app.post('/api/admin/companions', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    const body = (request.body ?? {}) as { action?: unknown; sourceId?: unknown; relatedId?: unknown };
    if (
      typeof body.action !== 'string' ||
      typeof body.sourceId !== 'string' ||
      typeof body.relatedId !== 'string'
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    if (body.action === 'confirm') {
      const result = confirmCompanion(db, body.sourceId, body.relatedId, admin.id);
      if (!result.ok) return reply.code(result.error === 'not_found' ? 404 : 400).send({ error: result.error });
      const canonical = loadCompanionMedia(db, body.sourceId);
      if (canonical) {
        enqueue(db, {
          kind: 'thumbnail',
          dedupeKey: `thumbnail:${canonical.id}:v${canonical.source_version}:${THUMBNAIL_RECIPE}`,
          mediaId: canonical.id,
          sourceVersion: canonical.source_version,
          profileVersion: THUMBNAIL_RECIPE,
          priority: 1,
        });
      }
      audit(db, admin.id, 'admin.companion_confirmed', body.sourceId);
      return reply.send({ ok: true });
    }

    if (body.action === 'reject') {
      const result = rejectCompanion(db, body.sourceId, body.relatedId, admin.id);
      if (!result.ok) return reply.code(result.error === 'not_found' ? 404 : 400).send({ error: result.error });
      audit(db, admin.id, 'admin.companion_rejected', body.sourceId);
      return reply.send({ ok: true });
    }

    if (body.action === 'reset') {
      if (!loadCompanionMedia(db, body.sourceId) || !loadCompanionMedia(db, body.relatedId)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      resetCompanion(db, body.sourceId, body.relatedId);
      audit(db, admin.id, 'admin.companion_reset', body.sourceId);
      return reply.send({ ok: true });
    }

    return reply.code(400).send({ error: 'invalid_action' });
  });

  /** Full-sphere exports linked to raw camera originals (DJI workflow). */
  app.get('/api/admin/exports', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    return reply.send({
      relations: listExportLinks(db),
      originals: listExportOriginals(db),
      candidates: listExportCandidates(db),
    });
  });

  app.post('/api/admin/exports', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return reply;
    const body = (request.body ?? {}) as { action?: unknown; sourceId?: unknown; exportId?: unknown };
    if (typeof body.action !== 'string' || typeof body.sourceId !== 'string' || typeof body.exportId !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (body.action === 'link') {
      const result = linkExport(db, body.sourceId, body.exportId, admin.id);
      if (!result.ok) return reply.code(result.error === 'not_found' ? 404 : 400).send({ error: result.error });
      audit(db, admin.id, 'admin.export_linked', body.sourceId);
      return reply.send({ ok: true });
    }
    if (body.action === 'unlink') {
      unlinkExport(db, body.sourceId, body.exportId);
      audit(db, admin.id, 'admin.export_unlinked', body.sourceId);
      return reply.send({ ok: true });
    }
    return reply.code(400).send({ error: 'invalid_action' });
  });
}
