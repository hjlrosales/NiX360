import { useEffect, useState } from 'preact/hooks';
import { api, formatBytes, type User } from './api.ts';
import {
  OFFLINE_LIMITS,
  applyUpdate,
  clearOfflineData,
  installPromptAvailable,
  isIos,
  isOfflineEnabled,
  isStandalone,
  offlineUsage,
  onInstallAvailable,
  onUpdateReady,
  promptInstall,
  setOfflineEnabled,
  type OfflineUsage,
} from './pwa.ts';

type Props = {
  user: User;
  onLogout: () => void;
  onNavigate: (path: string) => void;
};

export function SettingsPage({ user, onLogout, onNavigate }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installable, setInstallable] = useState(installPromptAvailable);
  const [standalone] = useState(isStandalone);
  const [updateReady, setUpdateReady] = useState(false);
  const [offlineEnabled, setOffline] = useState(() => isOfflineEnabled(user.id));
  const [usage, setUsage] = useState<OfflineUsage>({ items: 0, bytes: 0 });
  const [offlineBusy, setOfflineBusy] = useState(false);
  const [offlineNote, setOfflineNote] = useState<string | null>(null);
  const cacheSupported = 'caches' in window && window.isSecureContext;

  useEffect(() => onInstallAvailable(() => setInstallable(installPromptAvailable())), []);

  useEffect(() => onUpdateReady(() => setUpdateReady(true)), []);

  useEffect(() => {
    let cancelled = false;
    void offlineUsage(user.id).then((value) => {
      if (!cancelled) setUsage(value);
    });
    return () => {
      cancelled = true;
    };
  }, [user.id, offlineEnabled]);

  async function changePassword(event: Event) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setMessage('Password updated. Other sessions were signed out.');
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : 'request_failed';
      setError(code === 'weak_password' ? 'Use at least 12 characters.' : 'The password could not be changed.');
    }
  }

  async function revokeSessions() {
    await api.revokeSessions();
    setMessage('Other sessions were revoked.');
  }

  async function toggleOffline(): Promise<void> {
    setOfflineBusy(true);
    setOfflineNote(null);
    const next = !offlineEnabled;
    try {
      await setOfflineEnabled(user.id, next);
      setOffline(next);
      setOfflineNote(next ? 'Offline thumbnails enabled for this account.' : 'Offline thumbnails removed.');
    } catch {
      setOfflineNote('Offline storage could not be changed.');
    } finally {
      setOfflineBusy(false);
    }
  }

  async function removeOffline(): Promise<void> {
    setOfflineBusy(true);
    try {
      await clearOfflineData(user.id);
      setOffline(false);
      setOfflineNote('Offline thumbnails removed.');
    } finally {
      setOfflineBusy(false);
    }
  }

  async function install(): Promise<void> {
    const outcome = await promptInstall();
    if (outcome === 'accepted') setMessage('NiX Media was installed.');
    else if (outcome === 'dismissed') setMessage('Installation was dismissed.');
    else setMessage('Use your browser’s Install or Add to Home Screen command.');
  }

  return (
    <section class="page">
      <header class="page-header">
        <div>
          <h2>Settings</h2>
          <p class="muted">Signed in as {user.displayName} ({user.login}), role {user.role}.</p>
        </div>
      </header>

      {message ? <div class="notice success">{message}</div> : null}

      <section class="panel">
        <h3>Install as an app</h3>
        {standalone ? (
          <p class="muted">NiX Media is running as an installed app.</p>
        ) : installable ? (
          <>
            <p class="muted">Install NiX Media for a standalone window and app icon. Offline behaviour is optional and separate.</p>
            <button class="button primary" type="button" onClick={() => void install()}>
              Install NiX Media
            </button>
          </>
        ) : (
          <p class="muted">
            {isIos()
              ? 'On iPhone or iPad, open this site in Safari, tap Share, then choose Add to Home Screen.'
              : 'Use your browser’s Install App or Add to Home Screen command. Installation requires HTTPS (or localhost).'}
          </p>
        )}
        {updateReady ? (
          <div class="notice success">
            <p>A new version is ready.</p>
            <button class="button small" type="button" onClick={applyUpdate}>
              Reload to update
            </button>
          </div>
        ) : null}
      </section>

      <section class="panel">
        <h3>Offline thumbnails</h3>
        <p class="muted">
          Off by default. When enabled, thumbnails you have already viewed are kept in a cache owned by this account, so
          they can appear after a brief connection loss or an offline app launch. Videos, originals, previews and
          library responses are never cached.
        </p>
        <p class="muted small">
          Bounded to {OFFLINE_LIMITS.maxItems} thumbnails, {formatBytes(OFFLINE_LIMITS.maxBytes)} and{' '}
          {OFFLINE_LIMITS.maxAgeDays} days, then pruned oldest first. Caches are deleted on sign-out and when a different
          account signs in. Anyone using this device profile while you stay signed in may be able to see the cached
          thumbnails, so leave this off on shared devices.
        </p>
        {cacheSupported ? (
          <>
            <label class="inline-toggle">
              <input
                type="checkbox"
                checked={offlineEnabled}
                disabled={offlineBusy}
                onChange={() => void toggleOffline()}
              />
              <span>Keep thumbnails on this device for this account</span>
            </label>
            <p class="muted small">
              Currently stored: {usage.items} thumbnail{usage.items === 1 ? '' : 's'} · {formatBytes(usage.bytes)}
            </p>
            <div class="button-row">
              <button class="button" type="button" onClick={() => void removeOffline()} disabled={offlineBusy || usage.items === 0}>
                Clear offline thumbnails
              </button>
            </div>
          </>
        ) : (
          <p class="muted">Offline storage needs HTTPS (or localhost) and a browser with Cache Storage support.</p>
        )}
        {offlineNote ? <p class="muted small">{offlineNote}</p> : null}
      </section>

      <section class="panel">
        <h3>Password</h3>
        <form class="stack" onSubmit={changePassword}>
          <label class="field">
            <span>Current password</span>
            <input
              type="password"
              autocomplete="current-password"
              value={currentPassword}
              required
              onInput={(event) => setCurrentPassword((event.target as HTMLInputElement).value)}
            />
          </label>
          <label class="field">
            <span>New password (minimum 12 characters)</span>
            <input
              type="password"
              autocomplete="new-password"
              minLength={12}
              value={newPassword}
              required
              onInput={(event) => setNewPassword((event.target as HTMLInputElement).value)}
            />
          </label>
          {error ? (
            <p class="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button class="button primary" type="submit">
            Update password
          </button>
        </form>
      </section>

      <section class="panel">
        <h3>Sessions</h3>
        <p class="muted">Sessions are stored server-side and can be revoked at any time. Signing out also clears offline thumbnails for this account.</p>
        <div class="button-row">
          <button class="button" type="button" onClick={() => void revokeSessions()}>
            Sign out other sessions
          </button>
          <button class="button ghost" type="button" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </section>

      {user.role === 'admin' ? (
        <section class="panel">
          <h3>Administration</h3>
          <p class="muted">Manage library scans, processing jobs and account state.</p>
          <button class="button" type="button" onClick={() => onNavigate('/admin')}>
            Open administration
          </button>
        </section>
      ) : null}
    </section>
  );
}
