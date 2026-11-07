import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.ts';
import { nowIso } from '../config.ts';
import { getRow, run } from '../db/sqlite.ts';

export type SessionUser = {
  id: string;
  login: string;
  displayName: string;
  role: 'admin' | 'viewer';
  enabled: boolean;
};

type SessionRow = {
  id: string;
  user_id: string;
  issued_at: string;
  expires_at: string;
  idle_expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueSession(
  db: DatabaseSync,
  config: AppConfig,
  userId: string,
  userAgent: string | null,
): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + config.sessionAbsoluteDays * 86_400_000).toISOString();
  const idleExpiresAt = new Date(now + config.sessionIdleMinutes * 60_000).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, user_id, issued_at, expires_at, idle_expires_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(hashToken(token), userId, issuedAt, expiresAt, idleExpiresAt, issuedAt, userAgent);

  return { token, expiresAt };
}

/**
 * Resolves a cookie token to an enabled user. Expired or revoked sessions are
 * rejected and cleaned up; the idle window slides forward at most once a minute.
 */
export function resolveSession(db: DatabaseSync, config: AppConfig, token: unknown): SessionUser | null {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  const sessionId = hashToken(token);

  const row = getRow<
    SessionRow & { login: string; display_name: string; role: 'admin' | 'viewer'; enabled: number }
  >(
    db,
    `SELECT s.*, u.login, u.display_name, u.role, u.enabled
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
    sessionId,
  );
  if (!row) return null;

  const now = Date.now();
  const expired = row.revoked_at !== null || Date.parse(row.expires_at) <= now || Date.parse(row.idle_expires_at) <= now;
  if (expired) {
    run(db, 'UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', nowIso(), sessionId);
    return null;
  }
  if (row.enabled !== 1) return null;

  if (now - Date.parse(row.last_seen_at) > 60_000) {
    const idleExpiresAt = new Date(now + config.sessionIdleMinutes * 60_000).toISOString();
    run(
      db,
      'UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?',
      new Date(now).toISOString(),
      idleExpiresAt,
      sessionId,
    );
  }

  return {
    id: row.user_id,
    login: row.login,
    displayName: row.display_name,
    role: row.role,
    enabled: true,
  };
}

export function revokeSession(db: DatabaseSync, token: string): void {
  if (!TOKEN_PATTERN.test(token)) return;
  run(db, 'UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', nowIso(), hashToken(token));
}

export function revokeUserSessions(db: DatabaseSync, userId: string, exceptSessionToken?: string): void {
  const now = nowIso();
  if (exceptSessionToken && TOKEN_PATTERN.test(exceptSessionToken)) {
    run(
      db,
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?',
      now,
      userId,
      hashToken(exceptSessionToken),
    );
    return;
  }
  run(db, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now, userId);
}
