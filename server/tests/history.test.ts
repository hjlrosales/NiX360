import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import sharp from '../src/media/images.ts';
import { createTestContext, createUser, login, TEST_PASSWORD, type TestContext } from './helpers.ts';
import { scanRoot } from '../src/media/scan.ts';
import { getRow } from '../src/db/sqlite.ts';

describe('playback position persistence', () => {
  let ctx: TestContext;

  after(async () => {
    await ctx?.cleanup();
  });

  it('returns the signed-in user\'s resume point and never erases it by opening', async () => {
    ctx = await createTestContext();
    await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 40, g: 80, b: 120 } } })
      .jpeg()
      .toFile(path.join(ctx.mediaRoot, 'clip.jpg'));
    await scanRoot(ctx.db, ctx.config, 'test');

    const media = getRow<{ id: string }>(ctx.db, `SELECT id FROM media WHERE rel_path = 'clip.jpg'`);
    if (!media) throw new Error('fixture media row was not catalogued');
    const mediaId = media.id;

    await createUser(ctx.db, 'viewer', TEST_PASSWORD);
    await createUser(ctx.db, 'friend', TEST_PASSWORD);
    const cookie = await login(ctx.app, 'viewer');

    const unauthorized = await ctx.app.inject({ method: 'GET', url: `/api/media/${mediaId}` });
    assert.equal(unauthorized.statusCode, 401);

    async function detail(session: string): Promise<{ playbackPositionSeconds: number | null }> {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/media/${mediaId}`,
        cookies: { nix_session: session },
      });
      assert.equal(response.statusCode, 200);
      return response.json() as { playbackPositionSeconds: number | null };
    }

    assert.equal((await detail(cookie)).playbackPositionSeconds, null);

    const saved = await ctx.app.inject({
      method: 'POST',
      url: '/api/history',
      cookies: { nix_session: cookie },
      payload: { mediaId, positionSeconds: 42.9 },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal((await detail(cookie)).playbackPositionSeconds, 42, 'positions are stored as whole seconds');

    // Opening the viewer posts no position; that must not clear the resume point.
    await ctx.app.inject({
      method: 'POST',
      url: '/api/history',
      cookies: { nix_session: cookie },
      payload: { mediaId },
    });
    assert.equal((await detail(cookie)).playbackPositionSeconds, 42);

    // Malformed or negative positions are ignored rather than written.
    for (const positionSeconds of [-3, 'later', null]) {
      const response: { statusCode: number } = await ctx.app.inject({
        method: 'POST',
        url: '/api/history',
        cookies: { nix_session: cookie },
        payload: { mediaId, positionSeconds },
      });
      assert.equal(response.statusCode, 200);
    }
    assert.equal((await detail(cookie)).playbackPositionSeconds, 42);

    await ctx.app.inject({
      method: 'POST',
      url: '/api/history',
      cookies: { nix_session: cookie },
      payload: { mediaId, positionSeconds: 12 },
    });
    assert.equal((await detail(cookie)).playbackPositionSeconds, 12);

    // Resume state is per user, not shared by the household library.
    const friendCookie = await login(ctx.app, 'friend');
    assert.equal((await detail(friendCookie)).playbackPositionSeconds, null);

    // Finishing a video resets its resume point to the beginning.
    await ctx.app.inject({
      method: 'POST',
      url: '/api/history',
      cookies: { nix_session: cookie },
      payload: { mediaId, positionSeconds: 0 },
    });
    assert.equal((await detail(cookie)).playbackPositionSeconds, 0);
  });
});
