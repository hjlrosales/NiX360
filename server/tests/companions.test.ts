import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { createTestContext, createUser, login, TEST_PASSWORD, type TestContext } from './helpers.ts';
import { scanRoot } from '../src/media/scan.ts';
import { runWorker } from '../src/jobs/worker.ts';
import { getRow, getRows, migrate, openDatabase, run } from '../src/db/sqlite.ts';
import { nowIso } from '../src/config.ts';
import {
  canonicalMediaId,
  companionPreview,
  evaluateCompanionPair,
} from '../src/media/companions.ts';

async function drainQueue(ctx: TestContext): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await runWorker({
      db: ctx.db,
      config: ctx.config,
      signal: new AbortController().signal,
      once: true,
      log: () => {},
    });
  }
}

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function writeClip(file: string, seconds: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=10',
      '-t',
      String(seconds),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      // ffmpeg cannot infer a muxer from .OSV/.LRF extensions.
      '-f',
      'mp4',
      '-y',
      file,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

type Page = { items: { id: string; fileName: string; processingState: string }[]; nextCursor: string | null };

type Detail = {
  canonicalId: string;
  requestedId: string;
  companion: { mediaId: string; width: number | null; height: number | null } | null;
  playback: { url: string; kind: string; label: string } | null;
  originalConversionRequired: boolean;
  processingState: string;
};

function mediaId(ctx: TestContext, relPath: string): string {
  const row = getRow<{ id: string }>(ctx.db, 'SELECT id FROM media WHERE rel_path = ?', relPath);
  assert.ok(row, `catalogued ${relPath}`);
  return row!.id;
}

async function library(ctx: TestContext, cookie: string, query = ''): Promise<Page> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/library${query}`,
    cookies: { nix_session: cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as Page;
}

describe('DJI LRF companion pairing', () => {
  it('pairs an OSV with its same-folder LRF and serves the labeled preview', async (t) => {
    if (!hasFfmpeg()) {
      t.skip('ffmpeg is not installed in this environment');
      return;
    }
    const ctx = await createTestContext();
    t.after(async () => ctx.cleanup());

    const osv = path.join(ctx.mediaRoot, 'DCIM/CAM_0001.OSV');
    const lrf = path.join(ctx.mediaRoot, 'DCIM/CAM_0001.LRF');
    writeClip(osv, 2);
    writeClip(lrf, 2.05);
    const hashes = { osv: sha256(osv), lrf: sha256(lrf) };

    await scanRoot(ctx.db, ctx.config, 'test');
    await drainQueue(ctx);

    const relation = getRow<{
      source: string;
      related: string;
      status: string;
      policy: number;
      provenance: string;
    }>(
      ctx.db,
      `SELECT source_media_id AS source, related_media_id AS related, status,
              policy_version AS policy, provenance
         FROM media_relations WHERE relation_type = 'preview_companion'`,
    );
    assert.ok(relation, 'a companion relationship was recorded');
    assert.equal(relation!.status, 'confirmed');
    assert.equal(relation!.policy, 1);
    const provenance = JSON.parse(relation!.provenance) as {
      decidedBy: string;
      evidence: { toleranceMs: number; canonicalDurationMs: number };
    };
    assert.equal(provenance.decidedBy, 'auto');
    assert.ok(provenance.evidence.toleranceMs >= 250, 'the duration tolerance has a floor');
    assert.equal(relation!.source, mediaId(ctx, 'DCIM/CAM_0001.OSV'));
    assert.equal(relation!.related, mediaId(ctx, 'DCIM/CAM_0001.LRF'));

    const viewerId = await createUser(ctx.db, 'viewer', TEST_PASSWORD);
    const cookie = await login(ctx.app, 'viewer');

    const page = await library(ctx, cookie);
    assert.equal(page.items.length, 1, 'one recording, not two files');
    const canonical = page.items[0]!;
    assert.match(canonical.fileName, /\.OSV$/);
    assert.equal(canonical.processingState, 'ready');

    // Companion files never inflate folder or search counts.
    const folders = await ctx.app.inject({
      method: 'GET',
      url: '/api/folders?path=DCIM',
      cookies: { nix_session: cookie },
    });
    const folderListing = folders.json() as { mediaCount: number };
    assert.equal(folderListing.mediaCount, 1);

    assert.equal((await library(ctx, cookie, '?q=CAM_0001')).items.length, 1);
    assert.equal((await library(ctx, cookie, '?q=.LRF')).items.length, 0);

    const lrfId = mediaId(ctx, 'DCIM/CAM_0001.LRF');
    const detailResponse = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${lrfId}`,
      cookies: { nix_session: cookie },
    });
    assert.equal(detailResponse.statusCode, 200);
    const detail = detailResponse.json() as Detail;
    assert.equal(detail.requestedId, lrfId);
    assert.equal(detail.canonicalId, relation!.source, 'companion deep links resolve to the recording');
    assert.equal(detail.companion?.mediaId, lrfId);
    assert.equal(detail.playback?.kind, 'preview');
    assert.equal(detail.playback?.url, `/api/media/${lrfId}/original`);
    assert.equal(detail.originalConversionRequired, false);

    const unauthorized = await ctx.app.inject({ method: 'GET', url: detail.playback!.url });
    assert.equal(unauthorized.statusCode, 401, 'the preview requires a session');

    const ranged = await ctx.app.inject({
      method: 'GET',
      url: detail.playback!.url,
      headers: { range: 'bytes=0-99' },
      cookies: { nix_session: cookie },
    });
    assert.equal(ranged.statusCode, 206);
    assert.equal(ranged.headers['content-type'], 'video/mp4');
    assert.equal(ranged.rawPayload.length, 100);

    // The poster is decoded from the LRF, recorded with its provenance.
    const poster = getRow<{ source_media_id: string }>(
      ctx.db,
      `SELECT source_media_id FROM derivatives WHERE media_id = ? AND kind = 'poster' AND state = 'ready'`,
      relation!.source,
    );
    assert.equal(poster?.source_media_id, lrfId);

    // Favorites made on the standalone LRF would exist only after unpairing;
    // the confirmed relationship must keep both source files untouched.
    assert.equal(sha256(osv), hashes.osv);
    assert.equal(sha256(lrf), hashes.lrf);
    assert.equal(viewerId.length > 0, true);
    assert.ok(!getRows<{ status: string }>(ctx.db, 'SELECT status FROM jobs').some((job) => job.status === 'failed'));
  });

  it('converges on late arrivals, keeps separate folders apart and persists rejection', async (t) => {
    if (!hasFfmpeg()) {
      t.skip('ffmpeg is not installed in this environment');
      return;
    }
    const ctx = await createTestContext();
    t.after(async () => ctx.cleanup());

    const lrf = path.join(ctx.mediaRoot, 'late/CAM_0010.LRF');
    writeClip(lrf, 2);
    await scanRoot(ctx.db, ctx.config, 'test');
    await drainQueue(ctx);
    await createUser(ctx.db, 'viewer', TEST_PASSWORD);
    await createUser(ctx.db, 'owner', TEST_PASSWORD, 'admin');
    const cookie = await login(ctx.app, 'viewer');
    const adminCookie = await login(ctx.app, 'owner');

    assert.equal((await library(ctx, cookie)).items.length, 1, 'an orphan LRF stays visible');

    // Without a recording the LRF is an ordinary video and plays on its own.
    const orphanId = mediaId(ctx, 'late/CAM_0010.LRF');
    const orphan = (await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${orphanId}`,
      cookies: { nix_session: cookie },
    })).json() as Detail;
    assert.equal(orphan.canonicalId, orphanId, 'a standalone LRF is its own recording');
    assert.equal(orphan.playback?.kind, 'original');
    assert.equal(orphan.originalConversionRequired, false);

    writeClip(path.join(ctx.mediaRoot, 'late/CAM_0010.OSV'), 2.05);
    await scanRoot(ctx.db, ctx.config, 'test');
    await drainQueue(ctx);
    assert.equal((await library(ctx, cookie)).items.length, 1, 'the late OSV joins the existing item');

    // Same stem, different folders: never paired across directories.
    writeClip(path.join(ctx.mediaRoot, 'other/CAM_0010.OSV'), 2);
    writeClip(path.join(ctx.mediaRoot, 'third/CAM_0010.LRF'), 2);
    await scanRoot(ctx.db, ctx.config, 'test');
    await drainQueue(ctx);
    assert.equal(
      getRow<{ count: number }>(ctx.db, `SELECT COUNT(*) AS count FROM media_relations` )?.count,
      1,
      'no cross-directory relationship was created',
    );
    assert.equal((await library(ctx, cookie)).items.length, 3);

    const relation = getRow<{ source: string; related: string }>(
      ctx.db,
      `SELECT source_media_id AS source, related_media_id AS related FROM media_relations
        WHERE relation_type = 'preview_companion'`,
    );
    const reject = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/companions',
      payload: { action: 'reject', sourceId: relation!.source, relatedId: relation!.related },
      cookies: { nix_session: adminCookie },
    });
    assert.equal(reject.statusCode, 200, reject.body);

    await scanRoot(ctx.db, ctx.config, 'test');
    await drainQueue(ctx);
    const afterRescan = getRow<{ status: string }>(
      ctx.db,
      `SELECT status FROM media_relations WHERE relation_type = 'preview_companion'`,
    );
    assert.equal(afterRescan?.status, 'rejected', 'a manual decision survives rescans');
    assert.equal((await library(ctx, cookie)).items.length, 4, 'unpairing restores separate items');

    const checks = (
      await ctx.app.inject({ method: 'GET', url: '/api/admin/companions', cookies: { nix_session: adminCookie } })
    ).json() as { checks: { status: string; reason: string }[]; relations: unknown[] };
    assert.ok(checks.checks.some((check) => check.status === 'rejected'));
    assert.equal(checks.relations.length, 0, 'rejected pairs are not listed as confirmed');
  });

  it('records a duration mismatch for review, then pairs and migrates user state on confirmation', async (t) => {
    if (!hasFfmpeg()) {
      t.skip('ffmpeg is not installed in this environment');
      return;
    }
    const ctx = await createTestContext();
    t.after(async () => ctx.cleanup());

    const osv = path.join(ctx.mediaRoot, 'mismatch/CAM_0020.OSV');
    writeClip(osv, 4);
    writeClip(path.join(ctx.mediaRoot, 'mismatch/CAM_0020.LRF'), 2);
    await scanRoot(ctx.db, ctx.config, 'test');
    await drainQueue(ctx);

    assert.equal(
      getRow<{ count: number }>(ctx.db, `SELECT COUNT(*) AS count FROM media_relations`)?.count,
      0,
      'durations beyond tolerance are not auto-confirmed',
    );
    const check = getRow<{ status: string; reason: string }>(
      ctx.db,
      'SELECT status, reason FROM companion_checks',
    );
    assert.equal(check?.status, 'ambiguous');
    assert.match(check!.reason, /durations differ/i);

    const osvId = mediaId(ctx, 'mismatch/CAM_0020.OSV');
    const lrfId = mediaId(ctx, 'mismatch/CAM_0020.LRF');
    const viewerId = await createUser(ctx.db, 'viewer', TEST_PASSWORD);
    await createUser(ctx.db, 'owner', TEST_PASSWORD, 'admin');
    const cookie = await login(ctx.app, 'viewer');
    const adminCookie = await login(ctx.app, 'owner');

    // User state is created while the LRF is still a standalone item.
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/media/${lrfId}/favorite`,
      payload: { favorite: true },
      cookies: { nix_session: cookie },
    });
    const album = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/albums',
        payload: { title: 'Clips' },
        cookies: { nix_session: cookie },
      })
    ).json() as { id: string };
    await ctx.app.inject({
      method: 'POST',
      url: `/api/albums/${album.id}/items`,
      payload: { mediaId: lrfId },
      cookies: { nix_session: cookie },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/history',
      payload: { mediaId: lrfId, positionSeconds: 7 },
      cookies: { nix_session: cookie },
    });

    const pending = (
      await ctx.app.inject({ method: 'GET', url: '/api/admin/companions', cookies: { nix_session: adminCookie } })
    ).json() as { checks: { canonicalId: string; status: string; reason: string }[] };
    assert.ok(pending.checks.some((entry) => entry.canonicalId === osvId && entry.status === 'ambiguous'));

    const confirm = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/companions',
      payload: { action: 'confirm', sourceId: osvId, relatedId: lrfId },
      cookies: { nix_session: adminCookie },
    });
    assert.equal(confirm.statusCode, 200, confirm.body);

    assert.equal(
      getRow<{ status: string }>(ctx.db, `SELECT status FROM media_relations`)?.status,
      'confirmed',
    );
    assert.equal((await library(ctx, cookie)).items.length, 1);
    assert.equal(
      getRow<{ user_id: string }>(ctx.db, 'SELECT user_id FROM favorites WHERE media_id = ?', osvId)?.user_id,
      viewerId,
      'favorites follow the recording',
    );
    assert.equal(
      getRow<{ media_id: string }>(ctx.db, 'SELECT media_id FROM album_items WHERE album_id = ?', album.id)?.media_id,
      osvId,
    );
    assert.equal(
      getRow<{ position_seconds: number }>(ctx.db, 'SELECT position_seconds FROM viewing_history WHERE media_id = ?', osvId)
        ?.position_seconds,
      7,
      'playback position follows the recording',
    );
    assert.equal(
      getRow<{ count: number }>(ctx.db, 'SELECT COUNT(*) AS count FROM favorites WHERE media_id = ?', lrfId)?.count,
      0,
    );
  });
});

