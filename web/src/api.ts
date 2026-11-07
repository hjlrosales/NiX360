export type User = {
  id: string;
  login: string;
  displayName: string;
  role: 'admin' | 'viewer';
};

export type AdminUser = User & {
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MediaItem = {
  id: string;
  type: 'photo' | 'video';
  projection: 'flat' | 'equirectangular' | 'dual_fisheye' | 'unknown';
  processingState: 'pending' | 'processing' | 'ready' | 'unsupported' | 'failed';
  availability: 'present' | 'missing';
  captureDate: string | null;
  captureDateCertain: boolean;
  fileName: string;
  relativePath: string;
  folder: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  directPlay: boolean;
  unsupportedReason: string | null;
  favorite: boolean;
  lastViewedAt: string | null;
  sourceVersion: number;
  thumbnailUrl: string;
  posterUrl: string | null;
  previewUrl: string | null;
  originalUrl: string;
};

export type MediaPage = { items: MediaItem[]; nextCursor: string | null };

export type PanoTiles = {
  type: 'multires';
  basePath: string;
  path: string;
  extension: string;
  tileResolution: number;
  maxLevel: number;
  cubeResolution: number;
  recipe: string;
  preview: string | null;
  orientation: { yaw: number; pitch: number; roll: number };
};

export type PanoramaStatus = {
  state: 'ready' | 'pending' | 'failed' | 'ineligible';
  recipe: string;
  reason: string | null;
};

export type PlaybackOption = {
  kind: 'preview' | 'rendition' | 'original' | 'export';
  profile: string | null;
  url: string;
  label: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  directPlay: boolean;
  /** Effective projection of the file this option actually serves. */
  projection: string;
  /** True for an equirectangular representation; the viewer labels it explicitly. */
  spherical: boolean;
  /** True when an HDR/wide-gamut source was converted to SDR for this option. */
  toneMapped: boolean;
};

export type MediaExperience = {
  state: 'ready' | 'processing' | 'conversion_required' | 'failed';
  title: string;
  detail: string;
  /** True when re-running processing may succeed without changing the source. */
  retryable: boolean;
};

export type MediaDetail = MediaItem & {
  missingSince: string | null;
  contentHash: string | null;
  duplicateCount: number;
  renditionUrl: string | null;
  canonicalId: string;
  requestedId: string;
  originalConversionRequired: boolean;
  /** The server's explanation of what the browser can do with this item. */
  experience: MediaExperience;
  /** A confirmed full-sphere export linked to a raw original, if any. */
  export: {
    sourceId: string;
    mediaId: string;
    fileName: string;
    relativePath: string;
    availability: string;
    sourceVersion: number;
    projection: string;
    directPlay: boolean;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    policyVersion: number;
    linkedAt: string | null;
    provenance: unknown;
    playable: boolean;
  } | null;
  companion: {
    mediaId: string;
    fileName: string;
    relativePath: string;
    availability: string;
    sourceVersion: number;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    videoCodec: string | null;
    projection: string;
    directPlay: boolean;
    url: string;
  } | null;
  playback: PlaybackOption | null;
  playbackOptions: PlaybackOption[];
  playbackPositionSeconds: number | null;
  /** Why the interactive panorama is available; null for non-photos. */
  tiles: PanoramaStatus | null;
  metadata: {
    width: number | null;
    height: number | null;
    durationMs: number | null;
    videoCodec: string | null;
    audioCodec: string | null;
    bitDepth: number | null;
    frameRate: string | null;
    colorSpace: string | null;
    colorTransfer: string | null;
    colorPrimaries: string | null;
    hdr: 'pq' | 'hlg' | 'wide_gamut' | null;
    rotationDegrees: number;
    metadataSource: string;
    projectionSource: string;
    directPlay: boolean;
    gps: { lat: number; lon: number } | null;
    unsupportedReason: string | null;
    probedAt: string | null;
  } | null;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let code = `http_${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (parsed.error) code = parsed.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(response.status, code);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  session: () => request<{ user: User | null }>('/api/session'),
  login: (login: string, password: string) =>
    request<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ login, password }) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  revokeSessions: () => request<{ ok: true }>('/api/auth/sessions', { method: 'DELETE' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/api/auth/password', {
      method: 'PATCH',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  library: (query: Record<string, string>) =>
    request<MediaPage>(`/api/library?${new URLSearchParams(query).toString()}`),
  folders: (folderPath = '') =>
    request<{
      path: string;
      mediaCount: number;
      truncated: boolean;
      folders: { name: string; path: string; count: number }[];
    }>(`/api/folders?${new URLSearchParams({ path: folderPath }).toString()}`),
  media: (id: string) => request<MediaDetail>(`/api/media/${id}`),
  tiles: (id: string) => request<PanoTiles>(`/api/media/${id}/tiles`),
  saveOverrides: (
    id: string,
    overrides: {
      yawDegrees?: number;
      pitchDegrees?: number;
      rollDegrees?: number;
      projection?: MediaItem['projection'] | null;
    },
  ) =>
    request<{
      orientation: { yaw: number; pitch: number; roll: number };
      projection: MediaItem['projection'] | null;
      tiles: PanoramaStatus | null;
    }>(`/api/media/${id}/overrides`, { method: 'PATCH', body: JSON.stringify(overrides) }),
  favorite: (id: string, favorite: boolean) =>
    request<{ favorite: boolean }>(`/api/media/${id}/favorite`, {
      method: 'PUT',
      body: JSON.stringify({ favorite }),
    }),
  markViewed: (mediaId: string, positionSeconds?: number) =>
    request<{ ok: true }>('/api/history', {
      method: 'POST',
      body: JSON.stringify({ mediaId, positionSeconds }),
    }),
  albums: () => request<{ albums: Album[] }>('/api/albums'),
  album: (id: string) => request<{ id: string; title: string; items: MediaItem[] }>(`/api/albums/${id}`),
  createAlbum: (title: string) =>
    request<Album>('/api/albums', { method: 'POST', body: JSON.stringify({ title }) }),
  addToAlbum: (albumId: string, mediaId: string) =>
    request<{ ok: true }>(`/api/albums/${albumId}/items`, {
      method: 'POST',
      body: JSON.stringify({ mediaId }),
    }),
  removeFromAlbum: (albumId: string, mediaId: string) =>
    request<{ ok: true }>(`/api/albums/${albumId}/items/${mediaId}`, { method: 'DELETE' }),
  adminStatus: () =>
    request<{
      media: { media_type: string; processing_state: string; count: number }[];
      jobs: Record<string, number>;
      roots: { id: string; name: string; health: string; lastSuccessAt: string | null }[];
      unsupportedCount: number;
      duplicateGroups: number;
      duplicateReclaimableBytes: number;
      queuePaused: boolean;
      dataFreeBytes: number | null;
      exiftoolConfigured: boolean;
    }>('/api/admin/status'),
  adminUsers: () => request<{ users: AdminUser[] }>('/api/admin/users'),
  createUser: (user: { login: string; displayName: string; password: string; role: User['role'] }) =>
    request<Omit<AdminUser, 'createdAt' | 'updatedAt'>>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(user),
    }),
  updateUser: (id: string, changes: { enabled?: boolean; role?: User['role']; password?: string }) =>
    request<AdminUser>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),
  adminJobs: () =>
    request<{
      jobs: {
        id: string;
        kind: string;
        status: string;
        attempts: number;
        maxAttempts: number;
        progress: number;
        lastError: string | null;
        nextRunAt: string;
        mediaId: string | null;
      }[];
    }>('/api/admin/jobs'),
  adminDuplicates: () =>
    request<{
      groups: {
        hash: string;
        count: number;
        bytes: number;
        items: { id: string; relativePath: string; sizeBytes: number }[];
      }[];
      reclaimableBytes: number;
      truncated: boolean;
    }>('/api/admin/duplicates'),
  setQueuePaused: (paused: boolean) =>
    request<{ queuePaused: boolean }>('/api/admin/queue', { method: 'POST', body: JSON.stringify({ paused }) }),
  adminUnsupported: () =>
    request<{
      items: { id: string; fileName: string; type: string; state: string; reason: string | null }[];
    }>('/api/admin/unsupported'),
  adminCompanions: () =>
    request<{
      relations: {
        canonicalId: string;
        companionId: string;
        canonicalPath: string;
        companionPath: string;
        policyVersion: number;
        provenance: unknown;
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
    }>('/api/admin/companions'),
  companionAction: (action: 'confirm' | 'reject' | 'reset', sourceId: string, relatedId: string) =>
    request<{ ok: true }>('/api/admin/companions', {
      method: 'POST',
      body: JSON.stringify({ action, sourceId, relatedId }),
    }),
  adminExports: () =>
    request<{
      relations: {
        sourceId: string;
        mediaId: string;
        fileName: string;
        relativePath: string;
        availability: string;
        sourceVersion: number;
        projection: string;
        directPlay: boolean;
        width: number | null;
        height: number | null;
        durationMs: number | null;
        policyVersion: number;
        linkedAt: string | null;
        provenance: unknown;
      }[];
      originals: {
        id: string;
        fileName: string;
        relativePath: string;
        projection: string;
        processingState: string;
        availability: string;
        width: number | null;
        height: number | null;
        durationMs: number | null;
      }[];
      candidates: {
        id: string;
        fileName: string;
        relativePath: string;
        projection: string;
        processingState: string;
        availability: string;
        width: number | null;
        height: number | null;
        durationMs: number | null;
      }[];
    }>('/api/admin/exports'),
  exportAction: (action: 'link' | 'unlink', sourceId: string, exportId: string) =>
    request<{ ok: true }>('/api/admin/exports', {
      method: 'POST',
      body: JSON.stringify({ action, sourceId, exportId }),
    }),
  retryJob: (id: string) => request<{ ok: true }>(`/api/admin/jobs/${id}/retry`, { method: 'POST' }),
  cancelJob: (id: string) => request<{ ok: true }>(`/api/admin/jobs/${id}/cancel`, { method: 'POST' }),
  scanRoot: (id: string) => request<{ queued: boolean }>(`/api/admin/roots/${id}/scan`, { method: 'POST' }),
};

export type Album = { id: string; title: string; itemCount: number; createdAt: string; updatedAt: string };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDate(value: string | null): string {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDuration(ms: number | null): string {
  if (!ms) return '';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
