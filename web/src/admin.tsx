import { useEffect, useState } from 'preact/hooks';
import { api, formatBytes, type AdminUser, type User } from './api.ts';

type Status = {
  media: { media_type: string; processing_state: string; count: number }[];
  jobs: Record<string, number>;
  roots: { id: string; name: string; health: string; lastSuccessAt: string | null }[];
  unsupportedCount: number;
  duplicateGroups: number;
  duplicateReclaimableBytes: number;
  queuePaused: boolean;
  dataFreeBytes: number | null;
  exiftoolConfigured: boolean;
};

type Duplicates = {
  groups: { hash: string; count: number; bytes: number; items: { id: string; relativePath: string; sizeBytes: number }[] }[];
  reclaimableBytes: number;
  truncated: boolean;
};

type Unsupported = { items: { id: string; fileName: string; type: string; state: string; reason: string | null }[] };

type Companions = {
  relations: {
    canonicalId: string;
    companionId: string;
    canonicalPath: string;
    companionPath: string;
    policyVersion: number;
    updatedAt: string | null;
  }[];
  checks: {
    canonicalId: string;
    companionId: string;
    canonicalPath: string;
    companionPath: string;
    status: string;
    reason: string;
    checkedAt: string;
  }[];
  summary: { confirmed: number; pending: number; ambiguous: number; rejected: number };
};

type ExportRow = {
  sourceId: string;
  mediaId: string;
  fileName: string;
  relativePath: string;
  width: number | null;
  height: number | null;
  linkedAt: string | null;
};

type ExportOptionRow = { id: string; fileName: string; relativePath: string };

type Exports = { relations: ExportRow[]; originals: ExportOptionRow[]; candidates: ExportOptionRow[] };

type Job = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  progress: number;
  lastError: string | null;
  nextRunAt: string;
  mediaId: string | null;
};

