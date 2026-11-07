import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from './config.ts';
import { resolveSession, type SessionUser } from './auth/session.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { registerLibraryRoutes } from './library/routes.ts';
import { registerMediaRoutes } from './media/routes.ts';
import { registerAdminRoutes } from './admin/routes.ts';

declare module 'fastify' {
  interface FastifyRequest {
    authUser: SessionUser | null;
  }
}

export type AppDeps = {
  db: DatabaseSync;
  config: AppConfig;
  logger?: boolean;
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp({ db, config, logger = true }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      logger && config.logLevel !== 'silent'
        ? { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers.authorization'] }
        : false,
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        mediaSrc: ["'self'", 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
  });

  app.decorateRequest('authUser', null);

  app.addHook('onRequest', async (request) => {
    request.authUser = resolveSession(db, config, request.cookies[config.cookieName]);
  });

  /**
   * CSRF defence for state-changing requests: same-origin deployments reject
   * cross-site origins. Session cookies are SameSite=Strict as a second layer.
   */
  app.addHook('preHandler', async (request, reply) => {
    if (SAFE_METHODS.has(request.method.toUpperCase())) return;
    const origin = request.headers.origin;
    const expectedOrigin = config.publicOrigin ?? `${request.protocol}://${request.headers.host ?? ''}`;
    if (typeof origin === 'string' && origin !== expectedOrigin) {
      return reply.code(403).send({ error: 'csrf_origin_rejected' });
    }
    if (typeof origin !== 'string' && request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: 'csrf_origin_rejected' });
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) reply.header('X-Robots-Tag', 'noindex, nofollow');
    return payload;
  });

  app.get('/api/health', { config: { rateLimit: false } }, async (_request, reply) => {
    let database = 'ok';
    try {
      db.prepare('SELECT 1 AS ok').get();
    } catch {
      database = 'error';
    }
    return reply.code(database === 'ok' ? 200 : 503).send({ status: database === 'ok' ? 'ok' : 'degraded', database });
  });

  registerAuthRoutes(app, { db, config });
  registerLibraryRoutes(app, { db, config });
  registerMediaRoutes(app, { db, config });
  registerAdminRoutes(app, { db, config });

  const indexFile = config.publicDir ? path.join(config.publicDir, 'index.html') : null;
  if (config.publicDir && indexFile && fs.existsSync(indexFile)) {
    await app.register(fastifyStatic, {
      root: config.publicDir,
      prefix: '/',
      index: ['index.html'],
      setHeaders: (reply, filePath) => {
        if (filePath.endsWith(`${path.sep}sw.js`)) {
          // A cached worker delays updates; always revalidate it with the server.
          reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
          reply.header('Service-Worker-Allowed', '/');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          reply.header('Cache-Control', 'no-cache');
        }
      },
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return reply.code(405).send({ error: 'method_not_allowed' });
      }
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      return reply
        .code(503)
        .type('text/plain')
        .send('NiX 360 Media API is running, but the web bundle is not built. Run "npm run build".');
    });
  }

  return app;
}
