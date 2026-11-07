import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { syncConfiguredOwner } from '../src/auth/configured-owner.ts';
import { verifyPassword } from '../src/auth/password.ts';
import { hashToken, issueSession } from '../src/auth/session.ts';
import { loadConfig } from '../src/config.ts';
import { getRow, run } from '../src/db/sqlite.ts';
import { createTestContext, type TestContext } from './helpers.ts';

describe('environment-managed owner', () => {
  let ctx: TestContext;

  after(async () => {
    await ctx?.cleanup();
  });

  it('parses only an explicit, valid owner configuration', () => {
    assert.equal(loadConfig({ NODE_ENV: 'test' }).configuredOwner, null);
    assert.throws(
      () => loadConfig({ NODE_ENV: 'test', NIX_OWNER_LOGIN: 'owner' }),
      /NIX_OWNER_PASSWORD is required/,
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: 'test', NIX_OWNER_PASSWORD: 'too-short' }),
      /12-512 characters/,
    );
    assert.deepEqual(
      loadConfig({
        NODE_ENV: 'test',
        NIX_OWNER_LOGIN: 'OWNER',
        NIX_OWNER_DISPLAY_NAME: 'Library Owner',
        NIX_OWNER_PASSWORD: 'first private password',
      }).configuredOwner,
      { login: 'owner', displayName: 'Library Owner', password: 'first private password' },
    );
  });

  it('creates the owner, preserves sessions when unchanged and revokes them after password rotation', async () => {
    ctx = await createTestContext();
    const first = { login: 'owner', displayName: 'Owner', password: 'first private password' };
    assert.equal(await syncConfiguredOwner(ctx.db, first), 'created');

    const created = getRow<{
      id: string;
      password_hash: string;
      role: string;
      enabled: number;
    }>(ctx.db, 'SELECT id, password_hash, role, enabled FROM users WHERE login = ?', 'owner');
    assert.ok(created);
    assert.equal(created.role, 'admin');
    assert.equal(created.enabled, 1);
    assert.equal(await verifyPassword(created.password_hash, first.password), true);

    const session = issueSession(ctx.db, ctx.config, created.id, 'configured-owner-test');
    assert.equal(await syncConfiguredOwner(ctx.db, first), 'unchanged');
    assert.equal(
      getRow<{ revoked_at: string | null }>(ctx.db, 'SELECT revoked_at FROM sessions WHERE id = ?', hashToken(session.token))
        ?.revoked_at,
      null,
    );

    const changed = { ...first, displayName: 'Household Owner', password: 'second private password' };
    assert.equal(await syncConfiguredOwner(ctx.db, changed), 'updated');
    const updated = getRow<{ display_name: string; password_hash: string }>(
      ctx.db,
      'SELECT display_name, password_hash FROM users WHERE id = ?',
      created.id,
    );
    assert.ok(updated);
    assert.equal(updated.display_name, 'Household Owner');
    assert.equal(await verifyPassword(updated.password_hash, first.password), false);
    assert.equal(await verifyPassword(updated.password_hash, changed.password), true);
    assert.ok(
      getRow<{ revoked_at: string | null }>(ctx.db, 'SELECT revoked_at FROM sessions WHERE id = ?', hashToken(session.token))
        ?.revoked_at,
    );

    run(ctx.db, "UPDATE users SET role = 'viewer', enabled = 0 WHERE id = ?", created.id);
    assert.equal(await syncConfiguredOwner(ctx.db, changed), 'updated');
    const restored = getRow<{ role: string; enabled: number }>(ctx.db, 'SELECT role, enabled FROM users WHERE id = ?', created.id);
    assert.equal(restored?.role, 'admin');
    assert.equal(restored?.enabled, 1);

    const audit = getRow<{ detail: string }>(
      ctx.db,
      "SELECT detail FROM audit_events WHERE action = 'auth.configured_owner_updated' ORDER BY id LIMIT 1",
    );
    assert.ok(audit);
    assert.ok(!audit.detail.includes(changed.password));
  });
});
