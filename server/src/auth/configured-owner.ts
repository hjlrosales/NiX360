import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ConfiguredOwner } from '../config.ts';
import { nowIso } from '../config.ts';
import { getRow, run, transaction } from '../db/sqlite.ts';
import { audit } from './routes.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { revokeUserSessions } from './session.ts';

type OwnerRow = {
  id: string;
  display_name: string;
  password_hash: string;
  role: 'admin' | 'viewer';
  enabled: number;
};

export type ConfiguredOwnerResult = 'created' | 'updated' | 'unchanged';

/**
 * Reconciles the explicitly configured owner before the API starts listening.
 * The password is hashed before persistence and is never returned or logged.
 * A matching password is left untouched so an ordinary restart does not revoke
 * sessions or generate a new Argon2 salt.
 */
export async function syncConfiguredOwner(
  db: DatabaseSync,
  owner: ConfiguredOwner,
): Promise<ConfiguredOwnerResult> {
  const existing = getRow<OwnerRow>(
    db,
    'SELECT id, display_name, password_hash, role, enabled FROM users WHERE login = ?',
    owner.login,
  );
  const now = nowIso();

  if (!existing) {
    const id = randomUUID();
    const passwordHash = await hashPassword(owner.password);
    transaction(db, () => {
      run(
        db,
        'INSERT INTO users (id, login, display_name, password_hash, role, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        id,
        owner.login,
        owner.displayName,
        passwordHash,
        'admin',
        now,
        now,
      );
      audit(db, null, 'auth.configured_owner_created', id);
    });
    return 'created';
  }

  const passwordMatches = await verifyPassword(existing.password_hash, owner.password);
  const identityChanged = existing.display_name !== owner.displayName || existing.role !== 'admin' || existing.enabled !== 1;
  if (passwordMatches && !identityChanged) return 'unchanged';

  const passwordHash = passwordMatches ? existing.password_hash : await hashPassword(owner.password);
  transaction(db, () => {
    run(
      db,
      'UPDATE users SET display_name = ?, password_hash = ?, role = ?, enabled = 1, updated_at = ? WHERE id = ?',
      owner.displayName,
      passwordHash,
      'admin',
      now,
      existing.id,
    );
    if (!passwordMatches || existing.role !== 'admin' || existing.enabled !== 1) {
      revokeUserSessions(db, existing.id);
    }
    audit(
      db,
      null,
      'auth.configured_owner_updated',
      existing.id,
      JSON.stringify({
        passwordChanged: !passwordMatches,
        displayNameChanged: existing.display_name !== owner.displayName,
        roleRestored: existing.role !== 'admin',
        accountReenabled: existing.enabled !== 1,
      }),
    );
  });
  return 'updated';
}
