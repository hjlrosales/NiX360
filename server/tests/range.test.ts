import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createTestContext, createUser, login, TEST_PASSWORD, type TestContext } from './helpers.ts';
import { parseRangeHeader } from '../src/media/range.ts';
import { nowIso } from '../src/config.ts';

describe('range parsing', () => {
  it('handles explicit, open, suffix, malformed and impossible ranges', () => {
    assert.deepEqual(parseRangeHeader(undefined, 100), { kind: 'full' });
    assert.deepEqual(parseRangeHeader('bytes=0-9', 100), { kind: 'partial', start: 0, end: 9 });
    assert.deepEqual(parseRangeHeader('bytes=50-', 100), { kind: 'partial', start: 50, end: 99 });
    assert.deepEqual(parseRangeHeader('bytes=-20', 100), { kind: 'partial', start: 80, end: 99 });
    assert.deepEqual(parseRangeHeader('bytes=-500', 100), { kind: 'partial', start: 0, end: 99 });
    assert.deepEqual(parseRangeHeader('bytes=90-1000', 100), { kind: 'partial', start: 90, end: 99 });
    assert.deepEqual(parseRangeHeader('bytes=100-', 100), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRangeHeader('bytes=50-10', 100), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRangeHeader('bytes=-0', 100), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRangeHeader('items=0-9', 100), { kind: 'full' });
    assert.deepEqual(parseRangeHeader('bytes=0-9,20-29', 100), { kind: 'full' });
    assert.deepEqual(parseRangeHeader('bytes=abc', 100), { kind: 'full' });
    assert.deepEqual(parseRangeHeader('bytes=0-0', 0), { kind: 'unsatisfiable' });
  });
});

describe('private media delivery', () => {
  let ctx: TestContext;
  let token: string;
  let mediaId: string;
  const payload = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  before(async () => {
    ctx = await createTestContext();
    await createUser(ctx.db, 'owner', TEST_PASSWORD, 'admin');
    token = await login(ctx.app, 'owner');

    const filePath = path.join(ctx.mediaRoot, 'clip.jpg');
    fs.writeFileSync(filePath, payload);
    mediaId = randomUUID();
    const now = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO media (id, root_id, rel_path, extension, source_version, size_bytes, mtime_ms, media_type,
                            projection, availability, processing_state, last_seen_scan, created_at, updated_at)
         VALUES (?, 'test', 'clip.jpg', '.jpg', 1, ?, ?, 'photo', 'flat', 'present', 'ready', 1, ?, ?)`,
      )
      .run(mediaId, payload.length, Math.floor(Date.now()), now, now);
  });

  after(async () => {
    await ctx.cleanup();
  });

  it('requires a session for every representation', async () => {
    for (const url of [
      `/api/media/${mediaId}/original`,
      `/api/media/${mediaId}/thumbnail`,
      `/api/media/${mediaId}/preview`,
    ]) {
      const response = await ctx.app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, url);
    }
  });

  it('serves the full file with private cache headers', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/original`,
      cookies: { nix_session: token },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/jpeg');
    assert.equal(response.headers['accept-ranges'], 'bytes');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(Number(response.headers['content-length']), payload.length);
    assert.equal(response.body, payload);
  });

  it('serves byte ranges with 206 and correct Content-Range', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/original`,
      headers: { range: 'bytes=10-19' },
      cookies: { nix_session: token },
    });
    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['content-range'], `bytes 10-19/${payload.length}`);
    assert.equal(Number(response.headers['content-length']), 10);
    assert.equal(response.body, payload.slice(10, 20));
  });

  it('supports suffix and open-ended ranges', async () => {
    const suffix = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/original`,
      headers: { range: 'bytes=-5' },
      cookies: { nix_session: token },
    });
    assert.equal(suffix.statusCode, 206);
    assert.equal(suffix.body, payload.slice(-5));

    const open = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/original`,
      headers: { range: 'bytes=30-' },
      cookies: { nix_session: token },
    });
    assert.equal(open.statusCode, 206);
    assert.equal(open.body, payload.slice(30));
  });

  it('returns 416 with */size for impossible ranges', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/original`,
      headers: { range: 'bytes=9999-' },
      cookies: { nix_session: token },
    });
    assert.equal(response.statusCode, 416);
    assert.equal(response.headers['content-range'], `bytes */${payload.length}`);
  });

  it('answers HEAD without a body and revalidates with ETag', async () => {
    const head = await ctx.app.inject({
      method: 'HEAD',
      url: `/api/media/${mediaId}/original`,
      cookies: { nix_session: token },
    });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    assert.equal(Number(head.headers['content-length']), payload.length);

    const etag = head.headers.etag;
    assert.ok(etag);
    const revalidated = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/original`,
      headers: { 'if-none-match': String(etag) },
      cookies: { nix_session: token },
    });
    assert.equal(revalidated.statusCode, 304);
  });

  it('reports a missing derivative instead of leaking a path', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/thumbnail`,
      cookies: { nix_session: token },
    });
    assert.equal(response.statusCode, 404);
    assert.equal((JSON.parse(response.body) as { error: string }).error, 'derivative_not_ready');
  });

  it('refuses to stream a catalog path that escapes the root', async () => {
    const escapeId = randomUUID();
    const now = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO media (id, root_id, rel_path, extension, source_version, size_bytes, mtime_ms, media_type,
                            projection, availability, processing_state, last_seen_scan, created_at, updated_at)
         VALUES (?, 'test', '../outside.jpg', '.jpg', 1, 10, 0, 'photo', 'flat', 'present', 'ready', 1, ?, ?)`,
      )
      .run(escapeId, now, now);

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${escapeId}/original`,
      cookies: { nix_session: token },
    });
    assert.equal(response.statusCode, 404);
    assert.equal((JSON.parse(response.body) as { error: string }).error, 'media_missing');
  });
});
