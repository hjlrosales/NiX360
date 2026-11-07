import type { DatabaseSync } from 'node:sqlite';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password.ts';
import { hashToken, issueSession, resolveSession, revokeSession, revokeUserSessions, type SessionUser } from '../auth/session.ts';
import { getRow, run } from '../db/sqlite.ts';
import { nowIso } from '../config.ts';

type UserRow = {
  id: string;
  login: string;
  display_name: string;
  password_hash: string;
  role: 'admin' | 'viewer';
  enabled: number;
};

export type AuthDeps = { db: DatabaseSync; config: AppConfig };

export function toPublicUser(user: SessionUser): Record<string, unknown> {
  return { id: user.id, login: user.login, displayName: user.displayName, role: user.role };
}

export function requireUser(request: FastifyRequest, reply: FastifyReply): SessionUser | null {
  if (!request.authUser) {
    reply.code(401).send({ error: 'unauthenticated' });
    return null;
  }
  return request.authUser;
}

export function requireAdmin(request: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const user = requireUser(request, reply);
  if (!user) return null;
  if (user.role !== 'admin') {
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return user;
}

export function audit(db: DatabaseSync, actorId: string | null, action: string, targetId: string | null, detail?: string): void {
  run(
    db,
    'INSERT INTO audit_events (actor_id, action, target_id, created_at, detail) VALUES (?, ?, ?, ?, ?)',
    actorId,
    action,
    targetId,
    nowIso(),
    detail ?? null,
  );
}

let dummyHashPromise: Promise<string> | null = null;
async function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('this-password-never-matches');
  return dummyHashPromise;
}

export function registerAuthRoutes(app: import('fastify').FastifyInstance, { db, config }: AuthDeps): void {
  const cookieOptions = {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict' as const,
    path: '/',
  };

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: config.loginRateLimitMax, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as { login?: unknown; password?: unknown };
      if (typeof body.login !== 'string' || typeof body.password !== 'string') {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const login = body.login.trim().toLowerCase();
      const password = body.password;
      if (login.length === 0 || login.length > 128 || password.length > 512) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const user = getRow<UserRow>(db, 'SELECT * FROM users WHERE login = ?', login);
      const encoded = user?.password_hash ?? (await dummyHash());
      const valid = await verifyPassword(encoded, password);

      if (!user || !valid || user.enabled !== 1) {
        audit(db, user?.id ?? null, 'auth.login_failed', null, login.slice(0, 64));
        return reply.code(401).send({ error: 'invalid_credentials' });
      }

      const { token } = issueSession(db, config, user.id, request.headers['user-agent']?.slice(0, 512) ?? null);
      reply.setCookie(config.cookieName, token, {
        ...cookieOptions,
        maxAge: config.sessionAbsoluteDays * 86_400,
      });
      audit(db, user.id, 'auth.login', user.id);
      return reply.send({
        user: toPublicUser({ id: user.id, login: user.login, displayName: user.display_name, role: user.role, enabled: true }),
      });
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[config.cookieName];
    if (typeof token === 'string') revokeSession(db, token);
    if (request.authUser) audit(db, request.authUser.id, 'auth.logout', request.authUser.id);
    reply.clearCookie(config.cookieName, cookieOptions);
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    return reply.send({ user: toPublicUser(user) });
  });

  app.delete('/api/auth/sessions', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const token = request.cookies[config.cookieName];
    revokeUserSessions(db, user.id, typeof token === 'string' ? token : undefined);
    audit(db, user.id, 'auth.sessions_revoked', user.id);
    return reply.send({ ok: true });
  });

  app.patch('/api/auth/password', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const body = (request.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const problem = passwordProblem(body.newPassword);
    if (problem) return reply.code(400).send({ error: 'weak_password', message: problem });

    const row = getRow<UserRow>(db, 'SELECT * FROM users WHERE id = ?', user.id);
    if (!row || !(await verifyPassword(row.password_hash, body.currentPassword))) {
      return reply.code(403).send({ error: 'invalid_credentials' });
    }

    const newHash = await hashPassword(body.newPassword);
    run(db, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', newHash, nowIso(), user.id);
    const currentToken = request.cookies[config.cookieName];
    revokeUserSessions(db, user.id, typeof currentToken === 'string' ? currentToken : undefined);
    audit(db, user.id, 'auth.password_changed', user.id);
    return reply.send({ ok: true });
  });

  app.get('/api/auth/csrf-context', async (request, reply) => {
    const token = request.cookies[config.cookieName];
    const tokenHash = typeof token === 'string' ? hashToken(token).slice(0, 16) : null;
    return reply.send({ sessionFingerprint: tokenHash, origin: config.publicOrigin });
  });

  // Exposed for the SPA: resolves a stale session without a redirect.
  app.get('/api/session', async (request, reply) => {
    const token = request.cookies[config.cookieName];
    const user = resolveSession(db, config, token);
    return reply.send({ user: user ? toPublicUser(user) : null });
  });
}
