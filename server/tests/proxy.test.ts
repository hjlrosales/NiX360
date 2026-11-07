import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createTestContext, createUser, TEST_PASSWORD, type TestContext } from './helpers.ts';

const PASSWORD = TEST_PASSWORD;
const contexts: TestContext[] = [];

after(async () => {
  for (const ctx of contexts) await ctx.cleanup();
});

async function context(overrides: Parameters<typeof createTestContext>[0]): Promise<TestContext> {
  const ctx = await createTestContext(overrides);
  contexts.push(ctx);
  await createUser(ctx.db, 'owner', PASSWORD, 'admin');
  return ctx;
}

type TlsResponse = { status: number; headers: http.IncomingHttpHeaders; body: string };

function tlsRequest(options: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<TlsResponse> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

describe('reverse proxy and HTTPS', () => {
  it('does not trust forwarded protocol headers when proxy trust is disabled', async () => {
    const ctx = await context({ trustProxy: false, publicOrigin: null });

    // The origin matches what the derived scheme would be if X-Forwarded-Proto
    // were believed; with trust off the app still sees HTTP and must reject it.
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/history',
      payload: { mediaId: 'missing' },
      headers: { host: 'nix.test', origin: 'https://nix.test', 'x-forwarded-proto': 'https' },
    });

    assert.equal(response.statusCode, 403);
    assert.equal((response.json() as { error: string }).error, 'csrf_origin_rejected');
  });

  it('uses the trusted forwarded scheme and marks cookies Secure behind HTTPS', async () => {
    const ctx = await context({ trustProxy: true, publicOrigin: null, cookieSecure: true });

    const accepted = await ctx.app.inject({
      method: 'POST',
      url: '/api/history',
      payload: { mediaId: 'missing' },
      headers: { host: 'nix.test', origin: 'https://nix.test', 'x-forwarded-proto': 'https' },
    });
    // CSRF passed; the request is rejected later for lacking a session.
    assert.equal(accepted.statusCode, 401);

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'owner', password: PASSWORD },
      headers: { host: 'nix.test', 'x-forwarded-proto': 'https' },
    });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']);
    assert.match(cookie, /;\s*Secure/i);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);

    // The same origin without the forwarded scheme is a cross-origin request.
    const untrusted = await ctx.app.inject({
      method: 'POST',
      url: '/api/history',
      payload: { mediaId: 'missing' },
      headers: { host: 'nix.test', origin: 'https://nix.test' },
    });
    assert.equal(untrusted.statusCode, 403);
  });

  it('serves the app through a local TLS terminator with a secure session cookie', async (t) => {
    const ctx = await context({ trustProxy: true, publicOrigin: null, cookieSecure: true });

    let key: Buffer;
    let cert: Buffer;
    try {
      const keyPath = path.join(ctx.workspace, 'tls-key.pem');
      const certPath = path.join(ctx.workspace, 'tls-cert.pem');
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1',
          '-keyout',
          keyPath,
          '-out',
          certPath,
        ],
        { stdio: 'ignore' },
      );
      key = fs.readFileSync(keyPath);
      cert = fs.readFileSync(certPath);
    } catch {
      t.skip('openssl is unavailable, so no local certificate can be generated');
      return;
    }

    const appAddress = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const appPort = Number(new URL(appAddress).port);

    // Minimal TLS terminator: the browser talks HTTPS here, and the proxy
    // forwards plain HTTP to the app with the forwarded headers a real proxy
    // sets. This is the deployment topology the runbook documents.
    const proxy = https.createServer({ key, cert }, (request, response) => {
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: appPort,
          path: request.url,
          method: request.method,
          headers: {
            ...request.headers,
            'x-forwarded-proto': 'https',
            'x-forwarded-for': request.socket.remoteAddress ?? '127.0.0.1',
          },
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on('error', () => {
        response.writeHead(502).end();
      });
      request.pipe(upstream);
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolve);
    });
    const proxyPort = (proxy.address() as AddressInfo).port;

    try {
      const health = await tlsRequest({ port: proxyPort, path: '/api/health' });
      assert.equal(health.status, 200);
      assert.equal((JSON.parse(health.body) as { status: string }).status, 'ok');
      assert.match(String(health.headers['strict-transport-security']), /max-age=/i);

      const login = await tlsRequest({
        port: proxyPort,
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: 'owner', password: PASSWORD }),
      });
      assert.equal(login.status, 200);

      const setCookie = login.headers['set-cookie'];
      const cookie = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
      assert.match(cookie, /;\s*Secure/i);
      const token = /nix_session=([^;]+)/.exec(cookie)?.[1];
      assert.ok(token, 'login issued a session cookie');

      const me = await tlsRequest({
        port: proxyPort,
        path: '/api/auth/me',
        headers: { cookie: `nix_session=${token}` },
      });
      assert.equal(me.status, 200);
      assert.equal((JSON.parse(me.body) as { user: { login: string } }).user.login, 'owner');
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
