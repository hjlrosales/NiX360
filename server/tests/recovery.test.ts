import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { after, describe, it } from 'node:test';
import { createTestContext, type TestContext } from './helpers.ts';
import { scanRoot } from '../src/media/scan.ts';
import { runWorker } from '../src/jobs/worker.ts';
import { getRow } from '../src/db/sqlite.ts';

async function drain(ctx: TestContext): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await runWorker({
      db: ctx.db,
      config: ctx.config,
      signal: new AbortController().signal,
      once: true,
      log: () => {},
    });
  }
}

describe('derivative recovery after a catalog-only restore', () => {
  let ctx: TestContext;

  after(async () => {
    await ctx?.cleanup();
  });

  it('reconciles a missing derivative file and regenerates it without a rescan', async () => {
    ctx = await createTestContext();
    await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 90, b: 160 } } })
      .jpeg()
      .toFile(path.join(ctx.mediaRoot, 'recover.jpg'));

    await scanRoot(ctx.db, ctx.config, 'test');
    await drain(ctx);

    const media = getRow<{ id: string; source_version: number }>(
      ctx.db,
      "SELECT id, source_version FROM media WHERE rel_path = 'recover.jpg'",
    );
    assert.ok(media);
    const derivative = getRow<{ id: string; storage_key: string }>(
      ctx.db,
      `SELECT id, storage_key FROM derivatives
        WHERE media_id = ? AND source_version = ? AND kind = 'thumbnail' AND state = 'ready'`,
      media.id,
      media.source_version,
    );
    assert.ok(derivative);
    const absolute = path.join(ctx.config.derivativesDir, derivative.storage_key);
    assert.ok(fs.existsSync(absolute));

    // Simulate the data volume being lost while the catalog is restored.
    fs.rmSync(path.dirname(absolute), { recursive: true, force: true });
    assert.equal(fs.existsSync(absolute), false);

    await drain(ctx);

    assert.equal(
      getRow<{ state: string }>(ctx.db, 'SELECT state FROM derivatives WHERE id = ?', derivative.id)?.state,
      'ready',
      'the regenerated row is published again',
    );
    assert.ok(fs.existsSync(absolute), 'the missing file was recreated');
    assert.ok(fs.statSync(absolute).size > 0);
    assert.equal(
      getRow<{ processing_state: string }>(ctx.db, 'SELECT processing_state FROM media WHERE id = ?', media.id)
        ?.processing_state,
      'ready',
    );
  });
});
