import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../src/config.ts';
import { migrate, openDatabase, run } from '../src/db/sqlite.ts';
import { hashPassword } from '../src/auth/password.ts';
import { nowIso } from '../src/config.ts';
import { buildApp } from '../src/app.ts';
import { syncConfiguredRoots } from '../src/media/scan.ts';

export type TestContext = {
  config: AppConfig;
  db: DatabaseSync;
  app: FastifyInstance;
  workspace: string;
  mediaRoot: string;
  cleanup: () => Promise<void>;
};

export function testConfig(workspace: string, overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = path.join(workspace, 'data');
  const mediaRoot = path.join(workspace, 'media');
  fs.mkdirSync(mediaRoot, { recursive: true });
  return {
    env: 'test',
    host: '127.0.0.1',
    port: 0,
    dataDir,
    dbPath: path.join(dataDir, 'library.sqlite'),
    derivativesDir: path.join(dataDir, 'derivatives'),
    tempDir: path.join(dataDir, 'temp'),
    publicDir: null,
    roots: [{ id: 'test', name: 'Test library', path: mediaRoot }],
    configuredOwner: null,
    cookieName: 'nix_session',
    cookieSecure: false,
    sessionIdleMinutes: 120,
    sessionAbsoluteDays: 30,
    loginRateLimitMax: 1000,
    trustProxy: false,
    publicOrigin: 'https://nix.test',
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    exiftoolPath: null,
    logLevel: 'silent',
    stabilityWindowMs: 0,
    scanIntervalMinutes: 0,
    minFreeBytes: 0,
    ...overrides,
  };
}

export async function createTestContext(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nix360-test-'));
  const config = testConfig(workspace, overrides);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(config.dbPath);
  migrate(db);
  syncConfiguredRoots(db, config.roots);
  const app = await buildApp({ db, config, logger: false });
  await app.ready();

  return {
    config,
    db,
    app,
    workspace,
    mediaRoot: config.roots[0]!.path,
    cleanup: async () => {
      await app.close();
      db.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}

export async function createUser(
  db: DatabaseSync,
  login: string,
  password: string,
  role: 'admin' | 'viewer' = 'viewer',
): Promise<string> {
  const id = randomUUID();
  const now = nowIso();
  run(
    db,
    'INSERT INTO users (id, login, display_name, password_hash, role, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    id,
    login,
    login,
    await hashPassword(password),
    role,
    now,
    now,
  );
  return id;
}

export const TEST_PASSWORD = 'correct horse battery staple';

export async function login(app: FastifyInstance, login: string, password = TEST_PASSWORD): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password } });
  if (response.statusCode !== 200) throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  const cookie = response.headers['set-cookie'];
  const header = Array.isArray(cookie) ? cookie[0] : cookie;
  const match = /nix_session=([^;]+)/.exec(header ?? '');
  if (!match) throw new Error('no session cookie issued');
  return match[1]!;
}

export function authHeaders(token: string): { cookies: { nix_session: string } } {
  return { cookies: { nix_session: token } };
}
