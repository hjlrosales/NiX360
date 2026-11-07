import { useEffect, useRef, useState } from 'preact/hooks';
import 'pannellum/build/pannellum.js';
import 'pannellum/build/pannellum.css';
import type { PanoTiles } from './api.ts';

type Props = {
  config: PanoTiles;
  /** The parent shows the flat preview instead; this is the only lossless fallback. */
  onFallback: () => void;
  /** Present only for administrators; saves the current direction as the start view. */
  onSaveView?: (orientation: { yaw: number; pitch: number; roll: number }) => void;
  onPrevious?: () => void;
  onNext?: () => void;
  canPrevious?: boolean;
  canNext?: boolean;
};

type Failure = 'unsupported' | 'context_lost' | 'render';

const FAILURE_COPY: Record<Failure, { title: string; detail: string }> = {
  unsupported: {
    title: 'Interactive view unavailable',
    detail:
      'This browser could not create a WebGL context, so the 360° scene cannot be rendered. The flat preview still shows the whole sphere.',
  },
  context_lost: {
    title: '360° view stopped',
    detail:
      'The browser released the graphics context, usually after a GPU reset or a long spell in the background. Try the interactive view again, or keep using the flat preview.',
  },
  render: {
    title: 'Interactive view unavailable',
    detail:
      'The panorama tiles could not be loaded or rendered. Try again, or use the flat preview instead.',
  },
};

/** Pannellum does not report unreachable tiles as an error, only as endless loading. */
const LOAD_TIMEOUT_MS = 20_000;

/** Keyboard increments. Pannellum keeps the scene within its own hfov bounds. */
const YAW_STEP = 6;
const PITCH_STEP = 4;
const ZOOM_STEP = 0.85;
/** Matches the viewer config so the buttons stop where Pannellum's own bounds do. */
const MIN_HFOV = 50;
const MAX_HFOV = 110;

/** Cheap capability check so an incapable browser is told why, rather than showing a blank canvas. */
function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!context) return false;
    // The probe must not keep consuming one of the browser's limited contexts.
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * Thin adapter around Pannellum's multires viewer. The bundle is loaded with
 * this lazily imported module, so opening an ordinary photo never downloads it.
 * Every mount creates one viewer and every unmount destroys it, releasing WebGL
 * textures, listeners and timers. A lost WebGL context is recoverable: the
 * notice offers a rebuild, and a browser-restored context rebuilds on its own.
 *
 * Input is owned here rather than by Pannellum's built-in controls: Pannellum
 * still handles dragging and two-finger pinch on the canvas, while this module
 * adds window-level keys, zoom buttons, an immersive mode that keeps the tools
 * reachable, and previous/next navigation.
 */
