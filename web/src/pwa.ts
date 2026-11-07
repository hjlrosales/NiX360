type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

const OFFLINE_PREFIX = 'nix360-offline-';
const META_CACHE = 'nix360-sw-meta';
const SETTING_PREFIX = 'nix360-offline-enabled:';

export const OFFLINE_LIMITS = {
  maxItems: 500,
  maxBytes: 100 * 1024 * 1024,
  maxAgeDays: 30,
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let registration: ServiceWorkerRegistration | null = null;
const installListeners = new Set<() => void>();
const updateListeners = new Set<() => void>();

function safeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function offlineCacheName(userId: string): string {
  return `${OFFLINE_PREFIX}${safeUserId(userId)}`;
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function installPromptAvailable(): boolean {
  return deferredPrompt !== null;
}

export function onInstallAvailable(listener: () => void): () => void {
  installListeners.add(listener);
  return () => installListeners.delete(listener);
}

function emitInstall(): void {
  for (const listener of installListeners) listener();
}

export function onUpdateReady(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

function emitUpdate(): void {
  for (const listener of updateListeners) listener();
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferredPrompt;
  if (!event) return 'unavailable';
  deferredPrompt = null;
  emitInstall();
  await event.prompt();
  const choice = await event.userChoice;
  return choice.outcome;
}

export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emitInstall();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    emitInstall();
  });

  try {
    registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
  } catch {
    return;
  }

  if (registration.waiting && navigator.serviceWorker.controller) emitUpdate();
  registration.addEventListener('updatefound', () => {
    const worker = registration?.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // The first installation is not an "update"; only prompt when this page
      // is already controlled by an older worker.
      if (worker.state === 'installed' && navigator.serviceWorker.controller) emitUpdate();
    });
  });

  let lastCheck = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastCheck < 60 * 60 * 1000) return;
    lastCheck = Date.now();
    void registration?.update();
  });
}

export function applyUpdate(): void {
  const waiting = registration?.waiting;
  if (!waiting) {
    window.location.reload();
    return;
  }
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

export function isOfflineEnabled(userId: string): boolean {
  try {
    return localStorage.getItem(`${SETTING_PREFIX}${safeUserId(userId)}`) === '1';
  } catch {
    return false;
  }
}

function setOfflineSetting(userId: string, enabled: boolean): void {
  try {
    const key = `${SETTING_PREFIX}${safeUserId(userId)}`;
    if (enabled) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in private modes; the toggle then fails safely.
  }
}

async function sendOfflineConfig(userId: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const current = await navigator.serviceWorker.getRegistration();
    current?.active?.postMessage({
      type: 'offline-config',
      enabled: true,
      userId,
      ...OFFLINE_LIMITS,
    });
  } catch {
    // No active worker means no offline cache is available yet.
  }
}

async function clearUserCache(userId: string): Promise<void> {
  if (!('caches' in window)) return;
  try {
    await caches.delete(offlineCacheName(userId));
  } catch {
    // An unavailable Cache Storage is already equivalent to no offline data.
  }
}

export async function clearOfflineData(userId: string): Promise<void> {
  setOfflineSetting(userId, false);
  await clearUserCache(userId);
  if ('serviceWorker' in navigator) {
    try {
      const current = await navigator.serviceWorker.getRegistration();
      current?.active?.postMessage({ type: 'clear-offline' });
    } catch {
      // Nothing to clear when no worker is active.
    }
  }
}

export async function clearAllOfflineData(): Promise<void> {
  if ('caches' in window) {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith(OFFLINE_PREFIX)).map((name) => caches.delete(name)));
      await caches.delete(META_CACHE);
    } catch {
      // Cache Storage may be unavailable; local settings are still removed.
    }
  }
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(SETTING_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // See above: nothing durable is left if localStorage is unavailable.
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.controller?.postMessage({ type: 'clear-offline' });
  }
}

export async function setOfflineEnabled(userId: string, enabled: boolean): Promise<void> {
  setOfflineSetting(userId, enabled);
  if (enabled) {
    // Ask the browser not to evict the cache under storage pressure. This is a
    // best-effort hint; eviction can still happen and the UI says so.
    try {
      await navigator.storage?.persist?.();
    } catch {
      // Unsupported or denied persistence does not disable offline storage.
    }
    await sendOfflineConfig(userId);
  } else {
    await clearOfflineData(userId);
  }
}

/**
 * Keeps private caches scoped to the account currently signed in. Called after
 * every session load so a cached library from a previous account cannot be
 * served after a session change.
 */
export async function activateOfflineAccount(userId: string): Promise<void> {
  if (!('caches' in window)) return;
  const allowed = offlineCacheName(userId);
  try {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(OFFLINE_PREFIX) && name !== allowed)
        .map((name) => caches.delete(name)),
    );
  } catch {
    return;
  }
  if (isOfflineEnabled(userId)) await sendOfflineConfig(userId);
  else await clearUserCache(userId);
}

export type OfflineUsage = { items: number; bytes: number };

export async function offlineUsage(userId: string): Promise<OfflineUsage> {
  if (!('caches' in window)) return { items: 0, bytes: 0 };
  try {
    const cache = await caches.open(offlineCacheName(userId));
    const keys = await cache.keys();
    let bytes = 0;
    for (const key of keys) {
      const response = await cache.match(key);
      if (!response) continue;
      const length = Number(response.headers.get('X-Nix-Bytes') || response.headers.get('content-length') || 0);
      if (Number.isFinite(length)) bytes += length;
    }
    return { items: keys.length, bytes };
  } catch {
    return { items: 0, bytes: 0 };
  }
}
