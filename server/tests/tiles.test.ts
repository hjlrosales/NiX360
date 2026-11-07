import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { after, describe, it } from 'node:test';
import sharp from '../src/media/images.ts';
import { createTestContext, createUser, login, TEST_PASSWORD, type TestContext } from './helpers.ts';
import { scanRoot } from '../src/media/scan.ts';
import { runWorker } from '../src/jobs/worker.ts';
import { enqueue } from '../src/jobs/queue.ts';
import { getRow, getRows, run } from '../src/db/sqlite.ts';
import {
  PANO_MAX_LEVEL,
  PANO_TILE_RECIPE,
  panoEligible,
  panoTileCount,
} from '../src/media/tiles.ts';

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

async function averageColor(file: string): Promise<[number, number, number]> {
  const { data } = await sharp(file).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
  return [data[0]!, data[1]!, data[2]!];
}

/**
 * Equirectangular fixture: each 90° longitude band is a solid colour and the
 * poles are white/black. Each level-1 cube face sees the centre of its band, so
 * its average colour proves that the file was projected into the face that
 * Pannellum expects, not merely that some tiles exist.
 */
function equirectFixture(): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="2048">
    <rect width="4096" height="2048" fill="#777777"/>
    <rect x="1536" y="0" width="1024" height="2048" fill="#ff0000"/>
    <rect x="2560" y="0" width="1024" height="2048" fill="#0000ff"/>
    <rect x="3584" y="0" width="512" height="2048" fill="#00ff00"/>
    <rect x="0" y="0" width="512" height="2048" fill="#00ff00"/>
    <rect x="512" y="0" width="1024" height="2048" fill="#ffff00"/>
    <rect x="0" y="0" width="4096" height="512" fill="#ffffff"/>
    <rect x="0" y="1536" width="4096" height="512" fill="#000000"/>
  </svg>`;
  return Buffer.from(svg);
}

function assertColor(color: [number, number, number], channel: 0 | 1 | 2, message: string): void {
  const other = [0, 1, 2].filter((index) => index !== channel);
  assert.ok(color[channel] > 180, `${message}: dominant channel ${channel} was ${color.join(',')}`);
  for (const index of other) {
    assert.ok(color[index] < 100, `${message}: channel ${index} was ${color.join(',')}`);
  }
}

describe('tiled panorama pipeline', () => {
  let ctx: TestContext;

  after(async () => {
    await ctx?.cleanup();
  });

  it('only tiles large equirectangular photos', () => {
    assert.equal(panoTileCount(), 126);
    assert.equal(PANO_MAX_LEVEL, 3);
    assert.equal(panoEligible('photo', 'equirectangular', 4096), true);
    assert.equal(panoEligible('photo', 'equirectangular', 2048), false);
    assert.equal(panoEligible('photo', 'flat', 15520), false);
    assert.equal(panoEligible('video', 'equirectangular', 15520), false);
  });

  it('projects a panorama into an authorized, versioned tile pyramid', async () => {
    ctx = await createTestContext();
    const source = path.join(ctx.mediaRoot, 'sphere.jpg');
    await sharp(equirectFixture()).jpeg({ quality: 95 }).toFile(source);
    const originalHash = sha256(source);

    const stats = await scanRoot(ctx.db, ctx.config, 'test');
    assert.equal(stats.filesAdded, 1);
    await drainQueue(ctx);

    const media = getRow<{ id: string; projection: string; source_version: number; processing_state: string }>(
      ctx.db,
      `SELECT id, projection, source_version, processing_state FROM media WHERE rel_path = 'sphere.jpg'`,
    );
    assert.ok(media);
    assert.equal(media.processing_state, 'ready');
    // A 2:1 image without spherical metadata is deliberately not guessed.
    assert.equal(media.projection, 'unknown');
    assert.equal(
      getRow<{ id: string }>(ctx.db, `SELECT id FROM derivatives WHERE media_id = ? AND kind = 'tiles'`, media.id),
      undefined,
      'no tiles are generated for an unconfirmed projection',
    );

    // An explicit override (the same path a reviewed classification takes)
    // makes the photo eligible; the job is then queued normally.
    run(ctx.db, `UPDATE media SET projection = 'equirectangular', updated_at = ? WHERE id = ?`, new Date().toISOString(), media.id);
    enqueue(ctx.db, {
      kind: 'pano_tiles',
      dedupeKey: `tiles:${media.id}:v${media.source_version}:${PANO_TILE_RECIPE}`,
      mediaId: media.id,
      sourceVersion: media.source_version,
      profileVersion: PANO_TILE_RECIPE,
      priority: 0,
    });
    await drainQueue(ctx);

    const derivative = getRow<{ storage_key: string; bytes: number; width: number; height: number }>(
      ctx.db,
      `SELECT storage_key, bytes, width, height FROM derivatives
        WHERE media_id = ? AND recipe_version = ? AND kind = 'tiles' AND state = 'ready'`,
      media.id,
      PANO_TILE_RECIPE,
    );
    assert.ok(derivative, 'a tiles derivative was recorded');
    assert.equal(derivative.width, 2048);
    assert.ok(derivative.bytes > 0);

    const tileDir = path.dirname(path.join(ctx.config.derivativesDir, derivative.storage_key));
    assert.ok(fs.existsSync(path.join(tileDir, 'manifest.json')), 'manifest was published last');
    function countTiles(directory: string): number {
      return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
        const absolute = path.join(directory, entry.name);
        return total + (entry.isDirectory() ? countTiles(absolute) : entry.name.endsWith('.webp') ? 1 : 0);
      }, 0);
    }
    assert.equal(countTiles(tileDir), 126);

    // Pannellum's face letters must each hold the matching direction.
    assertColor(await averageColor(path.join(tileDir, 'l1/f0_0.webp')), 0, 'front face is red');
    assertColor(await averageColor(path.join(tileDir, 'l1/r0_0.webp')), 2, 'right face is blue');
    assertColor(await averageColor(path.join(tileDir, 'l1/b0_0.webp')), 1, 'back face is green');
    const left = await averageColor(path.join(tileDir, 'l1/l0_0.webp'));
    assert.ok(left[0] > 180 && left[1] > 180 && left[2] < 100, `left face is yellow: ${left.join(',')}`);
    const up = await averageColor(path.join(tileDir, 'l1/u0_0.webp'));
    assert.ok(up.every((value) => value > 200), `up face is white: ${up.join(',')}`);
    const down = await averageColor(path.join(tileDir, 'l1/d0_0.webp'));
    assert.ok(down.every((value) => value < 60), `down face is black: ${down.join(',')}`);

    await createUser(ctx.db, 'viewer', TEST_PASSWORD);
    const cookie = await login(ctx.app, 'viewer');

    const unauth = await ctx.app.inject({ method: 'GET', url: `/api/media/${media.id}/tiles` });
    assert.equal(unauth.statusCode, 401);

    const manifest = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${media.id}/tiles`,
      cookies: { nix_session: cookie },
    });
    assert.equal(manifest.statusCode, 200);
    const config = manifest.json() as {
      type: string;
      path: string;
      maxLevel: number;
      tileResolution: number;
      cubeResolution: number;
      preview: string | null;
      basePath: string;
      extension: string;
    };
    assert.equal(config.type, 'multires');
    assert.equal(config.path, 'l%l/%s%y_%x');
    assert.equal(config.maxLevel, 3);
    assert.equal(config.tileResolution, 512);
    assert.equal(config.cubeResolution, 2048);
    assert.equal(config.preview, `/api/media/${media.id}/preview`);

    // Pannellum concatenates basePath + path with no separator (browser-revealed
    // bug: "/tiles" + "l1/f0_0" requested "/tilesl1/f0_0"). The composed URL must
    // therefore resolve to the tile route.
    assert.equal(config.basePath, `/api/media/${media.id}/tiles/`);
    assert.equal(config.extension, 'webp');
    const composed = `${config.basePath}${config.path
      .replace('%l', '3')
      .replace('%s', 'f')
      .replace('%y', '0')
      .replace('%x', '0')}.${config.extension}`;
    assert.equal(composed, `/api/media/${media.id}/tiles/l3/f0_0.webp`);
    const composedTile = await ctx.app.inject({
      method: 'GET',
      url: composed,
      cookies: { nix_session: cookie },
    });
    assert.equal(composedTile.statusCode, 200, 'the composed Pannellum URL is a real tile');

    const tile = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${media.id}/tiles/l3/f0_0.webp`,
      cookies: { nix_session: cookie },
    });
    assert.equal(tile.statusCode, 200);
    assert.equal(tile.headers['content-type'], 'image/webp');

    const unauthTile = await ctx.app.inject({ method: 'GET', url: `/api/media/${media.id}/tiles/l3/f0_0.webp` });
    assert.equal(unauthTile.statusCode, 401);

    for (const bad of ['l4/f0_0.webp', 'l0/f0_0.webp', 'l3/f4_0.webp', 'l2/f0_2.webp', 'l1/z0_0.webp']) {
      const response: { statusCode: number } = await ctx.app.inject({
        method: 'GET',
        url: `/api/media/${media.id}/tiles/${bad}`,
        cookies: { nix_session: cookie },
      });
      assert.equal(response.statusCode, 404, `${bad} must not resolve`);
    }

    assert.equal(sha256(source), originalHash, 'the original is never modified');
    const failed = getRows<{ kind: string }>(ctx.db, `SELECT kind FROM jobs WHERE status = 'failed'`);
    assert.deepEqual(failed, []);

    // Re-running is idempotent and does not publish a second derivative row.
    enqueue(ctx.db, {
      kind: 'pano_tiles',
      dedupeKey: `tiles:${media.id}:v${media.source_version}:${PANO_TILE_RECIPE}`,
      mediaId: media.id,
      sourceVersion: media.source_version,
      profileVersion: PANO_TILE_RECIPE,
      priority: 0,
    });
    await drainQueue(ctx);
    const rows = getRows<{ count: number }>(
      ctx.db,
      `SELECT COUNT(*) AS count FROM derivatives WHERE media_id = ? AND kind = 'tiles'`,
      media.id,
    );
    assert.equal(Number(rows[0]?.count), 1);
    const succeeded = getRows<{ kind: string; status: string }>(
      ctx.db,
      `SELECT kind, status FROM jobs WHERE kind = 'pano_tiles' AND status = 'succeeded'`,
    );
    assert.ok(succeeded.length >= 2, 'the second run reused the ready pyramid');
  });
});