export default function PanoStage({
  config,
  onFallback,
  onSaveView,
  onPrevious,
  onNext,
  canPrevious = false,
  canNext = false,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const viewer = useRef<PannellumViewer | null>(null);
  const [orientationSupported, setOrientationSupported] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Incrementing this rebuilds the viewer from scratch after a failure.
  const [attempt, setAttempt] = useState(0);
  const [immersive, setImmersive] = useState(false);

  useEffect(() => {
    if (!webglAvailable()) {
      setFailure('unsupported');
      return;
    }

    const element = host.current;
    const factory = window.pannellum;
    if (!element || !factory) {
      setFailure('render');
      return;
    }

    let instance: PannellumViewer | null = null;
    // Context events do not bubble, but capture still observes them on the host,
    // so this works whether or not Pannellum has created its canvas yet.
    const listeners = new AbortController();
    let lost = false;
    let loaded = false;
    let loadTimer: number | undefined;

    element.addEventListener(
      'webglcontextlost',
      (event) => {
        // Allowing the default would make restoration impossible.
        event.preventDefault();
        lost = true;
        setFailure('context_lost');
      },
      { capture: true, signal: listeners.signal },
    );
    element.addEventListener(
      'webglcontextrestored',
      () => {
        lost = false;
        setFailure(null);
        // Pannellum does not repaint a restored context by itself; rebuild it.
        setAttempt((value) => value + 1);
      },
      { capture: true, signal: listeners.signal },
    );

    try {
      instance = factory.viewer(element, {
        type: 'multires',
        multiRes: {
          basePath: config.basePath,
          path: config.path,
          extension: config.extension,
          tileResolution: config.tileResolution,
          maxLevel: config.maxLevel,
          cubeResolution: config.cubeResolution,
        },
        preview: config.preview ?? undefined,
        autoLoad: true,
        // The viewer owns the controls so they stay usable in immersive mode.
        showControls: false,
        disableKeyboardCtrl: true,
        compass: false,
        mouseZoom: true,
        hfov: 100,
        minHfov: MIN_HFOV,
        maxHfov: MAX_HFOV,
        yaw: config.orientation.yaw,
        pitch: config.orientation.pitch,
        horizonRoll: config.orientation.roll,
        escapeHTML: true,
        backgroundColor: [0.05, 0.07, 0.1],
      });
      viewer.current = instance;
      setOrientationSupported(instance.isOrientationSupported());
      // A pyramid that is missing or unreachable never finishes loading and
      // never raises `error`, so the notice is the only explanation a user gets.
      loadTimer = window.setTimeout(() => {
        if (!loaded && !lost) setFailure('render');
      }, LOAD_TIMEOUT_MS);
      instance.on('load', () => {
        loaded = true;
        window.clearTimeout(loadTimer);
      });
      instance.on('error', () => {
        // A recovered or already-explained failure keeps its original message.
        if (!lost) setFailure('render');
      });
    } catch {
      setFailure('render');
    }

    return () => {
      listeners.abort();
      window.clearTimeout(loadTimer);
      try {
        instance?.destroy();
      } catch {
        /* already torn down */
      }
      viewer.current = null;
      element.replaceChildren();
    };
    // The manifest is immutable for a source version; rebuild only when it,
    // the saved orientation or an explicit retry changes.
  }, [config.basePath, config.maxLevel, config.cubeResolution, config.orientation.yaw, config.orientation.pitch, attempt]);

  // An exit from native fullscreen (Escape, the browser's own control) must
  // clear the immersive state; Pannellum also needs to re-measure the canvas.
  useEffect(() => {
    function onFullscreenChange() {
      if (!document.fullscreenElement) setImmersive(false);
      viewer.current?.resize();
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  // The CSS immersive fallback changes layout without a window resize, so the
  // renderer has to re-measure after the browser has painted the new size.
  useEffect(() => {
    const frame = requestAnimationFrame(() => viewer.current?.resize());
    return () => cancelAnimationFrame(frame);
  }, [immersive]);

  useEffect(() => {
    if (failure) return;

    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
      ) {
        return;
      }
      const instance = viewer.current;
      if (!instance) return;

      const key = event.key;
      const repeated = event.repeat;
      let handled = true;
      switch (key) {
        case 'ArrowLeft':
          instance.setYaw(instance.getYaw() - YAW_STEP, 0);
          break;
        case 'ArrowRight':
          instance.setYaw(instance.getYaw() + YAW_STEP, 0);
          break;
        case 'ArrowUp':
          instance.setPitch(instance.getPitch() + PITCH_STEP, 0);
          break;
        case 'ArrowDown':
          instance.setPitch(instance.getPitch() - PITCH_STEP, 0);
          break;
        case '+':
        case '=':
        case 'Add':
          instance.setHfov(Math.max(MIN_HFOV, instance.getHfov() * ZOOM_STEP), 0);
          break;
        case '-':
        case '_':
        case 'Subtract':
          instance.setHfov(Math.min(MAX_HFOV, instance.getHfov() / ZOOM_STEP), 0);
          break;
        case 'f':
        case 'F':
          if (!repeated) void toggleImmersive();
          break;
        case '[':
        case ']': {
          if (repeated) {
            handled = false;
            break;
          }
          const goPrevious = key === '[';
          if (goPrevious ? canPrevious : canNext) {
            (goPrevious ? onPrevious : onNext)?.();
          }
          break;
        }
        default:
          handled = false;
      }
      if (handled) event.preventDefault();
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [failure, canPrevious, canNext, onPrevious, onNext, immersive]);

  async function toggleImmersive(): Promise<void> {
    const element = wrap.current;
    if (!element) return;
    if (immersive) {
      if (document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {
          /* the document already left fullscreen */
        }
      }
      setImmersive(false);
      return;
    }
    if (element.requestFullscreen) {
      try {
        await element.requestFullscreen();
        setImmersive(true);
        return;
      } catch {
        /* iOS Safari has no element fullscreen; use the fixed-position mode. */
      }
    }
    setImmersive(true);
  }

  function zoomIn() {
    const instance = viewer.current;
    if (instance) instance.setHfov(Math.max(MIN_HFOV, instance.getHfov() * ZOOM_STEP), 120);
  }

  function zoomOut() {
    const instance = viewer.current;
    if (instance) instance.setHfov(Math.min(MAX_HFOV, instance.getHfov() / ZOOM_STEP), 120);
  }

  function retry() {
    setFailure(null);
    setAttempt((value) => value + 1);
  }

  function resetView() {
    viewer.current?.lookAt(config.orientation.pitch, config.orientation.yaw, 100, true);
  }

  function saveView() {
    const instance = viewer.current;
    if (!instance || !onSaveView) return;
    onSaveView({ yaw: instance.getYaw(), pitch: instance.getPitch(), roll: config.orientation.roll });
  }

  function toggleMotion() {
    const instance = viewer.current;
    if (!instance) return;
    if (instance.isOrientationActive()) instance.stopOrientation();
    else instance.startOrientation();
  }

  const copy = failure ? FAILURE_COPY[failure] : null;

  return (
    <div class={immersive ? 'pano-wrap immersive' : 'pano-wrap'} ref={wrap}>
      {copy ? (
        <div class="notice pano-failure" aria-live="polite">
          <h3>{copy.title}</h3>
          <p>{copy.detail}</p>
          <div class="pano-failure-actions">
            <button class="button small" type="button" onClick={retry}>
              Try interactive view again
            </button>
            <button class="button ghost small" type="button" onClick={onFallback}>
              Show flat preview
            </button>
          </div>
        </div>
      ) : null}
      {/* The host stays mounted so a retry rebuilds the same viewer container. */}
      <div class="pano-host" ref={host} role="application" aria-label="Interactive 360 degree panorama" />
      {failure ? null : (
        <>
          {onPrevious ? (
            <button
              class="pano-arrow prev"
              type="button"
              aria-label="Previous item"
              disabled={!canPrevious}
              onClick={onPrevious}
            >
              ‹
            </button>
          ) : null}
          {onNext ? (
            <button class="pano-arrow next" type="button" aria-label="Next item" disabled={!canNext} onClick={onNext}>
              ›
            </button>
          ) : null}
          <p class="pano-hint">
            Drag or arrow keys to look · pinch or +/− to zoom · [ and ] change item · F for immersive
          </p>
          <div class="pano-tools">
            <button class="button small" type="button" aria-label="Zoom out" onClick={zoomOut}>
              −
            </button>
            <button class="button small" type="button" aria-label="Zoom in" onClick={zoomIn}>
              +
            </button>
            <button class="button small" type="button" aria-pressed={immersive} onClick={() => void toggleImmersive()}>
              {immersive ? 'Exit immersive' : 'Immersive'}
            </button>
            <button class="button small" type="button" onClick={resetView}>
              Reset view
            </button>
            {orientationSupported ? (
              <button class="button small" type="button" onClick={toggleMotion}>
                Motion
              </button>
            ) : null}
            {onSaveView ? (
              <button class="button small" type="button" onClick={saveView}>
                Set start view
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