type CompanionDetail = {
  canonicalId: string;
  requestedId: string;
  companion: { mediaId: string; availability: string; sourceVersion: number } | null;
  playback: { kind: string } | null;
  playbackOptions: { kind: string }[];
  originalConversionRequired: boolean;
};

type RelationRow = { status: string; source_version: number; related_version: number };

type MediaFixture = {
  relPath: string;
  rootId?: string;
  version?: number;
  durationMs?: number | null;
  probed?: boolean;
  captureDate?: string | null;
  captureCertain?: number;
};

async function detailFor(ctx: TestContext, cookie: string, id: string): Promise<CompanionDetail> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/media/${id}`,
    cookies: { nix_session: cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as CompanionDetail;
}

function relationFor(db: DatabaseSync, sourceId: string): RelationRow | undefined {
  return getRow<RelationRow>(
    db,
    `SELECT status, source_version, related_version FROM media_relations
      WHERE relation_type = 'preview_companion' AND source_media_id = ?`,
    sourceId,
  );
}

/** Inserts catalog rows directly, so decision rules can be exercised without files. */
function insertMedia(db: DatabaseSync, fixture: MediaFixture): string {
  const id = crypto.randomUUID();
  const extension = path.posix.extname(fixture.relPath).toLowerCase();
  const now = nowIso();
  run(
    db,
    `INSERT INTO media (id, root_id, rel_path, extension, source_version, size_bytes, mtime_ms,
                        media_type, projection, availability, processing_state, capture_date,
                        last_seen_scan, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1024, 1, 'video', 'unknown', 'present', 'ready', ?, 1, ?, ?)`,
    id,
    fixture.rootId ?? 'test',
    fixture.relPath,
    extension,
    fixture.version ?? 1,
    fixture.captureDate ?? null,
    now,
    now,
  );
  if (fixture.durationMs !== undefined) {
    run(
      db,
      `INSERT INTO media_metadata (media_id, duration_ms, metadata_source, projection_source,
                                   direct_play, capture_date_certain, probed_at)
       VALUES (?, ?, 'ffprobe', 'unknown', 1, ?, ?)`,
      id,
      fixture.durationMs,
      fixture.captureCertain ?? 0,
      now,
    );
  }
  return id;
}

describe('DJI LRF companion safety rules', () => {
  it('never pairs across roots or case-distinct stems and records ambiguous evidence', async (t) => {
    const ctx = await createTestContext();
    t.after(async () => ctx.cleanup());
    run(
      ctx.db,
      `INSERT INTO library_roots (id, name, mount_path, health, created_at) VALUES ('other', 'Other', ?, 'unknown', ?)`,
      path.join(ctx.workspace, 'other-media'),
      nowIso(),
    );

    // Same stem in a different root is not a candidate.
    const foreignOsv = insertMedia(ctx.db, { relPath: 'DCIM/CAM_0001.OSV', durationMs: 2_000 });
    insertMedia(ctx.db, { relPath: 'DCIM/CAM_0001.LRF', rootId: 'other', durationMs: 2_000 });
    assert.equal(evaluateCompanionPair(ctx.db, foreignOsv).status, 'no_candidate');

    // Stems are compared exactly, so a case-distinct stem does not merge.
    const caseOsv = insertMedia(ctx.db, { relPath: 'DCIM/CAM_0002.OSV', durationMs: 2_000 });
    insertMedia(ctx.db, { relPath: 'DCIM/cam_0002.LRF', durationMs: 2_000 });
    assert.equal(evaluateCompanionPair(ctx.db, caseOsv).status, 'no_candidate');

    // Two same-stem companions leave the pair ambiguous rather than picking one.
    const duplicateOsv = insertMedia(ctx.db, { relPath: 'DCIM/CAM_0003.OSV', durationMs: 2_000 });
    insertMedia(ctx.db, { relPath: 'DCIM/CAM_0003.LRF', durationMs: 2_000 });
    insertMedia(ctx.db, { relPath: 'DCIM/CAM_0003.lrf', durationMs: 2_000 });
    const duplicate = evaluateCompanionPair(ctx.db, duplicateOsv);
    assert.equal(duplicate.status, 'ambiguous');
    assert.match(duplicate.reason, /multiple matching companion files/i);
    assert.equal(
      getRow<{ status: string }>(
        ctx.db,
        'SELECT status FROM companion_checks WHERE source_media_id = ?',
        duplicateOsv,
      )?.status,
      'ambiguous',
    );

    // Certain but conflicting capture timestamps are not auto-confirmed.
    const conflictOsv = insertMedia(ctx.db, {
      relPath: 'DCIM/CAM_0004.OSV',
      durationMs: 2_000,
      captureDate: '2026-11-05T10:00:00.000Z',
      captureCertain: 1,
    });
    insertMedia(ctx.db, {
      relPath: 'DCIM/CAM_0004.LRF',
      durationMs: 2_000,
      captureDate: '2026-11-05T10:00:05.000Z',
      captureCertain: 1,
    });
    const conflict = evaluateCompanionPair(ctx.db, conflictOsv);
    assert.equal(conflict.status, 'ambiguous');
    assert.match(conflict.reason, /capture timestamps differ/i);

    assert.equal(
      getRow<{ count: number }>(ctx.db, 'SELECT COUNT(*) AS count FROM media_relations')?.count,
      0,
      'no relationship was confirmed by any unsafe candidate',
    );
  });

  it('keeps an unreadable companion unpaired', async (t) => {
    if (!hasFfmpeg()) {
      t.skip('ffmpeg is not installed in this environment');
      return;
    }
    const ctx = await createTestContext();
    t.after(async () => ctx.cleanup());

    writeClip(path.join(ctx.mediaRoot, 'partial/CAM_0050.OSV'), 2);
    fs.mkdirSync(path.join(ctx.mediaRoot, 'partial'), { recursive: true });
    fs.writeFileSync(path.join(ctx.mediaRoot, 'partial/CAM_0050.LRF'), Buffer.from('not a video stream'));
    await scanRoot(ctx.db, ctx.config, 'test');
    await drainQueue(ctx);

    const osvId = mediaId(ctx, 'partial/CAM_0050.OSV');
    const lrfId = mediaId(ctx, 'partial/CAM_0050.LRF');
    assert.equal(
      getRow<{ count: number }>(ctx.db, 'SELECT COUNT(*) AS count FROM media_relations')?.count,
      0,
      'a file whose probe failed is never auto-paired',
    );
    assert.equal(
      getRow<{ processing_state: string }>(ctx.db, 'SELECT processing_state FROM media WHERE id = ?', lrfId)
        ?.processing_state,
      'failed',
      'the failure stays visible instead of being treated as pending evidence',
    );
    const outcome = evaluateCompanionPair(ctx.db, osvId);
    assert.equal(outcome.status, 'pending');
    assert.match(outcome.reason, /finite duration/i);

    const viewerId = await createUser(ctx.db, 'viewer', TEST_PASSWORD);
    assert.ok(viewerId.length > 0);
  });

  it('suspends a changed companion, keeps the recording when files go missing, and survives restart', async (t) => {
    if (!hasFfmpeg()) {
      t.skip('ffmpeg is not installed in this environment');
      return;
    }
    const ctx = await createTestContext();
    // This test closes and reopens the database, so cleanup must tolerate that.
    t.after(async () => {
      try {
        await ctx.app.close();
      } catch {}
      try {
        ctx.db.close();
      } catch {}
      fs.rmSync(ctx.workspace, { recursive: true, force: true });
    });

    const osv = path.join(ctx.mediaRoot, 'DCIM/CAM_0040.OSV');
    const lrf = path.join(ctx.mediaRoot, 'DCIM/CAM_0040.LRF');
    writeClip(osv, 2);
    writeClip(lrf, 2.02);
    const osvHash = sha256(osv);

    await scanRoot(ctx.db, ctx.config, 'test');
    await drainQueue(ctx);
    const osvId = mediaId(ctx, 'DCIM/CAM_0040.OSV');
    const lrfId = mediaId(ctx, 'DCIM/CAM_0040.LRF');
    assert.equal(relationFor(ctx.db, osvId)?.status, 'confirmed');

    await createUser(ctx.db, 'viewer', TEST_PASSWORD);
    const cookie = await login(ctx.app, 'viewer');
    let detail = await detailFor(ctx, cookie, osvId);
    assert.equal(detail.companion?.mediaId, lrfId);
    assert.equal(detail.playback?.kind, 'preview');

    // The companion changes: its old probe evidence no longer describes the file.
    writeClip(lrf, 6);
    await scanRoot(ctx.db, ctx.config, 'test');
    assert.equal(
      getRow<{ source_version: number }>(ctx.db, 'SELECT source_version FROM media WHERE id = ?', lrfId)
        ?.source_version,
      2,
    );
    detail = await detailFor(ctx, cookie, osvId);
    assert.equal(detail.companion, null, 'a changed companion is not selected before re-probing');
    assert.ok(!detail.playbackOptions.some((option) => option.kind === 'preview'));

    // Re-probing finds a duration mismatch instead of silently keeping the pair.
    await drainQueue(ctx);
    assert.equal(relationFor(ctx.db, osvId)?.related_version, 1, 'the stale relationship is not re-confirmed');
    assert.equal(
      getRow<{ status: string; reason: string }>(
        ctx.db,
        'SELECT status, reason FROM companion_checks WHERE source_media_id = ?',
        osvId,
      )?.status,
      'ambiguous',
    );
    assert.equal((await detailFor(ctx, cookie, osvId)).companion, null);

    // Returning to the original duration re-establishes the preview at the new version.
    writeClip(lrf, 2);
    await scanRoot(ctx.db, ctx.config, 'test');
    await drainQueue(ctx);
    const restored = relationFor(ctx.db, osvId);
    assert.equal(restored?.status, 'confirmed');
    assert.equal(restored?.related_version, 3);
    detail = await detailFor(ctx, cookie, osvId);
    assert.equal(detail.companion?.mediaId, lrfId);
    assert.equal(detail.playback?.kind, 'preview');

    // A missing companion stays catalogued as status; the recording is intact.
    fs.rmSync(lrf);
    await scanRoot(ctx.db, ctx.config, 'test');
    await drainQueue(ctx);
    assert.equal(
      getRow<{ availability: string }>(ctx.db, 'SELECT availability FROM media WHERE id = ?', lrfId)?.availability,
      'missing',
    );
    assert.equal(relationFor(ctx.db, osvId)?.status, 'confirmed', 'a missing file does not dissolve the pair');
    detail = await detailFor(ctx, cookie, osvId);
    assert.equal(detail.companion?.availability, 'missing');
    assert.ok(!detail.playbackOptions.some((option) => option.kind === 'preview'));
    assert.equal(
      (await library(ctx, cookie)).items.filter((item) => item.fileName.startsWith('CAM_0040')).length,
      1,
      'one recording is still listed',
    );

    // A disconnected root is an operational error, not deletion.
    const offline = `${ctx.mediaRoot}-offline`;
    fs.renameSync(ctx.mediaRoot, offline);
    try {
      await assert.rejects(() => scanRoot(ctx.db, ctx.config, 'test'));
      assert.equal(
        getRow<{ availability: string }>(ctx.db, 'SELECT availability FROM media WHERE id = ?', osvId)?.availability,
        'present',
        'an unavailable root does not tombstone its contents',
      );
      assert.equal(relationFor(ctx.db, osvId)?.status, 'confirmed');
    } finally {
      fs.renameSync(offline, ctx.mediaRoot);
    }

    // Relationship and canonical resolution survive a database restart.
    assert.equal(sha256(osv), osvHash);
    await ctx.app.close();
    ctx.db.close();
    const reopened = openDatabase(ctx.config.dbPath);
    try {
      migrate(reopened);
      assert.equal(relationFor(reopened, osvId)?.status, 'confirmed');
      assert.equal(canonicalMediaId(reopened, lrfId), osvId);
      assert.equal(companionPreview(reopened, osvId)?.id, lrfId);
      assert.equal(companionPreview(reopened, osvId)?.availability, 'missing');
    } finally {
      reopened.close();
    }
  });
});
