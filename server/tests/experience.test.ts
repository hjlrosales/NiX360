import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { createTestContext, createUser, login, TEST_PASSWORD, type TestContext } from './helpers.ts';
import { describeExperience } from '../src/media/experience.ts';
import { scanRoot } from '../src/media/scan.ts';
import { runWorker } from '../src/jobs/worker.ts';
import { getRow, getRows, run } from '../src/db/sqlite.ts';
import { nowIso } from '../src/config.ts';

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

describe('explicit media experiences', () => {
  let ctx: TestContext;

  after(async () => {
    await ctx?.cleanup();
  });

  it('separates processing, conversion-required and failed states', () => {
    const ready = describeExperience({
      mediaType: 'photo',
      processingState: 'ready',
      hasPlayback: true,
      unsupportedReason: null,
    });
    assert.equal(ready.state, 'ready');
    assert.equal(ready.retryable, false);

    for (const processingState of ['pending', 'processing']) {
      const queued = describeExperience({
        mediaType: 'video',
        processingState,
        hasPlayback: false,
        unsupportedReason: null,
      });
      assert.equal(queued.state, 'processing', 'queued work is not a conversion request');
      assert.equal(queued.retryable, false);
    }

    const conversion = describeExperience({
      mediaType: 'video',
      processingState: 'unsupported',
      hasPlayback: false,
      unsupportedReason: 'Export a full sphere from DJI Studio',
    });
    assert.equal(conversion.state, 'conversion_required');
    assert.equal(conversion.detail, 'Export a full sphere from DJI Studio');
    assert.equal(conversion.retryable, false, 're-running the job cannot fix an unsupported source');

    const failure = describeExperience({
      mediaType: 'photo',
      processingState: 'failed',
      hasPlayback: false,
      unsupportedReason: 'Metadata could not be read: Invalid data',
    });
    assert.equal(failure.state, 'failed');
    assert.equal(failure.retryable, true);
    assert.match(failure.detail, /could not be read/);

    // A ready catalog row is not proof that a video has a playable stream.
    const missingStream = describeExperience({
      mediaType: 'video',
      processingState: 'ready',
      hasPlayback: false,
      unsupportedReason: null,
    });
    assert.equal(missingStream.state, 'conversion_required');
  });

  it('records raw OSV as unsupported and an unreadable file as failed instead of pending', async () => {
    ctx = await createTestContext();
    fs.writeFileSync(path.join(ctx.mediaRoot, 'raw.osv'), Buffer.from('not a container this server can stitch\n'));
    fs.writeFileSync(path.join(ctx.mediaRoot, 'broken.mp4'), Buffer.from('truncated bytes\n'));

    const stats = await scanRoot(ctx.db, ctx.config, 'test');
    assert.equal(stats.filesAdded, 2);
    assert.equal(stats.filesSeen, 2);
    await drainQueue(ctx);

    // A failed probe is recorded, so the queue is empty and the job failed
    // permanently rather than the item staying "pending" forever.
    const states = getRows<{ rel_path: string; processing_state: string }>(
      ctx.db,
      'SELECT rel_path, processing_state FROM media ORDER BY rel_path',
    );
    assert.deepEqual(
      states.map((row) => [row.rel_path, row.processing_state]),
      [
        ['broken.mp4', 'failed'],
        ['raw.osv', 'unsupported'],
      ],
    );
    const jobs = getRows<{ status: string }>(ctx.db, 'SELECT status FROM jobs');
    assert.ok(jobs.length > 0);
    assert.ok(jobs.every((job) => job.status !== 'retry_wait'), 'a permanent probe failure does not keep retrying');

    const osv = getRow<{ id: string; processing_state: string }>(
      ctx.db,
      `SELECT id, processing_state FROM media WHERE rel_path = 'raw.osv'`,
    );
    const broken = getRow<{ id: string }>(ctx.db, `SELECT id FROM media WHERE rel_path = 'broken.mp4'`);
    assert.ok(osv);
    assert.ok(broken);

    await createUser(ctx.db, 'viewer', TEST_PASSWORD);
    const cookie = await login(ctx.app, 'viewer');

    const osvDetail = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${osv.id}`,
      cookies: { nix_session: cookie },
    });
    assert.equal(osvDetail.statusCode, 200);
    const osvBody = osvDetail.json() as {
      experience: { state: string; detail: string; retryable: boolean };
      originalConversionRequired: boolean;
      playbackOptions: unknown[];
    };
    assert.equal(osvBody.experience.state, 'conversion_required');
    assert.match(osvBody.experience.detail, /DJI Studio/);
    assert.equal(osvBody.experience.retryable, false);
    assert.equal(osvBody.originalConversionRequired, true);
    assert.deepEqual(osvBody.playbackOptions, []);

    const brokenDetail = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${broken.id}`,
      cookies: { nix_session: cookie },
    });
    const brokenBody = brokenDetail.json() as {
      experience: { state: string; detail: string; retryable: boolean };
      originalConversionRequired: boolean;
    };
    assert.equal(brokenBody.experience.state, 'failed');
    assert.equal(brokenBody.experience.retryable, true);
    assert.match(brokenBody.experience.detail, /could not be read/);
    assert.equal(brokenBody.originalConversionRequired, false, 'a retryable failure is not a conversion request');

    // A video still queued for probing must present as processing, not as a
    // file the owner has to convert elsewhere.
    const pendingId = randomUUID();
    const now = nowIso();
    run(
      ctx.db,
      `INSERT INTO media (id, root_id, rel_path, extension, source_version, size_bytes, mtime_ms, media_type,
                          projection, availability, processing_state, last_seen_scan, created_at, updated_at)
       VALUES (?, 'test', 'queued.mp4', '.mp4', 1, 10, 0, 'video', 'unknown', 'present', 'pending', 1, ?, ?)`,
      pendingId,
      now,
      now,
    );
    const pendingDetail = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${pendingId}`,
      cookies: { nix_session: cookie },
    });
    const pendingBody = pendingDetail.json() as {
      experience: { state: string };
      originalConversionRequired: boolean;
      playbackOptions: unknown[];
    };
    assert.equal(pendingBody.experience.state, 'processing');
    assert.equal(pendingBody.originalConversionRequired, false);
    assert.deepEqual(pendingBody.playbackOptions, []);
  });
});
