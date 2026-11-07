import { lazy, Suspense } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  formatBytes,
  formatDate,
  formatDuration,
  type MediaDetail,
  type MediaExperience,
  type MediaItem,
  type PanoTiles,
  type PlaybackOption,
} from './api.ts';

// Pannellum lives in its own chunk; ordinary photos never pay for it.
const PanoStage = lazy(() => import('./pano.tsx'));
// The spherical video stage has no dependency, but stays lazy so flat video
// and photos never download shader code they will not run.
const SphereVideo = lazy(() => import('./sphere-video.tsx'));

const PROJECTIONS = ['flat', 'equirectangular', 'dual_fisheye', 'unknown'] as const;

function optionKey(kind: string, profile: string | null): string {
  return `${kind}:${profile ?? ''}`;
}

function describePlayback(option: PlaybackOption): string {
  const dimensions = option.width && option.height ? ` · ${option.width}×${option.height}` : '';
  const size = option.bytes ? ` · ${formatBytes(option.bytes)}` : '';
  return `${option.label}${dimensions}${size}`;
}

type Props = {
  items: MediaItem[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  onFavorite: (index: number, value: boolean) => void;
  /** Administrators may save the panorama start view to the catalog. */
  canEdit?: boolean;
};

export function Viewer({ items, index, onIndex, onClose, onFavorite, canEdit = false }: Props) {
  const item = items[index];
  const [detail, setDetail] = useState<MediaDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [favorite, setFavoriteState] = useState(item?.favorite ?? false);
  const [pano, setPano] = useState<PanoTiles | null>(null);
  // The viewer fell back to the flat preview after a render failure.
  const [panoFallback, setPanoFallback] = useState(false);
  const [sphereFallback, setSphereFallback] = useState(false);
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [viewSave, setViewSave] = useState<'saved' | 'failed' | null>(null);
  const [projectionNote, setProjectionNote] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Explicit representation choice; null follows the server's best-first order.
  const [source, setSource] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // The spherical stage owns its own video element; this keeps the position
  // available for a quality switch and for the close/move-away save.
  const spherePositionRef = useRef(0);
  // A quality switch reloads the element but keeps the playhead position.
  const pendingSeekRef = useRef<number | null>(null);
  // A saved override replaces probe evidence without reloading the gallery.
  const projection = detail?.projection ?? item?.projection;
  const lastSavedRef = useRef(0);
  const endedRef = useRef(false);

  useEffect(() => {
    if (!item) return;
    setDetail(null);
    setError(null);
    setResumedAt(null);
    setProjectionNote(null);
    setPanoFallback(false);
    setSphereFallback(false);
    spherePositionRef.current = 0;
    setSource(null);
    pendingSeekRef.current = null;
    lastSavedRef.current = 0;
    endedRef.current = false;
    setFavoriteState(item.favorite);
    let cancelled = false;
    api
      .media(item.id)
      .then((value) => {
        if (!cancelled) setDetail(value);
      })
      .catch(() => {
        if (!cancelled) setError('This item could not be opened.');
      });

    // Opening records recency but sends no position, so a saved resume point
    // is not overwritten by simply opening the item.
    api.markViewed(item.id).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [item?.id, reload]);

  // Persist the last position when the viewer closes or moves to another item.
  useEffect(() => {
    return () => {
      const video = videoRef.current;
      const position =
        video && Number.isFinite(video.currentTime) ? video.currentTime : spherePositionRef.current;
      if (!item || endedRef.current || !Number.isFinite(position) || position < 1) return;
      api.markViewed(item.id, Math.floor(position)).catch(() => {});
    };
  }, [item?.id]);

  function savePosition(position: number, force = false): void {
    if (!item || endedRef.current || !Number.isFinite(position) || position < 0) return;
    const whole = Math.floor(position);
    // Throttle routine time updates to five-second steps.
    if (!force && Math.abs(whole - lastSavedRef.current) < 5) return;
    lastSavedRef.current = whole;
    api.markViewed(item.id, whole).catch(() => {});
  }

  // The spherical stage reports its own playhead; keep the last value so a
  // quality switch or unmount can save it even if the five-second throttle
  // has not fired yet.
  function handleSpherePosition(seconds: number, force = false): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    spherePositionRef.current = seconds;
    savePosition(seconds, force);
  }

  function resumeFromSaved(event: Event): void {
    const video = event.currentTarget as HTMLVideoElement;
    const saved = detail?.playbackPositionSeconds ?? 0;
    if (!Number.isFinite(saved) || saved < 5) return;
    // Do not drop the viewer seconds before the end; starting over is kinder.
    if (Number.isFinite(video.duration) && saved >= video.duration - 10) return;
    video.currentTime = saved;
    lastSavedRef.current = saved;
    setResumedAt(saved);
  }

  function choosePlayback(value: string): void {
    const video = videoRef.current;
    const current =
      video && Number.isFinite(video.currentTime) && video.currentTime > 0
        ? video.currentTime
        : spherePositionRef.current;
    if (current > 0) {
      // Persist first: the new source starts at this position, not at zero.
      pendingSeekRef.current = current;
      savePosition(current, true);
    }
    setResumedAt(null);
    setSource(value);
  }

  useEffect(() => {
    if (!item) return;
    setPano(null);
    setViewSave(null);
    if (item.type !== 'photo' || projection !== 'equirectangular') return;
    let cancelled = false;
    // A 404 simply means the pyramid is still being generated (or failed);
    // the flat preview remains usable in that case.
    api
      .tiles(item.id)
      .then((config) => {
        if (!cancelled) setPano(config);
      })
      .catch(() => {
        if (!cancelled) setPano(null);
      });
    return () => {
      cancelled = true;
    };
  }, [item?.id, item?.type, projection]);

  // The chosen representation decides whether arrows navigate items or look
  // around the sphere. This mirrors the render's selection before the early
  // return, so the hook is never skipped.
  const sphereSelected =
    item?.type === 'video' &&
    !sphereFallback &&
    ((detail?.playbackOptions ?? []).find(
      (option) => optionKey(option.kind, option.profile) === source,
    ) ??
      detail?.playbackOptions?.[0] ??
      detail?.playback ??
      null)?.spherical === true;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      // The panorama and spherical-video stages own the arrow keys while mounted.
      if (pano || sphereSelected) return;
      if (event.key === 'ArrowRight' && index < items.length - 1) onIndex(index + 1);
      if (event.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onClose, onIndex, pano, sphereSelected]);

  if (!item) return null;

  async function saveStartView(orientation: { yaw: number; pitch: number; roll: number }) {
    try {
      const saved = await api.saveOverrides(item.id, {
        yawDegrees: orientation.yaw,
        pitchDegrees: orientation.pitch,
        rollDegrees: orientation.roll,
      });
      // The manifest is immutable, so the saved orientation is kept locally to
      // keep reset-view consistent with the catalog until the next request.
      setPano((current) => (current ? { ...current, orientation: saved.orientation } : current));
      setViewSave('saved');
    } catch {
      setViewSave('failed');
    }
  }

  async function changeProjection(next: string) {
    try {
      await api.saveOverrides(item.id, { projection: next as (typeof PROJECTIONS)[number] });
      setProjectionNote(null);
      setReload((value) => value + 1);
    } catch {
      setProjectionNote('The projection could not be saved.');
    }
  }

  async function toggleFavorite() {
    const next = !favorite;
    setFavoriteState(next);
    onFavorite(index, next);
    try {
      await api.favorite(item.id, next);
    } catch {
      setFavoriteState(!next);
      onFavorite(index, !next);
    }
  }

  const reason = detail?.metadata?.unsupportedReason ?? item.unsupportedReason;
  const unsupported = item.processingState === 'unsupported' || item.processingState === 'failed';
  // The server explains the state once the detail arrives; until then the
  // gallery row is the only evidence the client has.
  const fallbackState =
    item.processingState === 'failed'
      ? 'failed'
      : item.processingState === 'unsupported'
        ? 'conversion_required'
        : item.processingState === 'pending' || item.processingState === 'processing'
          ? 'processing'
          : 'ready';
  const experience: MediaExperience = detail?.experience ?? {
    state: fallbackState,
    title:
      fallbackState === 'failed'
        ? 'Processing failed'
        : fallbackState === 'conversion_required'
          ? 'Conversion required'
          : fallbackState === 'processing'
            ? 'Processing'
            : 'Ready',
    detail:
      fallbackState === 'conversion_required'
        ? (reason ?? 'This file is preserved but cannot be displayed yet.')
        : fallbackState === 'processing'
          ? 'Previews and playback are being prepared. This item will be usable once processing finishes.'
          : 'Processing this file did not complete.',
    retryable: fallbackState === 'failed',
  };
  const playbackOptions = detail?.playbackOptions ?? [];
  // An explicit choice wins; otherwise the server's best-first order applies.
  const playback =
    playbackOptions.find((option) => optionKey(option.kind, option.profile) === source) ??
    playbackOptions[0] ??
    detail?.playback ??
    null;
  // Until the detail response arrives, a ready item can start on its original;
  // an unsupported one waits so a companion preview is not hidden by a notice.
  const canPlay = item.type === 'video' && (playback !== null || (detail === null && !unsupported));
  // A sphere played through a plain video element is a flat presentation; say
  // so instead of letting the equirectangular frame pass as an ordinary video.
  const sphericalSource = item.type === 'video' && playback?.spherical === true;
  // If the WebGL stage cannot start, the same flat video the viewer used
  // before remains playable with native controls.
  const sphericalVideo = sphericalSource && !sphereFallback;
  return (
    <div class="viewer" role="dialog" aria-modal="true" aria-label={item.fileName}>
      <div class="viewer-bar">
        <div class="viewer-title">
          <strong>{item.fileName}</strong>
          <span class="muted small">{formatDate(item.captureDate)}</span>
        </div>
        <div class="viewer-actions">
          {playbackOptions.length > 1 ? (
            <label class="viewer-quality">
              <span>Quality</span>
              <select
                value={playback ? optionKey(playback.kind, playback.profile) : ''}
                onChange={(event) => choosePlayback((event.currentTarget as HTMLSelectElement).value)}
              >
                {playbackOptions.map((option) => (
                  <option key={optionKey(option.kind, option.profile)} value={optionKey(option.kind, option.profile)}>
                    {describePlayback(option)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button class="button ghost" type="button" onClick={toggleFavorite} aria-pressed={favorite}>
            {favorite ? '★ Favorite' : '☆ Favorite'}
          </button>
          <a class="button ghost" href={item.originalUrl} download>
            Download original
          </a>
          {detail?.companion ? (
            <a class="button ghost" href={detail.companion.url} download>
              Download preview (LRF)
            </a>
          ) : null}
          <button class="button ghost" type="button" onClick={onClose} aria-label="Close viewer">
            ✕
          </button>
        </div>
      </div>

      <div class="viewer-stage">
        {error ? (
          <div class="notice error">
            <h3>Unavailable</h3>
            <p>{error}</p>
          </div>
        ) : sphericalVideo ? (
          <Suspense
            fallback={
              <div class="notice" aria-live="polite">
                <h3>Loading 360° video</h3>
                <p>Starting the spherical video renderer.</p>
              </div>
            }
          >
            <SphereVideo
              key={playback?.url ?? item.id}
              src={playback?.url ?? item.originalUrl}
              poster={item.posterUrl ?? undefined}
              // A quality switch carries the playhead; otherwise resume the catalog position.
              startAt={pendingSeekRef.current ?? detail?.playbackPositionSeconds ?? null}
              onPosition={handleSpherePosition}
              onEnded={() => {
                endedRef.current = true;
                lastSavedRef.current = 0;
                setResumedAt(null);
                api.markViewed(item.id, 0).catch(() => {});
              }}
              onFallback={() => setSphereFallback(true)}
            />
          </Suspense>
        ) : canPlay ? (
          <video
            ref={videoRef}
            class="viewer-media"
            controls
            preload="metadata"
            playsInline
            poster={item.posterUrl ?? undefined}
            src={playback?.url ?? item.originalUrl}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget as HTMLVideoElement;
              const pending = pendingSeekRef.current;
              if (pending !== null && Number.isFinite(pending)) {
                pendingSeekRef.current = null;
                video.currentTime = pending;
                lastSavedRef.current = Math.floor(pending);
                setResumedAt(Math.floor(pending));
                return;
              }
              resumeFromSaved(event);
            }}
            onTimeUpdate={(event) => {
              const video = event.currentTarget as HTMLVideoElement;
              if (!video.paused) savePosition(video.currentTime);
            }}
            onPause={(event) => savePosition((event.currentTarget as HTMLVideoElement).currentTime, true)}
            onEnded={() => {
              endedRef.current = true;
              lastSavedRef.current = 0;
              setResumedAt(null);
              api.markViewed(item.id, 0).catch(() => {});
            }}
          />
        ) : pano ? (
          <Suspense
            fallback={
              <div class="notice" aria-live="polite">
                <h3>Loading 360° viewer</h3>
                <p>Starting the interactive panorama.</p>
              </div>
            }
          >
            <PanoStage
              config={pano}
              onFallback={() => {
                setPanoFallback(true);
                setPano(null);
              }}
              onSaveView={canEdit ? (orientation) => void saveStartView(orientation) : undefined}
              onPrevious={() => onIndex(index - 1)}
              onNext={() => onIndex(index + 1)}
              canPrevious={index > 0}
              canNext={index < items.length - 1}
            />
          </Suspense>
        ) : experience.state !== 'ready' ? (
          <div
            class={experience.state === 'failed' ? 'notice error' : 'notice'}
            aria-live={experience.state === 'processing' ? 'polite' : undefined}
          >
            <h3>{experience.title}</h3>
            <p>{experience.detail}</p>
            {experience.state === 'failed' && experience.retryable ? (
              <p class="muted small">
                An administrator can retry processing after checking that the source file is readable.
              </p>
            ) : null}
          </div>
        ) : (
          <img class="viewer-media" src={item.previewUrl ?? item.originalUrl} alt={item.fileName} />
        )}
      </div>

      <div class="viewer-meta">
        <span>{projection === 'equirectangular' ? 'Equirectangular 360°' : projection}</span>
        {item.width && item.height ? (
          <span>
            {item.width} × {item.height}
          </span>
        ) : null}
        {item.type === 'video' && item.durationMs ? <span>{formatDuration(item.durationMs)}</span> : null}
        <span>{formatBytes(item.sizeBytes)}</span>
        {detail?.metadata?.videoCodec ? <span>{detail.metadata.videoCodec}</span> : null}
        {detail?.metadata?.hdr ? (
          <span class="muted">
            {detail.metadata.hdr === 'pq' ? 'HDR PQ' : detail.metadata.hdr === 'hlg' ? 'HDR HLG' : 'Wide-gamut'} source
            {playback?.toneMapped ? ' · tone-mapped to SDR' : ''}
          </span>
        ) : null}
        {detail?.metadata?.rotationDegrees ? (
          <span class="muted">Rotated {detail.metadata.rotationDegrees}°</span>
        ) : null}
        {item.type === 'video' && detail?.renditionUrl ? <span class="muted">H.264 rendition</span> : null}
        {playback ? <span class="muted">{playback.label}</span> : null}
        {sphericalSource && sphereFallback ? (
          <span class="muted">Flat video — spherical view unavailable.</span>
        ) : null}
        {detail?.companion ? (
          <span class="muted">
            {detail.companion.width && detail.companion.height
              ? `Companion ${detail.companion.width} × ${detail.companion.height}`
              : 'Companion available'}
            {detail.originalConversionRequired ? ' · original requires conversion' : ''}
          </span>
        ) : null}
        {resumedAt !== null ? (
          <span class="muted">Resumed at {formatDuration(resumedAt * 1000)}</span>
        ) : null}
        {projection === 'equirectangular' ? (
          <span class="muted">
            {pano
              ? 'Interactive 360° — drag to look, pinch or scroll to zoom.'
              : detail?.tiles?.state === 'pending'
                ? '360° tiles are still being prepared; showing the flat preview.'
                : detail?.tiles?.state === 'failed'
                  ? `${detail.tiles.reason ?? 'Tile generation failed'} — showing the flat preview.`
                  : detail?.tiles?.state === 'ineligible'
                    ? `${detail.tiles.reason ?? 'This photo is not tile-eligible'} — showing the flat preview.`
                    : 'Flat preview — interactive tiles are not ready for this photo.'}
          </span>
        ) : null}
        {panoFallback ? <span class="muted">Interactive view unavailable — showing the flat preview.</span> : null}
        {viewSave === 'saved' ? <span class="muted">Start view saved</span> : null}
        {viewSave === 'failed' ? <span class="muted">Start view could not be saved</span> : null}
        {canEdit && item.type === 'photo' && detail ? (
          <label class="viewer-projection">
            <span>Projection</span>
            <select
              value={projection}
              onChange={(event) => void changeProjection((event.currentTarget as HTMLSelectElement).value)}
            >
              {PROJECTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {projectionNote ? <span class="muted">{projectionNote}</span> : null}
      </div>

      <div class="viewer-nav">
        <button class="button ghost" type="button" disabled={index === 0} onClick={() => onIndex(index - 1)}>
          ← Previous
        </button>
        <button
          class="button ghost"
          type="button"
          disabled={index >= items.length - 1}
          onClick={() => onIndex(index + 1)}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