export function AdminPage({ currentUser }: { currentUser: User }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [duplicates, setDuplicates] = useState<Duplicates | null>(null);
  const [unsupported, setUnsupported] = useState<Unsupported | null>(null);
  const [companions, setCompanions] = useState<Companions | null>(null);
  const [exportData, setExportData] = useState<Exports | null>(null);
  const [exportSource, setExportSource] = useState('');
  const [exportTarget, setExportTarget] = useState('');
  const [newLogin, setNewLogin] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<User['role']>('viewer');
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  const [userBusy, setUserBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [statusResult, usersResult, jobsResult, duplicatesResult, unsupportedResult, companionsResult, exportsResult] =
        await Promise.all([
          api.adminStatus(),
          api.adminUsers(),
          api.adminJobs(),
          api.adminDuplicates(),
          api.adminUnsupported(),
          api.adminCompanions(),
          api.adminExports(),
        ]);
      setStatus(statusResult);
      setUsers(usersResult.users);
      setJobs(jobsResult.jobs);
      setDuplicates(duplicatesResult);
      setUnsupported(unsupportedResult);
      setCompanions(companionsResult);
      setExportData(exportsResult);
      setError(null);
    } catch {
      setError('Administration data could not be loaded.');
    }
  }

  function userError(cause: unknown): string {
    const code = cause instanceof Error ? cause.message : 'request_failed';
    if (code === 'invalid_login') return 'Username must be 3–64 lowercase letters, numbers, dots, dashes or underscores.';
    if (code === 'invalid_display_name') return 'Enter a display name of no more than 100 characters.';
    if (code === 'weak_password') return 'Passwords must contain at least 12 characters.';
    if (code === 'login_taken') return 'That username is already in use.';
    if (code === 'cannot_disable_self') return 'You cannot disable your own account.';
    if (code === 'cannot_demote_self') return 'You cannot remove your own administrator role.';
    return 'The user account could not be updated.';
  }

  async function createUser(event: Event) {
    event.preventDefault();
    setUserBusy('create');
    setMessage(null);
    setError(null);
    try {
      const created = await api.createUser({
        login: newLogin.trim().toLowerCase(),
        displayName: newDisplayName.trim(),
        password: newPassword,
        role: newRole,
      });
      setNewLogin('');
      setNewDisplayName('');
      setNewPassword('');
      setNewRole('viewer');
      setMessage(`Account “${created.login}” created.`);
      await refresh();
    } catch (cause) {
      setError(userError(cause));
    } finally {
      setUserBusy(null);
    }
  }

  async function updateUser(id: string, changes: { enabled?: boolean; role?: User['role']; password?: string }, success: string) {
    setUserBusy(id);
    setMessage(null);
    setError(null);
    try {
      await api.updateUser(id, changes);
      if (changes.password !== undefined) {
        setPasswordDrafts((current) => ({ ...current, [id]: '' }));
      }
      setMessage(success);
      await refresh();
    } catch (cause) {
      setError(userError(cause));
    } finally {
      setUserBusy(null);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, []);

  async function scan(rootId: string) {
    try {
      const result = await api.scanRoot(rootId);
      setMessage(result.queued ? `Scan queued for ${rootId}.` : `A scan for ${rootId} is already queued.`);
      await refresh();
    } catch {
      setError('The scan could not be requested.');
    }
  }

  async function toggleQueue() {
    if (!status) return;
    try {
      const result = await api.setQueuePaused(!status.queuePaused);
      setMessage(result.queuePaused ? 'Processing queue paused.' : 'Processing queue resumed.');
      await refresh();
    } catch {
      setError('The queue state could not be changed.');
    }
  }

  async function companionAction(
    action: 'confirm' | 'reject' | 'reset',
    sourceId: string,
    relatedId: string,
  ) {
    try {
      await api.companionAction(action, sourceId, relatedId);
      setMessage(
        action === 'confirm'
          ? 'Companion confirmed — the two files now appear as one recording.'
          : action === 'reject'
            ? 'Companion unpaired; the decision persists across scans.'
            : 'Companion decision reset; the next scan can pair it again.',
      );
      await refresh();
    } catch {
      setError('The companion decision could not be saved.');
    }
  }

  async function exportAction(action: 'link' | 'unlink', sourceId: string, exportId: string) {
    try {
      await api.exportAction(action, sourceId, exportId);
      setMessage(action === 'link' ? 'Spherical export linked.' : 'Spherical export unlinked.');
      await refresh();
    } catch {
      setError('The export link could not be changed. The export must be a present, equirectangular video.');
    }
  }

  async function linkSelectedExport() {
    if (!exportSource || !exportTarget) return;
    await exportAction('link', exportSource, exportTarget);
  }

  async function jobAction(id: string, action: 'retry' | 'cancel') {
    try {
      if (action === 'retry') await api.retryJob(id);
      else await api.cancelJob(id);
      await refresh();
    } catch {
      setError(`The job could not be ${action === 'retry' ? 'retried' : 'cancelled'}.`);
    }
  }

  return (
    <section class="page">
      <header class="page-header">
        <div>
          <h2>Administration</h2>
          <p class="muted">Library health, processing queue and storage state. Refreshes every 10 seconds.</p>
        </div>
        <button class="button" type="button" onClick={() => void refresh()}>
          Refresh
        </button>
      </header>

      {message ? <div class="notice success">{message}</div> : null}
      {error ? <div class="notice error">{error}</div> : null}
      {!status ? <p class="muted">Loading…</p> : null}

      {status ? (
        <>
          <div class="stat-row">
            <div class="stat">
              <span class="stat-value">{status.roots.length}</span>
              <span class="muted small">Media roots</span>
            </div>
            <div class="stat">
              <span class="stat-value">{status.unsupportedCount}</span>
              <span class="muted small">Need conversion</span>
            </div>
            <div class="stat">
              <span class="stat-value">{status.dataFreeBytes === null ? 'n/a' : formatBytes(status.dataFreeBytes)}</span>
              <span class="muted small">Free data space</span>
            </div>
            <div class="stat">
              <span class="stat-value">{status.exiftoolConfigured ? 'on' : 'off'}</span>
              <span class="muted small">ExifTool metadata</span>
            </div>
          </div>

          <section class="panel">
            <div class="panel-header">
              <div>
                <h3>Users</h3>
                <p class="muted small">Create household accounts and control administrative access.</p>
              </div>
              <span class="pill">{users.filter((user) => user.enabled).length} enabled</span>
            </div>

            <form class="user-form" onSubmit={createUser}>
              <label class="field">
                <span>Username</span>
                <input
                  name="new-login"
                  autocomplete="off"
                  autocapitalize="none"
                  spellcheck={false}
                  value={newLogin}
                  minlength={3}
                  maxlength={64}
                  pattern="[a-z0-9._-]+"
                  required
                  onInput={(event) => setNewLogin((event.currentTarget as HTMLInputElement).value.toLowerCase())}
                />
              </label>
              <label class="field">
                <span>Display name</span>
                <input
                  name="new-display-name"
                  autocomplete="off"
                  value={newDisplayName}
                  maxlength={100}
                  required
                  onInput={(event) => setNewDisplayName((event.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <label class="field">
                <span>Temporary password</span>
                <input
                  name="new-password"
                  type="password"
                  autocomplete="new-password"
                  value={newPassword}
                  minlength={12}
                  maxlength={512}
                  required
                  onInput={(event) => setNewPassword((event.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <label class="field">
                <span>Role</span>
                <select
                  name="new-role"
                  value={newRole}
                  onChange={(event) => setNewRole((event.currentTarget as HTMLSelectElement).value as User['role'])}
                >
                  <option value="viewer">Viewer</option>
                  <option value="admin">Administrator</option>
                </select>
              </label>
              <button class="button primary" type="submit" disabled={userBusy !== null}>
                {userBusy === 'create' ? 'Creating…' : 'Add user'}
              </button>
            </form>

            <div class="table-wrap">
              <table class="table users-table">
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                    <th scope="col">Reset password</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => {
                    const isSelf = user.id === currentUser.id;
                    const busy = userBusy === user.id;
                    const password = passwordDrafts[user.id] ?? '';
                    return (
                      <tr key={user.id}>
                        <td>
                          <strong>{user.displayName}</strong>
                          <div class="muted small">
                            {user.login}{isSelf ? ' · you' : ''}
                          </div>
                        </td>
                        <td>
                          <select
                            aria-label={`Role for ${user.login}`}
                            value={user.role}
                            disabled={busy || isSelf}
                            onChange={(event) => {
                              const role = (event.currentTarget as HTMLSelectElement).value as User['role'];
                              void updateUser(user.id, { role }, `${user.login} is now ${role === 'admin' ? 'an administrator' : 'a viewer'}.`);
                            }}
                          >
                            <option value="viewer">Viewer</option>
                            <option value="admin">Administrator</option>
                          </select>
                        </td>
                        <td>
                          <span class={`pill ${user.enabled ? 'healthy' : 'unavailable'}`}>
                            {user.enabled ? 'enabled' : 'disabled'}
                          </span>
                        </td>
                        <td>
                          <div class="user-password-form">
                            <input
                              aria-label={`New password for ${user.login}`}
                              type="password"
                              autocomplete="new-password"
                              minlength={12}
                              maxlength={512}
                              placeholder="At least 12 characters"
                              value={password}
                              disabled={busy}
                              onInput={(event) =>
                                setPasswordDrafts((current) => ({
                                  ...current,
                                  [user.id]: (event.currentTarget as HTMLInputElement).value,
                                }))
                              }
                            />
                            <button
                              class="button small"
                              type="button"
                              disabled={busy || password.length < 12}
                              onClick={() =>
                                void updateUser(user.id, { password }, `Password reset for ${user.login}; existing sessions were revoked.`)
                              }
                            >
                              Reset
                            </button>
                          </div>
                        </td>
                        <td>
                          <button
                            class="button ghost small"
                            type="button"
                            disabled={busy || isSelf}
                            onClick={() =>
                              void updateUser(
                                user.id,
                                { enabled: !user.enabled },
                                `${user.login} ${user.enabled ? 'disabled; existing sessions were revoked' : 'enabled'}.`,
                              )
                            }
                          >
                            {user.enabled ? 'Disable' : 'Enable'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section class="panel">
            <h3>Media roots</h3>
            <ul class="list">
              {status.roots.map((root) => (
                <li key={root.id} class="list-row">
                  <div>
                    <strong>{root.name}</strong>
                    <span class={`pill ${root.health}`}>{root.health}</span>
                    <div class="muted small">
                      Last successful scan: {root.lastSuccessAt ? new Date(root.lastSuccessAt).toLocaleString() : 'never'}
                    </div>
                  </div>
                  <button class="button small" type="button" onClick={() => void scan(root.id)}>
                    Scan now
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section class="panel">
            <div class="panel-header">
              <h3>Processing queue</h3>
              <button class="button small" type="button" onClick={() => void toggleQueue()}>
                {status.queuePaused ? 'Resume queue' : 'Pause queue'}
              </button>
            </div>
            <p class="muted small">
              {Object.entries(status.jobs)
                .map(([key, value]) => `${key}: ${value}`)
                .join(' · ') || 'No jobs yet'}
            </p>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col">Status</th>
                    <th scope="col">Attempts</th>
                    <th scope="col">Last error</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id}>
                      <td>{job.kind}</td>
                      <td>{job.status}</td>
                      <td>
                        {job.attempts}/{job.maxAttempts}
                      </td>
                      <td class="error-cell">{job.lastError ?? '—'}</td>
                      <td class="actions-cell">
                        {job.status === 'failed' || job.status === 'retry_wait' ? (
                          <button class="button small" type="button" onClick={() => void jobAction(job.id, 'retry')}>
                            Retry
                          </button>
                        ) : null}
                        {job.status === 'queued' || job.status === 'retry_wait' ? (
                          <button class="button ghost small" type="button" onClick={() => void jobAction(job.id, 'cancel')}>
                            Cancel
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {jobs.length === 0 ? (
                    <tr>
                      <td colSpan={5} class="muted">
                        Nothing queued.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section class="panel">
            <h3>Files needing attention</h3>
            <p class="muted small">
              Unsupported or failed items stay in the library with the reason recorded during probing.
            </p>
            {unsupported && unsupported.items.length > 0 ? (
              <ul class="list">
                {unsupported.items.slice(0, 50).map((item) => (
                  <li key={item.id} class="list-row">
                    <div>
                      <strong>{item.fileName}</strong> <span class="pill">{item.state}</span>
                      <div class="muted small">{item.reason ?? 'No reason recorded'}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="muted small">No unsupported or failed files recorded.</p>
            )}
          </section>

          <section class="panel">
            <h3>Camera companions (OSV/LRF)</h3>
            <p class="muted small">
              Pairs are only proposed inside one folder with an exact filename stem, agreeing durations and no conflicting
              capture timestamps. Confirming merges favorites, albums and history onto the OSV recording; both files stay
              untouched and the LRF is offered only as a labeled preview.
            </p>
            {companions ? (
              <>
                <p class="muted small">
                  {companions.summary.confirmed} confirmed · {companions.summary.pending} pending ·{' '}
                  {companions.summary.ambiguous} needing review · {companions.summary.rejected} rejected
                </p>
                {companions.checks.length > 0 ? (
                  <ul class="list">
                    {companions.checks.map((check) => (
                      <li key={`${check.canonicalId}:${check.companionId}`} class="list-row">
                        <div>
                          <strong>{check.canonicalPath}</strong> <span class="pill">{check.status}</span>
                          <div class="muted small">{check.companionPath}</div>
                          <div class="muted small">{check.reason}</div>
                        </div>
                        <div class="actions-cell">
                          <button
                            class="button small"
                            type="button"
                            onClick={() => void companionAction('confirm', check.canonicalId, check.companionId)}
                          >
                            Confirm
                          </button>
                          <button
                            class="button ghost small"
                            type="button"
                            onClick={() => void companionAction('reject', check.canonicalId, check.companionId)}
                          >
                            Unpair
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {companions.relations.length > 0 ? (
                  <ul class="list">
                    {companions.relations.map((relation) => (
                      <li key={`${relation.canonicalId}:${relation.companionId}`} class="list-row">
                        <div>
                          <strong>{relation.canonicalPath}</strong>{' '}
                          <span class="pill ready">paired</span>
                          <div class="muted small">Preview: {relation.companionPath}</div>
                        </div>
                        <button
                          class="button ghost small"
                          type="button"
                          onClick={() => void companionAction('reject', relation.canonicalId, relation.companionId)}
                        >
                          Unpair
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {companions.checks.length === 0 && companions.relations.length === 0 ? (
                  <p class="muted small">No OSV/LRF pairs found in the library.</p>
                ) : null}
              </>
            ) : (
              <p class="muted small">Loading companions…</p>
            )}
          </section>

          <section class="panel">
            <h3>Spherical exports (DJI)</h3>
            <p class="muted small">
              Raw dual-fisheye OSV files need a full-sphere export from DJI Studio. Import the export into a media root,
              then link it here: the recording plays through the export while the raw original keeps its
              conversion-required state and both files stay untouched.
            </p>
            {exportData ? (
              <>
                {exportData.relations.length > 0 ? (
                  <ul class="list">
                    {exportData.relations.map((relation) => (
                      <li key={relation.mediaId} class="list-row">
                        <div>
                          <strong>{relation.fileName}</strong> <span class="pill ready">linked export</span>
                          <div class="muted small">{relation.relativePath}</div>
                          <div class="muted small">
                            {relation.width && relation.height ? `${relation.width} × ${relation.height} · ` : ''}
                            linked {relation.linkedAt ? new Date(relation.linkedAt).toLocaleString() : 'unknown'}
                          </div>
                        </div>
                        <button
                          class="button ghost small"
                          type="button"
                          onClick={() => void exportAction('unlink', relation.sourceId, relation.mediaId)}
                        >
                          Unlink
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p class="muted small">No export links yet.</p>
                )}
                {exportData.originals.length > 0 && exportData.candidates.length > 0 ? (
                  <div class="export-linker">
                    <label>
                      <span>Raw original</span>
                      <select
                        value={exportSource}
                        onChange={(event) => setExportSource((event.currentTarget as HTMLSelectElement).value)}
                      >
                        <option value="">Choose a raw OSV…</option>
                        {exportData.originals.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.relativePath}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Spherical export</span>
                      <select
                        value={exportTarget}
                        onChange={(event) => setExportTarget((event.currentTarget as HTMLSelectElement).value)}
                      >
                        <option value="">Choose an equirectangular video…</option>
                        {exportData.candidates.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.relativePath}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      class="button small"
                      type="button"
                      disabled={!exportSource || !exportTarget}
                      onClick={() => void linkSelectedExport()}
                    >
                      Link export
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <p class="muted small">Loading exports…</p>
            )}
          </section>

          <section class="panel">
            <h3>Duplicate candidates</h3>
            <p class="muted small">
              Confirmed by SHA-256 of the original file. Nothing is deleted automatically; review the paths before acting.
            </p>
            {duplicates && duplicates.groups.length > 0 ? (
              <>
                <p class="muted small">
                  {duplicates.groups.length} group(s) · {formatBytes(duplicates.reclaimableBytes)} duplicated beyond one copy
                  {duplicates.truncated ? ' · only the first 100 groups are shown' : ''}
                </p>
                <ul class="list">
                  {duplicates.groups.map((group) => (
                    <li key={group.hash} class="list-row">
                      <div>
                        <strong>{group.count} identical files</strong>{' '}
                        <span class="muted small">{formatBytes(group.bytes)} total</span>
                        <div class="muted small">{group.items.map((item) => item.relativePath).join(' · ')}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p class="muted small">No duplicate groups found yet. Hashing runs after metadata probing.</p>
            )}
          </section>
        </>
      ) : null}
    </section>
  );
}
