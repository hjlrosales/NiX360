import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import sharp from '../src/media/images.ts';
import { createTestContext, createUser, login, TEST_PASSWORD, type TestContext } from './helpers.ts';
import { scanRoot } from '../src/media/scan.ts';
import { runWorker } from '../src/jobs/worker.ts';
import { getRow, getRows, run } from '../src/db/sqlite.ts';
import { PANO_TILE_RECIPE } from '../src/media/tiles.ts';
import { nowIso } from '../src/config.ts';

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

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function equirectFixture(): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="2048">
      <rect width="4096" height="2048" fill="#334455"/>
      <rect x="0" y="0" width="2048" height="2048" fill="#884422"/>
    </svg>`,
  );
}

type Detail = {
  id: string;
  projection: string;
  tiles: { state: string; recipe: string; reason: string | null } | null;
  overrides: { projection: string | null; yaw_degrees: number | null; pitch_degrees: number | null; roll_degrees: number | null } | null;
  metadata: { projectionSource: string } | null;
};

describe('panorama overrides and tile status', () => {
  let ctx: TestContext;
  let accepted = 0;

  after(async () => {
    await ctx?.cleanup();
  });

  it('re-classifies a photo through the API, re-queues tiles and stores a start view', async () => {
    ctx = await createTestContext();
    const source = path.join(ctx.mediaRoot, 'sphere.jpg');
    const other = path.join(ctx.mediaRoot, 'sphere-failed.jpg');
    await sharp(equirectFixture()).jpeg({ quality: 90 }).toFile(source);
    await sharp(equirectFixture()).jpeg({ quality: 90 }).toFile(other);
    const originalHash = sha256(source);
    await scanRoot(ctx.db, ctx.config, 'test');
    // Probing records dimensions; tile eligibility needs the measured width.
    await drainQueue(ctx);

    const media = getRow<{ id: string; source_version: number; projection: string }>(
      ctx.db,
      `SELECT id, source_version, projection FROM media WHERE rel_path = 'sphere.jpg'`,
    );
    assert.ok(media);
    assert.equal(media.projection, 'unknown', 'a 2:1 image is not guessed to be a sphere');

    const otherMedia = getRow<{ id: string; source_version: number }>(
      ctx.db,
      `SELECT id, source_version FROM media WHERE rel_path = 'sphere-failed.jpg'`,
    );
    assert.ok(otherMedia);

    await createUser(ctx.db, 'viewer', TEST_PASSWORD);
    await createUser(ctx.db, 'owner', TEST_PASSWORD, 'admin');
    const viewer = await login(ctx.app, 'viewer');
    const admin = await login(ctx.app, 'owner');

    async function detail(id: string): Promise<Detail> {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/media/${id}`,
        cookies: { nix_session: viewer },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json() as Detail;
    }

    async function patch(id: string, payload: Record<string, unknown>, cookie = admin) {
      const response = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/media/${id}/overrides`,
        cookies: { nix_session: cookie },
        payload,
      });
      if (response.statusCode === 200 && cookie === admin) accepted += 1;
      return response;
    }

    async function libraryProjection(projection: string): Promise<string[]> {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/library?projection=${projection}`,
        cookies: { nix_session: viewer },
      });
      assert.equal(response.statusCode, 200, response.body);
      const page = response.json() as { items: { id: string }[] };
      return page.items.map((item) => item.id);
    }

    // An unconfirmed projection is not "still processing"; it will never tile.
    const initial = await detail(media.id);
    assert.equal(initial.tiles?.state, 'ineligible');
    assert.match(initial.tiles!.reason!, /not confirmed/i);
    assert.equal(initial.overrides, null);

    // Classification is an administrative override, and it queues the tiles.
    const classified = await patch(media.id, { projection: 'equirectangular' });
    assert.equal(classified.statusCode, 200, classified.body);
    assert.equal((classified.json() as { projection: string }).projection, 'equirectangular');
    assert.equal((classified.json() as { tiles: { state: string } }).tiles.state, 'pending');

    const pending = await detail(media.id);
    assert.equal(pending.projection, 'equirectangular');
    assert.equal(pending.tiles?.state, 'pending');
    assert.equal(pending.overrides?.projection, 'equirectangular');
    assert.equal(pending.metadata?.projectionSource, 'override');
    assert.deepEqual(await libraryProjection('equirectangular'), [media.id], 'filters use the override');

    await drainQueue(ctx);
    const ready = await detail(media.id);
    assert.equal(ready.tiles?.state, 'ready');
    assert.equal(ready.tiles?.recipe, PANO_TILE_RECIPE);

    const manifest = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${media.id}/tiles`,
      cookies: { nix_session: viewer },
    });
    assert.equal(manifest.statusCode, 200);

    // A failed job is reported as a failure with its reason, not as pending.
    assert.equal((await patch(otherMedia!.id, { projection: 'equirectangular' })).statusCode, 200);
    const now = nowIso();
    run(
      ctx.db,
      `INSERT INTO jobs (id, kind, media_id, source_version, dedupe_key, status, next_run_at, attempts, last_error, created_at, updated_at)
       VALUES (?, 'pano_tiles', ?, ?, ?, 'failed', ?, 4, 'Cube projection failed: fixture', ?, ?)`,
      randomUUID(),
      otherMedia!.id,
      otherMedia!.source_version,
      `tiles:${otherMedia!.id}:v${otherMedia!.source_version}`,
      now,
      new Date(Date.now() + 1000).toISOString(),
      now,
    );
    const failed = await detail(otherMedia!.id);
    assert.equal(failed.tiles?.state, 'failed');
    assert.equal(failed.tiles?.reason, 'Cube projection failed: fixture');

    // Withdrawing the sphere cancels queued tile work.
    assert.equal((await patch(otherMedia!.id, { projection: 'flat' })).statusCode, 200);
    const cancelled = getRows<{ status: string }>(
      ctx.db,
      `SELECT status FROM jobs WHERE kind = 'pano_tiles' AND media_id = ?`,
      otherMedia!.id,
    ).map((row) => row.status);
    assert.ok(cancelled.includes('cancelled'), `queued tile work was cancelled (${cancelled.join(',')})`);
    assert.equal((await detail(otherMedia!.id)).tiles?.state, 'ineligible');

    // A withdrawn sphere stops being served, even while its pyramid still exists.
    assert.equal((await patch(media.id, { projection: 'flat' })).statusCode, 200);
    const withdrawn = await detail(media.id);
    assert.equal(withdrawn.projection, 'flat');
    assert.equal(withdrawn.tiles?.state, 'ineligible');
    const withdrawnManifest = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${media.id}/tiles`,
      cookies: { nix_session: viewer },
    });
    assert.equal(withdrawnManifest.statusCode, 404);
    assert.equal((withdrawnManifest.json() as { error: string }).error, 'tiles_not_eligible');
    assert.ok(!(await libraryProjection('equirectangular')).includes(media.id));

    // null removes the override and falls back to probe evidence.
    assert.equal((await patch(media.id, { projection: null })).statusCode, 200);
    const fallback = await detail(media.id);
    assert.equal(fallback.projection, 'unknown');
    assert.equal(fallback.overrides?.projection, null);
    assert.equal(fallback.metadata?.projectionSource, 'aspect_hint');

    // Restoring the sphere reuses the existing pyramid instead of re-encoding it.
    assert.equal((await patch(media.id, { projection: 'equirectangular' })).statusCode, 200);
    await drainQueue(ctx);
    assert.equal((await detail(media.id)).tiles?.state, 'ready');
    const tileRows = getRows<{ count: number }>(
      ctx.db,
      `SELECT COUNT(*) AS count FROM derivatives WHERE media_id = ? AND kind = 'tiles'`,
      media.id,
    );
    assert.equal(Number(tileRows[0]?.count), 1);

    // Orientation is stored on the same row and keeps the projection.
    const unauth = await ctx.app.inject({ method: 'PATCH', url: `/api/media/${media.id}/overrides`, payload: { yawDegrees: 10 } });
    assert.equal(unauth.statusCode, 401);
    const forbidden = await patch(media.id, { yawDegrees: 10 }, viewer);
    assert.equal(forbidden.statusCode, 403, 'a viewer cannot change catalog metadata');

    for (const payload of [
      {},
      { yawDegrees: 'left' },
      { yawDegrees: 181 },
      { pitchDegrees: -91 },
      { rollDegrees: -181 },
      { pitchDegrees: 90.5 },
      { projection: 'spherical' },
    ]) {
      const response = await patch(media.id, payload);
      assert.equal(response.statusCode, 400, `rejected ${JSON.stringify(payload)}`);
    }

    const unknown = await patch(randomUUID(), { projection: 'flat' });
    assert.equal(unknown.statusCode, 404);

    const saved = await patch(media.id, { yawDegrees: 45, pitchDegrees: 10 });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual((saved.json() as { orientation: unknown }).orientation, { yaw: 45, pitch: 10, roll: 0 });
    assert.equal((saved.json() as { projection: string }).projection, 'equirectangular', 'orientation keeps the classification');

    const config = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${media.id}/tiles`,
      cookies: { nix_session: viewer },
    });
    assert.deepEqual((config.json() as { orientation: unknown }).orientation, { yaw: 45, pitch: 10, roll: 0 });

    // Absent fields are preserved rather than reset.
    const partial = await patch(media.id, { pitchDegrees: -4.5 });
    assert.deepEqual((partial.json() as { orientation: unknown }).orientation, { yaw: 45, pitch: -4.5, roll: 0 });

    // An explicit null clears one axis without disturbing the others.
    const cleared = await patch(media.id, { rollDegrees: null });
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual((cleared.json() as { orientation: unknown }).orientation, { yaw: 45, pitch: -4.5, roll: 0 });

    const persisted = await detail(media.id);
    assert.equal(persisted.overrides?.yaw_degrees, 45);
    assert.equal(persisted.overrides?.pitch_degrees, -4.5);
    assert.equal(persisted.overrides?.roll_degrees, null);

    const audits = getRows<{ action: string; target_id: string }>(
      ctx.db,
      `SELECT action, target_id FROM audit_events WHERE action = 'media.overrides_changed'`,
    );
    assert.equal(audits.length, accepted, 'every accepted change is audited');
    assert.ok(audits.every((row) => row.target_id === media.id || row.target_id === otherMedia!.id));

    assert.equal(sha256(source), originalHash, 'the original is never modified');
  });
});
