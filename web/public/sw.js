/*
 * NiX 360 Media service worker.
 *
 * Privacy boundary:
 * - the app shell is public and shared by every account;
 * - private media is never cached unless the signed-in user explicitly enables
 *   offline thumbnails, and then only thumbnail responses, in a cache named for
 *   that account;
 * - all other /api responses stay network-only and are never stored;
 * - the page deletes offline caches on sign-out/account switch.
 *
 * Bump CACHE_VERSION whenever the shell/caching behaviour changes so installed
 * clients pick up the new worker and drop the previous shell cache.
 */
const CACHE_VERSION = 'nix360-shell-2026-11-06-1';
const SHELL_CACHE = CACHE_VERSION;
const META_CACHE = 'nix360-sw-meta';
const CONFIG_KEY = '/__nix360/offline-config';
const OFFLINE_PREFIX = 'nix360-offline-';
const THUMBNAIL_PATH = /^\/api\/media\/[^/]+\/thumbnail$/;
const OFFLINE_DEFAULTS = {
  enabled: false,
  userId: null,
  maxItems: 500,
  maxBytes: 100 * 1024 * 1024,
  maxAgeDays: 30,
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const required = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
      await cache.addAll(required.map((url) => new Request(url, { cache: 'reload' })));
      // The hashed bundle names are only known from index.html. Discover them
      // during install so the first offline launch can render the app.
      try {
        const index = await cache.match('/index.html');
        const html = index ? await index.text() : '';
        const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
        await Promise.all(assets.map((asset) => cache.add(asset).catch(() => undefined)));
      } catch {
        // A later online visit can fill the runtime asset cache.
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('nix360-shell-') && name !== SHELL_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function safeUserId(userId) {
  return String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function offlineCacheName(userId) {
  return `${OFFLINE_PREFIX}${safeUserId(userId)}`;
}

async function readConfig() {
  try {
    const cache = await caches.open(META_CACHE);
    const response = await cache.match(CONFIG_KEY);
    return response ? { ...OFFLINE_DEFAULTS, ...(await response.json()) } : { ...OFFLINE_DEFAULTS };
  } catch {
    return { ...OFFLINE_DEFAULTS };
  }
}

async function writeConfig(config) {
  const cache = await caches.open(META_CACHE);
  await cache.put(
    CONFIG_KEY,
    new Response(JSON.stringify(config), { headers: { 'content-type': 'application/json' } }),
  );
}

async function clearOfflineCaches() {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith(OFFLINE_PREFIX)).map((name) => caches.delete(name)));
  await caches.delete(META_CACHE);
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
    return;
  }
  if (data.type === 'offline-config') {
    event.waitUntil(
      writeConfig({
        enabled: data.enabled === true,
        userId: data.userId ?? null,
        maxItems: Number(data.maxItems) || OFFLINE_DEFAULTS.maxItems,
        maxBytes: Number(data.maxBytes) || OFFLINE_DEFAULTS.maxBytes,
        maxAgeDays: Number(data.maxAgeDays) || OFFLINE_DEFAULTS.maxAgeDays,
      }),
    );
    return;
  }
  if (data.type === 'clear-offline') {
    event.waitUntil(clearOfflineCaches());
  }
});

async function trimCache(cache, config) {
  const keys = await cache.keys();
  const entries = [];
  let total = 0;
  const cutoff = Date.now() - config.maxAgeDays * 24 * 60 * 60 * 1000;

  for (const key of keys) {
    const response = await cache.match(key);
    if (!response) continue;
    const cachedAt = Date.parse(response.headers.get('X-Nix-Cached-At') || '') || 0;
    const bytes = Number(response.headers.get('X-Nix-Bytes') || response.headers.get('content-length') || 0) || 0;
    if (!cachedAt || cachedAt < cutoff) {
      await cache.delete(key);
      continue;
    }
    entries.push({ key, cachedAt, bytes });
    total += bytes;
  }

  entries.sort((left, right) => left.cachedAt - right.cachedAt);
  while (entries.length > config.maxItems || total > config.maxBytes) {
    const oldest = entries.shift();
    if (!oldest) break;
    await cache.delete(oldest.key);
    total -= oldest.bytes;
  }
}

async function cacheThumbnail(request, response, config) {
  if (!config.enabled || !config.userId) return;
  if (!response.ok || response.status !== 200) return;
  const body = await response.blob();
  // A thumbnail should be small; refuse an unexpectedly large object rather
  // than silently consuming the user's quota.
  if (body.size > 8 * 1024 * 1024) return;
  const headers = new Headers(response.headers);
  headers.set('X-Nix-Cached-At', new Date().toISOString());
  headers.set('X-Nix-Bytes', String(body.size));
  const cache = await caches.open(offlineCacheName(config.userId));
  await cache.put(request, new Response(body, { status: 200, statusText: 'OK', headers }));
  await trimCache(cache, config);
}

async function thumbnailRequest(request) {
  const config = await readConfig();
  const cache = config.enabled && config.userId ? await caches.open(offlineCacheName(config.userId)) : null;
  const cached = cache ? await cache.match(request) : null;
  try {
    const response = await fetch(request);
    if (cache && response.ok) {
      try {
        await cacheThumbnail(request, response.clone(), config);
      } catch {
        // Caching is best-effort; playback of the live response must not fail.
      }
    }
    return response;
  } catch {
    if (cached) return cached;
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

function isShellAsset(pathname) {
  return (
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/') ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/favicon.png'
  );
}

async function shellAsset(request) {
  const cached = await caches.match(request, { cacheName: SHELL_CACHE });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function navigationRequest(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put('/index.html', response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match('/index.html', { cacheName: SHELL_CACHE });
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Offline</title><body style="font-family:system-ui;padding:2rem;color:#1b2430"><h1>NiX 360 Media is offline</h1><p>Reconnect to sign in. Thumbnails you chose to keep offline will be available once the app shell is cached.</p>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    // Only an opt-in thumbnail may ever be stored. Everything else, including
    // originals, previews, tiles, renditions and JSON, stays network-only.
    if (THUMBNAIL_PATH.test(url.pathname)) event.respondWith(thumbnailRequest(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationRequest(request));
    return;
  }
  if (isShellAsset(url.pathname)) event.respondWith(shellAsset(request));
});
