import path from 'node:path';

export type RootConfig = {
  id: string;
  name: string;
  path: string;
};

export type ConfiguredOwner = {
  login: string;
  displayName: string;
  password: string;
};

export type AppConfig = {
  env: string;
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  derivativesDir: string;
  tempDir: string;
  publicDir: string | null;
  roots: RootConfig[];
  /** Optional environment-managed administrator. Never log this object because it contains the plaintext password. */
  configuredOwner: ConfiguredOwner | null;
  cookieName: string;
  cookieSecure: boolean;
  sessionIdleMinutes: number;
  sessionAbsoluteDays: number;
  loginRateLimitMax: number;
  trustProxy: boolean;
  publicOrigin: string | null;
  ffmpegPath: string;
  ffprobePath: string;
  exiftoolPath: string | null;
  logLevel: string;
  stabilityWindowMs: number;
  scanIntervalMinutes: number;
  /** Free-space floor before derivative work is allowed to start. */
  minFreeBytes: number;
};

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const defaultDataDir = path.join(repoRoot, 'data');
const defaultWebDist = path.join(repoRoot, 'web', 'dist');

function envString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean`);
}

function parseConfiguredOwner(env: NodeJS.ProcessEnv): ConfiguredOwner | null {
  const password = env.NIX_OWNER_PASSWORD;
  const loginWasSet = env.NIX_OWNER_LOGIN !== undefined && env.NIX_OWNER_LOGIN.trim() !== '';
  const displayNameWasSet = env.NIX_OWNER_DISPLAY_NAME !== undefined && env.NIX_OWNER_DISPLAY_NAME.trim() !== '';

  if (password === undefined || password === '') {
    if (loginWasSet || displayNameWasSet) {
      throw new Error('NIX_OWNER_PASSWORD is required when NIX_OWNER_LOGIN or NIX_OWNER_DISPLAY_NAME is set');
    }
    return null;
  }

  const login = (env.NIX_OWNER_LOGIN ?? 'owner').trim().toLowerCase();
  const displayName = (env.NIX_OWNER_DISPLAY_NAME ?? login).trim();
  if (!/^[a-z0-9._-]{3,64}$/.test(login)) {
    throw new Error('NIX_OWNER_LOGIN must be 3-64 characters of a-z, 0-9, dot, underscore or dash');
  }
  if (displayName === '' || displayName.length > 100) {
    throw new Error('NIX_OWNER_DISPLAY_NAME must be 1-100 characters');
  }
  if (password.length < 12 || password.length > 512) {
    throw new Error('NIX_OWNER_PASSWORD must be 12-512 characters');
  }
  return { login, displayName, password };
}

/**
 * Media roots are configured administratively only. Clients never submit
 * filesystem paths, so this parser rejects anything that is not an absolute
 * path with a stable, URL-safe identifier.
 */
export function parseRoots(raw: string): RootConfig[] {
  if (raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('NIX_MEDIA_ROOTS must be valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('NIX_MEDIA_ROOTS must be a JSON array');

  const roots: RootConfig[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) throw new Error('Each media root must be an object');
    const { id, name, path: rootPath } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
      throw new Error(`Invalid media root id: ${String(id)}`);
    }
    if (typeof name !== 'string' || name.trim() === '') throw new Error(`Media root ${id} needs a display name`);
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
      throw new Error(`Media root ${id} needs an absolute path`);
    }
    if (seen.has(id)) throw new Error(`Duplicate media root id: ${id}`);
    seen.add(id);
    roots.push({ id, name: name.trim(), path: path.normalize(rootPath) });
  }
  return roots;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = env.NODE_ENV ?? 'development';
  const dataDir = path.resolve(envString(env, 'NIX_DATA_DIR', defaultDataDir));
  const publicDirEnv = env.NIX_PUBLIC_DIR;
  const publicDir = publicDirEnv === undefined ? defaultWebDist : publicDirEnv.trim() === '' ? null : path.resolve(publicDirEnv);
  const publicOrigin = env.NIX_PUBLIC_ORIGIN === undefined || env.NIX_PUBLIC_ORIGIN.trim() === '' ? null : env.NIX_PUBLIC_ORIGIN.trim();

  if (publicOrigin !== null && !/^https?:\/\/[^/]+$/.test(publicOrigin)) {
    throw new Error('NIX_PUBLIC_ORIGIN must be an origin such as https://nix.example.com (no path)');
  }

  return {
    env: mode,
    host: envString(env, 'NIX_HOST', '127.0.0.1'),
    port: envInt(env, 'NIX_PORT', 8787, 1, 65535),
    dataDir,
    dbPath: path.join(dataDir, 'library.sqlite'),
    derivativesDir: path.resolve(envString(env, 'NIX_DERIVATIVES_DIR', path.join(dataDir, 'derivatives'))),
    tempDir: path.resolve(envString(env, 'NIX_TEMP_DIR', path.join(dataDir, 'temp'))),
    publicDir,
    roots: parseRoots(env.NIX_MEDIA_ROOTS ?? ''),
    configuredOwner: parseConfiguredOwner(env),
    cookieName: envString(env, 'NIX_COOKIE_NAME', 'nix_session'),
    cookieSecure: envBool(env, 'NIX_COOKIE_SECURE', mode === 'production'),
    sessionIdleMinutes: envInt(env, 'NIX_SESSION_IDLE_MINUTES', 240, 5, 60 * 24 * 30),
    sessionAbsoluteDays: envInt(env, 'NIX_SESSION_ABSOLUTE_DAYS', 30, 1, 365),
    loginRateLimitMax: envInt(env, 'NIX_LOGIN_RATE_LIMIT_MAX', 10, 1, 1000),
    trustProxy: envBool(env, 'NIX_TRUST_PROXY', false),
    publicOrigin,
    ffmpegPath: envString(env, 'NIX_FFMPEG_PATH', 'ffmpeg'),
    ffprobePath: envString(env, 'NIX_FFPROBE_PATH', 'ffprobe'),
    exiftoolPath: envString(env, 'NIX_EXIFTOOL_PATH', '') || null,
    logLevel: envString(env, 'NIX_LOG_LEVEL', mode === 'test' ? 'silent' : 'info'),
    stabilityWindowMs: envInt(env, 'NIX_STABILITY_WINDOW_SECONDS', 60, 0, 3600) * 1000,
    scanIntervalMinutes: envInt(env, 'NIX_SCAN_INTERVAL_MINUTES', 0, 0, 10080),
    minFreeBytes: envInt(env, 'NIX_MIN_FREE_MB', 512, 0, 1_000_000) * 1024 * 1024,
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoAfter(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}
