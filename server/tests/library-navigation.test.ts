import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { after, describe, it } from 'node:test';
import { createTestContext, createUser, login, TEST_PASSWORD, type TestContext } from './helpers.ts';
import { enqueueScan, scanRoot } from '../src/media/scan.ts';
import { runWorker } from '../src/jobs/worker.ts';
import { getRow, getRows, run } from '../src/db/sqlite.ts';

async function drainQueue(ctx: TestContext): Promise<void> {
  for (let i = 0; i < 16; i += 1) {
    await runWorker({
      db: ctx.db,
      config: ctx.config,
      signal: new AbortController().signal,
      once: true,
      log: () => {},
    });
  }
}

async function writeJpeg(file: string, width: number, height: number, rgb: [number, number, number]): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .jpeg()
    .toFile(file);
}

type FolderListing = { folders: { name: string; path: string; count: number }[]; mediaCount: number; truncated: boolean };
type LibraryPage = { items: { fileName: string; folder: string }[] };

describe('library navigation, duplicates and queue control', () => {
  let ctx: TestContext;
  let viewerCookie: string;
  let adminCookie: string;

  after(async () => {
    await ctx?.cleanup();
  });

  it('indexes nested folders and exposes them for navigation', async () => {
    ctx = await createTestContext();
    await writeJpeg(path.join(ctx.mediaRoot, 'DCIM/100MEDIA/alpha.jpg'), 200, 150, [10, 20, 30]);
    await writeJpeg(path.join(ctx.mediaRoot, 'DCIM/100MEDIA/beta.jpg'), 210, 150, [30, 20, 10]);
    await writeJpeg(path.join(ctx.mediaRoot, 'Clips/gamma.jpg'), 220, 150, [10, 90, 30]);

    const stats = await scanRoot(ctx.db, ctx.config, 'test');
    assert.equal(stats.filesAdded, 3);

    await createUser(ctx.db, 'viewer', TEST_PASSWORD);
    viewerCookie = await login(ctx.app, 'viewer');

    const unauthorized = await ctx.app.inject({ method: 'GET', url: '/api/folders' });
    assert.equal(unauthorized.statusCode, 401);

    const root = await ctx.app.inject({ method: 'GET', url: '/api/folders', cookies: { nix_session: viewerCookie } });
    assert.equal(root.statusCode, 200);
    const listing = root.json() as FolderListing;
    assert.deepEqual(
      listing.folders.map((entry) => entry.name),
      ['Clips', 'DCIM'],
    );
    assert.equal(listing.folders.find((entry) => entry.name === 'DCIM')?.count, 2);
    assert.equal(listing.mediaCount, 0);

    const nestedResponse = await ctx.app.inject({
      method: 'GET',
      url: '/api/folders?path=DCIM',
      cookies: { nix_session: viewerCookie },
    });
    const nested = nestedResponse.json() as FolderListing;
    assert.equal(nested.folders.length, 1);
    assert.equal(nested.folders[0]?.name, '100MEDIA');
    assert.equal(nested.folders[0]?.count, 2);
    assert.equal(nested.folders[0]?.path, 'DCIM/100MEDIA');

    const traversal = await ctx.app.inject({
      method: 'GET',
      url: '/api/folders?path=..%2Fsecret',
      cookies: { nix_session: viewerCookie },
    });
    assert.equal(traversal.statusCode, 400);

    const filteredResponse = await ctx.app.inject({
      method: 'GET',
      url: '/api/library?folder=DCIM/100MEDIA',
      cookies: { nix_session: viewerCookie },
    });
    const filtered = filteredResponse.json() as LibraryPage;
    assert.equal(filtered.items.length, 2);
    assert.ok(filtered.items.every((item) => item.folder === 'DCIM/100MEDIA'));

    const searchResponse = await ctx.app.inject({
      method: 'GET',
      url: '/api/library?q=alpha',
      cookies: { nix_session: viewerCookie },
    });
    const search = searchResponse.json() as LibraryPage;
    assert.deepEqual(
      search.items.map((item) => item.fileName),
      ['alpha.jpg'],
    );

    // Capture metadata is absent for generated fixtures, so the date filter
    // falls back to the catalog insertion date.
    const recent = (
      await ctx.app.inject({ method: 'GET', url: '/api/library?from=2000-01-01', cookies: { nix_session: viewerCookie } })
    ).json() as LibraryPage;
    assert.equal(recent.items.length, 3);

    const none = (
      await ctx.app.inject({ method: 'GET', url: '/api/library?to=2000-12-31', cookies: { nix_session: viewerCookie } })
    ).json() as LibraryPage;
    assert.equal(none.items.length, 0);

    const malformed = await ctx.app.inject({
      method: 'GET',
      url: '/api/library?from=05-11-2026',
      cookies: { nix_session: viewerCookie },
    });
    assert.equal(malformed.statusCode, 400);
  });

  it('filters the gallery by a GPS bounding box', async () => {
    await drainQueue(ctx);
    const alpha = getRow<{ id: string }>(ctx.db, `SELECT id FROM media WHERE rel_path = 'DCIM/100MEDIA/alpha.jpg'`);
    const gamma = getRow<{ id: string }>(ctx.db, `SELECT id FROM media WHERE rel_path = 'Clips/gamma.jpg'`);
    assert.ok(alpha && gamma);
    run(ctx.db, 'UPDATE media_metadata SET gps_lat = 14.5995, gps_lon = 120.9842 WHERE media_id = ?', alpha.id);
    run(ctx.db, 'UPDATE media_metadata SET gps_lat = 51.5074, gps_lon = -0.1278 WHERE media_id = ?', gamma.id);

    const near = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/library?latMin=14&latMax=15&lonMin=120&lonMax=121',
        cookies: { nix_session: viewerCookie },
      })
    ).json() as LibraryPage;
    assert.deepEqual(
      near.items.map((item) => item.fileName),
      ['alpha.jpg'],
    );

    const partial = await ctx.app.inject({
      method: 'GET',
      url: '/api/library?latMin=14',
      cookies: { nix_session: viewerCookie },
    });
    assert.equal(partial.statusCode, 400);

    const inverted = await ctx.app.inject({
      method: 'GET',
      url: '/api/library?latMin=15&latMax=14&lonMin=120&lonMax=121',
      cookies: { nix_session: viewerCookie },
    });
    assert.equal(inverted.statusCode, 400);
  });

  it('confirms duplicates by content hash and reports them without deleting', async () => {
    fs.copyFileSync(
      path.join(ctx.mediaRoot, 'DCIM/100MEDIA/alpha.jpg'),
      path.join(ctx.mediaRoot, 'Clips/alpha-copy.jpg'),
    );
    const stats = await scanRoot(ctx.db, ctx.config, 'test');
    assert.equal(stats.filesAdded, 1);
    await drainQueue(ctx);

    const rows = getRows<{ content_hash: string | null; rel_path: string }>(
      ctx.db,
      `SELECT content_hash, rel_path FROM media
        WHERE rel_path IN ('DCIM/100MEDIA/alpha.jpg', 'Clips/alpha-copy.jpg')
        ORDER BY rel_path`,
    );
    assert.equal(rows.length, 2);
    assert.ok(rows[0]?.content_hash, 'the hash job recorded a digest');
    assert.equal(rows[0]?.content_hash, rows[1]?.content_hash);

    const copy = getRow<{ id: string }>(ctx.db, `SELECT id FROM media WHERE rel_path = 'Clips/alpha-copy.jpg'`);
    assert.ok(copy);
    const detailResponse = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${copy.id}`,
      cookies: { nix_session: viewerCookie },
    });
    const detail = detailResponse.json() as { duplicateCount: number; contentHash: string | null };
    assert.equal(detail.duplicateCount, 1);
    assert.ok(detail.contentHash);

    await createUser(ctx.db, 'owner', TEST_PASSWORD, 'admin');
    adminCookie = await login(ctx.app, 'owner');

    const duplicatesResponse = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/duplicates',
      cookies: { nix_session: adminCookie },
    });
    assert.equal(duplicatesResponse.statusCode, 200);
    const duplicates = duplicatesResponse.json() as {
      groups: { count: number; items: { relativePath: string }[] }[];
      reclaimableBytes: number;
    };
    const group = duplicates.groups.find((entry) =>
      entry.items.some((item) => item.relativePath === 'Clips/alpha-copy.jpg'),
    );
    assert.ok(group, 'the identical copy is grouped');
    assert.ok(group.count >= 2);
    assert.ok(duplicates.reclaimableBytes > 0);

    const viewerDenied = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/duplicates',
      cookies: { nix_session: viewerCookie },
    });
    assert.equal(viewerDenied.statusCode, 403);
    assert.ok(fs.existsSync(path.join(ctx.mediaRoot, 'Clips/alpha-copy.jpg')), 'duplicates are never deleted');
  });

  it('pauses claiming durably and resumes on request', async () => {
    const jobId = enqueueScan(ctx.db, 'test', 50);
    assert.ok(jobId);

    const pause = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/queue',
      payload: { paused: true },
      cookies: { nix_session: adminCookie },
    });
    assert.equal(pause.statusCode, 200);
    assert.equal((pause.json() as { queuePaused: boolean }).queuePaused, true);

    await runWorker({
      db: ctx.db,
      config: ctx.config,
      signal: new AbortController().signal,
      once: true,
      log: () => {},
    });
    assert.equal(getRow<{ status: string }>(ctx.db, 'SELECT status FROM jobs WHERE id = ?', jobId)?.status, 'queued');

    const resume = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/queue',
      payload: { paused: false },
      cookies: { nix_session: adminCookie },
    });
    assert.equal(resume.statusCode, 200);

    await runWorker({
      db: ctx.db,
      config: ctx.config,
      signal: new AbortController().signal,
      once: true,
      log: () => {},
    });
    assert.equal(getRow<{ status: string }>(ctx.db, 'SELECT status FROM jobs WHERE id = ?', jobId)?.status, 'succeeded');
  });
});
