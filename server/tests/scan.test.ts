import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { after, describe, it } from 'node:test';
import { createTestContext, type TestContext } from './helpers.ts';
import { scanRoot } from '../src/media/scan.ts';
import { runWorker } from '../src/jobs/worker.ts';
import { getRow, getRows } from '../src/db/sqlite.ts';

async function drainQueue(ctx: TestContext): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await runWorker({
      db: ctx.db,
      config: ctx.config,
      signal: new AbortController().signal,
      once: true,
      log: () => {},
    });
  }
}

describe('library scan and derivative pipeline', () => {
  let ctx: TestContext;

  after(async () => {
    await ctx?.cleanup();
  });

  it('catalogues new media, skips ignored files and processes derivatives', async () => {
    ctx = await createTestContext();
    await sharp({ create: { width: 800, height: 400, channels: 3, background: { r: 20, g: 120, b: 200 } } })
      .jpeg()
      .toFile(path.join(ctx.mediaRoot, 'flat.jpg'));
    await sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 200, g: 120, b: 20 } } })
      .jpeg()
      .toFile(path.join(ctx.mediaRoot, 'パノラマ.jpg'));
    fs.writeFileSync(path.join(ctx.mediaRoot, 'notes.txt'), 'not media');

    const stats = await scanRoot(ctx.db, ctx.config, 'test');
    assert.equal(stats.filesAdded, 2);
    assert.equal(stats.filesSeen, 2);
    assert.ok(stats.filesSkipped >= 1);

    const media = getRows<{ id: string; rel_path: string }>(ctx.db, 'SELECT id, rel_path FROM media ORDER BY rel_path');
    assert.equal(media.length, 2);
    assert.ok(media.some((row) => row.rel_path === 'パノラマ.jpg'), 'Unicode paths are preserved');

    await drainQueue(ctx);

    const states = getRows<{ processing_state: string; projection: string }>(
      ctx.db,
      'SELECT processing_state, projection FROM media',
    );
    assert.equal(states.length, 2);
    for (const state of states) {
      assert.equal(state.processing_state, 'ready');
      // A 2:1 aspect ratio is only a hint, never proof of spherical projection.
      assert.equal(state.projection, 'unknown');
    }

    const derivatives = getRows<{ storage_key: string; kind: string }>(
      ctx.db,
      'SELECT storage_key, kind FROM derivatives WHERE state = ' + "'ready'",
    );
    assert.equal(derivatives.length, 4, 'thumbnail and preview per photo');
    for (const derivative of derivatives) {
      assert.ok(fs.existsSync(path.join(ctx.config.derivativesDir, derivative.storage_key)), derivative.storage_key);
    }
  });

  it('bumps the source version and regenerates derivatives when a file changes', async () => {
    const row = getRow<{ id: string; source_version: number }>(
      ctx.db,
      `SELECT id, source_version FROM media WHERE rel_path = 'flat.jpg'`,
    );
    assert.ok(row);

    await sharp({ create: { width: 640, height: 640, channels: 3, background: { r: 5, g: 5, b: 5 } } })
      .jpeg()
      .toFile(path.join(ctx.mediaRoot, 'flat.jpg'));

    const stats = await scanRoot(ctx.db, ctx.config, 'test');
    assert.equal(stats.filesChanged, 1);

    const updated = getRow<{ source_version: number; processing_state: string }>(
      ctx.db,
      'SELECT source_version, processing_state FROM media WHERE id = ?',
      row.id,
    );
    assert.equal(updated?.source_version, row.source_version + 1);
    assert.equal(updated?.processing_state, 'pending');

    await drainQueue(ctx);

    const versions = getRows<{ source_version: number }>(
      ctx.db,
      'SELECT DISTINCT source_version FROM derivatives WHERE media_id = ?',
      row.id,
    ).map((version) => version.source_version);
    assert.deepEqual(versions, [row.source_version + 1], 'stale derivatives are removed from the catalog');

    const staleDirectories = fs.readdirSync(path.join(ctx.config.derivativesDir, row.id));
    assert.deepEqual(staleDirectories, [`v${row.source_version + 1}`]);
  });

  it('tombstones externally deleted files without touching originals', async () => {
    fs.rmSync(path.join(ctx.mediaRoot, 'flat.jpg'));
    const stats = await scanRoot(ctx.db, ctx.config, 'test');
    assert.equal(stats.filesMissing, 1);

    const missing = getRow<{ availability: string; missing_since: string | null }>(
      ctx.db,
      `SELECT availability, missing_since FROM media WHERE rel_path = 'flat.jpg'`,
    );
    assert.equal(missing?.availability, 'missing');
    assert.ok(missing?.missing_since);
    assert.ok(fs.existsSync(path.join(ctx.mediaRoot, 'パノラマ.jpg')), 'originals are never modified');
  });

  it('does not tombstone the library when the root is unavailable', async () => {
    const moved = `${ctx.mediaRoot}-offline`;
    fs.renameSync(ctx.mediaRoot, moved);
    try {
      await assert.rejects(scanRoot(ctx.db, ctx.config, 'test'), /ENOENT|no such file|failed/i);
    } finally {
      fs.renameSync(moved, ctx.mediaRoot);
    }

    const present = getRow<{ availability: string }>(
      ctx.db,
      `SELECT availability FROM media WHERE rel_path = 'パノラマ.jpg'`,
    );
    assert.equal(present?.availability, 'present');

    const root = getRow<{ health: string }>(ctx.db, `SELECT health FROM library_roots WHERE id = 'test'`);
    assert.equal(root?.health, 'unavailable');

    const scans = getRows<{ status: string; error: string | null }>(
      ctx.db,
      `SELECT status, error FROM scan_runs ORDER BY started_at DESC LIMIT 1`,
    );
    assert.equal(scans[0]?.status, 'failed');
    assert.ok(scans[0]?.error);
  });

  it('refuses symlinks that escape the media root', async (t) => {
    const outside = path.join(ctx.workspace, 'outside.jpg');
    await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toFile(outside);
    const link = path.join(ctx.mediaRoot, 'link.jpg');
    try {
      fs.symlinkSync(outside, link);
    } catch {
      t.skip('symlink creation not permitted on this platform');
      return;
    }

    const stats = await scanRoot(ctx.db, ctx.config, 'test');
    const escaped = getRow<{ id: string }>(ctx.db, `SELECT id FROM media WHERE rel_path = 'link.jpg'`);
    assert.equal(escaped, undefined);
    assert.ok(stats.filesSkipped >= 1);
  });
});
