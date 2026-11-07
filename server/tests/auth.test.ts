import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { createTestContext, createUser, login, TEST_PASSWORD, type TestContext } from './helpers.ts';
import { getRow } from '../src/db/sqlite.ts';

describe('authentication and authorization', () => {
  let ctx: TestContext;

  after(async () => {
    await ctx?.cleanup();
  });

  it('rejects anonymous access to library and admin endpoints', async () => {
    ctx = await createTestContext();
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/api/library' })).statusCode, 401);
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/api/admin/status' })).statusCode, 401);
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/api/media/unknown/original' })).statusCode, 401);
  });

  it('stores Argon2id hashes and never the plaintext password', async () => {
    await createUser(ctx.db, 'owner', TEST_PASSWORD, 'admin');
    const row = getRow<{ password_hash: string }>(ctx.db, `SELECT password_hash FROM users WHERE login = 'owner'`);
    assert.ok(row);
    assert.match(row.password_hash, /^\$argon2id\$/);
    assert.ok(!row.password_hash.includes(TEST_PASSWORD));
  });

  it('authenticates, sets a hardened cookie and resolves the session', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'OWNER', password: TEST_PASSWORD },
    });
    assert.equal(response.statusCode, 200);
    const cookie = String(response.headers['set-cookie']);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\//i);

    const token = await login(ctx.app, 'owner');
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', ...{ cookies: { nix_session: token } } });
    assert.equal(me.statusCode, 200);
    assert.equal((JSON.parse(me.body) as { user: { role: string } }).user.role, 'admin');
  });

  it('rejects wrong passwords without revealing which field failed', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'owner', password: 'wrong password entirely' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal((JSON.parse(response.body) as { error: string }).error, 'invalid_credentials');

    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'nobody', password: 'whatever password' },
    });
    assert.equal(unknown.statusCode, 401);
    assert.equal((JSON.parse(unknown.body) as { error: string }).error, 'invalid_credentials');
  });

  it('forbids viewer accounts from admin operations', async () => {
    await createUser(ctx.db, 'viewer1', TEST_PASSWORD, 'viewer');
    const token = await login(ctx.app, 'viewer1');
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/status',
      cookies: { nix_session: token },
    });
    assert.equal(response.statusCode, 403);

    const scan = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/roots/test/scan',
      cookies: { nix_session: token },
    });
    assert.equal(scan.statusCode, 403);
  });

  it('revokes the session on logout', async () => {
    const token = await login(ctx.app, 'owner');
    const before = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', cookies: { nix_session: token } });
    assert.equal(before.statusCode, 200);

    const loggedOut = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { nix_session: token },
    });
    assert.equal(loggedOut.statusCode, 200);

    const after = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', cookies: { nix_session: token } });
    assert.equal(after.statusCode, 401);
  });

  it('revokes sessions when an account is disabled', async () => {
    const viewerId = await createUser(ctx.db, 'viewer2', TEST_PASSWORD, 'viewer');
    const token = await login(ctx.app, 'viewer2');
    const adminToken = await login(ctx.app, 'owner');

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${viewerId}`,
      payload: { enabled: false },
      cookies: { nix_session: adminToken },
    });
    assert.equal(patch.statusCode, 200);

    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', cookies: { nix_session: token } });
    assert.equal(me.statusCode, 401);
  });

  it('rejects cross-origin state changes but allows same-origin', async () => {
    const token = await login(ctx.app, 'owner');
    const crossSite = await ctx.app.inject({
      method: 'POST',
      url: '/api/history',
      payload: { mediaId: 'x' },
      headers: { origin: 'https://evil.example' },
      cookies: { nix_session: token },
    });
    assert.equal(crossSite.statusCode, 403);

    const sameOrigin = await ctx.app.inject({
      method: 'POST',
      url: '/api/history',
      payload: { mediaId: 'x' },
      headers: { origin: 'https://nix.test' },
      cookies: { nix_session: token },
    });
    // CSRF passed; the media simply does not exist.
    assert.equal(sameOrigin.statusCode, 404);
  });

  it('denies access with an expired session', async () => {
    const token = await login(ctx.app, 'owner');
    ctx.db
      .prepare('UPDATE sessions SET idle_expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), hashTokenForTest(token));
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', cookies: { nix_session: token } });
    assert.equal(me.statusCode, 401);
  });
});

function hashTokenForTest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
