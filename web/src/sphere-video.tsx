import { useEffect, useRef, useState } from 'preact/hooks';

type Props = {
  src: string;
  poster?: string;
  /** Resume position in seconds; applied once after metadata arrives. */
  startAt?: number | null;
  /** Position reports go through the viewer's throttled persistence. */
  onPosition?: (seconds: number, force?: boolean) => void;
  onEnded?: () => void;
  /** The parent falls back to a plain video element. */
  onFallback?: () => void;
};

type Failure = 'webgl' | 'context';

const DEG = Math.PI / 180;
/** Matches the photo viewer's zoom range so both stages feel the same. */
const MIN_HFOV = 50;
const MAX_HFOV = 110;
const MIN_PITCH = -85;
const MAX_PITCH = 85;
const KEY_YAW_STEP = 6;
const KEY_PITCH_STEP = 4;
const ZOOM_STEP = 0.85;
/** Roughly one screen height per 250 px of drag at the default field of view. */
const DRAG_RATE = 0.12;

const VERTEX_SHADER = `
attribute vec2 aPos;
varying vec2 vPos;
void main() {
  vPos = aPos;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/**
 * The quad is the screen; each fragment becomes a ray through the current
 * camera basis, and the ray's longitude/latitude sample the equirectangular
 * frame. That is the whole projection: no cube faces, no seams at the poles.
 */
const FRAGMENT_SHADER = `
precision mediump float;
varying vec2 vPos;
uniform sampler2D uVideo;
uniform vec3 uForward;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec2 uScale;
const float PI = 3.141592653589793;
void main() {
  vec3 dir = normalize(uForward + uRight * vPos.x * uScale.x + uUp * vPos.y * uScale.y);
  float lon = atan(dir.x, -dir.z);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
  gl_FragColor = texture2D(uVideo, uv);
}`;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Shader could not be created');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    throw new Error('Shader did not compile');
  }
  return shader;
}

/**
 * Spherical video stage. A hidden video element supplies frames; a WebGL quad
 * reprojects them as a sphere that can be dragged, pinched, wheel-zoomed and
 * keyboard-navigated. Playback stays explicit — nothing autoplays — and the
 * controls live inside the wrapper so immersive mode keeps them reachable.
 */
export default function SphereVideo({ src, poster, startAt, onPosition, onEnded, onFallback }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const view = useRef({ yaw: 0, pitch: 0, hfov: 100 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; hfov: number } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Bumping this rebuilds the renderer after a lost context or a retry.
  const [attempt, setAttempt] = useState(0);
  const [immersive, setImmersive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const element = canvas.current;
    const source = video.current;
    if (!element || !source) return;

    let gl: WebGLRenderingContext | null;
    try {
      gl = element.getContext('webgl', { alpha: false, antialias: true, powerPreference: 'high-performance' });
    } catch {
      gl = null;
    }
    if (!gl) {
      setFailure('webgl');
      return;
    }
    const context = gl;
    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    let texture: WebGLTexture | null = null;
    let frame = 0;
    let uploadedTime = -1;

    const onLost = (event: Event): void => {
      // Without preventDefault the browser cannot restore the context.
      event.preventDefault();
      setFailure('context');
    };
    const onRestored = (): void => setAttempt((value) => value + 1);
    element.addEventListener('webglcontextlost', onLost);
    element.addEventListener('webglcontextrestored', onRestored);

    try {
      const vertex = compileShader(context, context.VERTEX_SHADER, VERTEX_SHADER);
      const fragment = compileShader(context, context.FRAGMENT_SHADER, FRAGMENT_SHADER);
      program = context.createProgram();
      if (!program) throw new Error('Program could not be created');
      context.attachShader(program, vertex);
      context.attachShader(program, fragment);
      context.linkProgram(program);
      context.deleteShader(vertex);
      context.deleteShader(fragment);
      if (!context.getProgramParameter(program, context.LINK_STATUS)) {
        throw new Error('Program did not link');
      }

      buffer = context.createBuffer();
      context.bindBuffer(context.ARRAY_BUFFER, buffer);
      context.bufferData(
        context.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        context.STATIC_DRAW,
      );
      const position = context.getAttribLocation(program, 'aPos');
      context.enableVertexAttribArray(position);
      context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);

      texture = context.createTexture();
      context.bindTexture(context.TEXTURE_2D, texture);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, 0);
      context.useProgram(program);

      const uniforms = {
        video: context.getUniformLocation(program, 'uVideo'),
        forward: context.getUniformLocation(program, 'uForward'),
        right: context.getUniformLocation(program, 'uRight'),
        up: context.getUniformLocation(program, 'uUp'),
        scale: context.getUniformLocation(program, 'uScale'),
      };
      context.uniform1i(uniforms.video, 0);

      const resize = (): void => {
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        const width = Math.max(1, Math.round(element.clientWidth * ratio));
        const height = Math.max(1, Math.round(element.clientHeight * ratio));
        if (element.width !== width || element.height !== height) {
          element.width = width;
          element.height = height;
        }
        context.viewport(0, 0, element.width, element.height);
      };

      const draw = (): void => {
        if (source.readyState < 2 || source.videoWidth === 0) return;
        context.bindTexture(context.TEXTURE_2D, texture);
        // One upload per decoded frame, not per animation frame.
        if (source.currentTime !== uploadedTime) {
          context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, context.RGBA, context.UNSIGNED_BYTE, source);
          uploadedTime = source.currentTime;
        }
        const yaw = view.current.yaw * DEG;
        const pitch = view.current.pitch * DEG;
        const cosPitch = Math.cos(pitch);
        const sinPitch = Math.sin(pitch);
        const cosYaw = Math.cos(yaw);
        const sinYaw = Math.sin(yaw);
        const forwardX = sinYaw * cosPitch;
        const forwardY = sinPitch;
        const forwardZ = -cosYaw * cosPitch;
        // up = right × forward, so the horizon tilts correctly with pitch.
        const upX = -sinYaw * sinPitch;
        const upY = cosYaw * forwardX - sinYaw * forwardZ;
        const upZ = cosYaw * sinPitch;
        const aspect = element.width / Math.max(1, element.height);
        const tanHalf = Math.tan((view.current.hfov * DEG) / 2);
        context.uniform3f(uniforms.forward, forwardX, forwardY, forwardZ);
        context.uniform3f(uniforms.right, cosYaw, 0, sinYaw);
        context.uniform3f(uniforms.up, upX, upY, upZ);
        context.uniform2f(uniforms.scale, tanHalf, tanHalf / aspect);
        context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
      };

      const loop = (): void => {
        frame = requestAnimationFrame(loop);
        if (document.hidden) return;
        resize();
        draw();
      };
      loop();
    } catch {
      setFailure('webgl');
    }

    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('webglcontextlost', onLost);
      element.removeEventListener('webglcontextrestored', onRestored);
      if (texture) context.deleteTexture(texture);
      if (buffer) context.deleteBuffer(buffer);
      if (program) context.deleteProgram(program);
    };
  }, [attempt]);

  // Report the final position even when the stage unmounts mid-playback.
  useEffect(() => {
    return () => {
      const element = video.current;
      if (element && Number.isFinite(element.currentTime) && element.currentTime > 0) {
        onPosition?.(element.currentTime, true);
      }
    };
  }, [onPosition]);

  useEffect(() => {
    function onFullscreenChange(): void {
      if (!document.fullscreenElement) setImmersive(false);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

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

  function togglePlay(): void {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => {});
    else element.pause();
  }

  function toggleMute(): void {
    const element = video.current;
    if (!element) return;
    element.muted = !element.muted;
    setMuted(element.muted);
  }

  function seek(seconds: number): void {
    const element = video.current;
    if (!element || !Number.isFinite(seconds)) return;
    element.currentTime = seconds;
    setTime(seconds);
  }

  function pan(dx: number, dy: number): void {
    const scale = DRAG_RATE * (view.current.hfov / 100);
    view.current.yaw = ((view.current.yaw - dx * scale + 180) % 360) - 180;
    view.current.pitch = clamp(view.current.pitch + dy * scale, MIN_PITCH, MAX_PITCH);
  }

  function onPointerDown(event: PointerEvent): void {
    const element = event.currentTarget as HTMLCanvasElement;
    element.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pinch.current = null;
  }

  function onPointerMove(event: PointerEvent): void {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size >= 2) {
      const [first, second] = [...pointers.current.values()];
      if (!first || !second) return;
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      if (!pinch.current) {
        pinch.current = { distance, hfov: view.current.hfov };
        return;
      }
      if (pinch.current.distance > 0) {
        view.current.hfov = clamp(
          pinch.current.hfov * (pinch.current.distance / Math.max(1, distance)),
          MIN_HFOV,
          MAX_HFOV,
        );
      }
      return;
    }
    pan(event.clientX - previous.x, event.clientY - previous.y);
  }

  function endPointer(event: PointerEvent): void {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    view.current.hfov = clamp(view.current.hfov * factor, MIN_HFOV, MAX_HFOV);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'].includes(target.tagName))
      ) {
        return;
      }
      let handled = true;
      switch (event.key) {
        case 'ArrowLeft':
          view.current.yaw = ((view.current.yaw - KEY_YAW_STEP + 180) % 360) - 180;
          break;
        case 'ArrowRight':
          view.current.yaw = ((view.current.yaw + KEY_YAW_STEP + 180) % 360) - 180;
          break;
        case 'ArrowUp':
          view.current.pitch = clamp(view.current.pitch + KEY_PITCH_STEP, MIN_PITCH, MAX_PITCH);
          break;
        case 'ArrowDown':
          view.current.pitch = clamp(view.current.pitch - KEY_PITCH_STEP, MIN_PITCH, MAX_PITCH);
          break;
        case '+':
        case '=':
        case 'Add':
          view.current.hfov = Math.max(MIN_HFOV, view.current.hfov * ZOOM_STEP);
          break;
        case '-':
        case '_':
        case 'Subtract':
          view.current.hfov = Math.min(MAX_HFOV, view.current.hfov / ZOOM_STEP);
          break;
        case ' ':
          if (event.repeat) return;
          togglePlay();
          break;
        case 'f':
        case 'F':
          if (event.repeat) return;
          void toggleImmersive();
          break;
        default:
          handled = false;
      }
      if (handled) event.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const failureCopy =
    failure === 'context'
      ? {
          title: '360° video stopped',
          detail:
            'The browser released the graphics context, usually after a GPU reset or a long spell in the background. Try the spherical view again, or use the flat video.',
        }
      : {
          title: 'Spherical video unavailable',
          detail:
            'This browser could not create a WebGL context, so the video cannot be wrapped around a sphere. The flat video still plays.',
        };

  return (
    <div class={immersive ? 'sphere-wrap immersive' : 'sphere-wrap'} ref={wrap}>
      <canvas
        class="sphere-canvas"
        ref={canvas}
        role="application"
        aria-label="Interactive 360 degree video. Drag or use the arrow keys to look around."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onWheel={onWheel}
      />
      <video
        class="sphere-source"
        ref={video}
        src={src}
        poster={poster}
        preload="metadata"
        playsInline
        onLoadedMetadata={(event) => {
          const element = event.currentTarget as HTMLVideoElement;
          setDuration(element.duration);
          const saved = startAt ?? 0;
          // Do not drop the viewer seconds before the end; starting over is kinder.
          if (saved > 0 && Number.isFinite(element.duration) && saved < element.duration - 10) {
            element.currentTime = saved;
            setTime(saved);
          } else {
            // A paused video at time zero can still hold only a blank first
            // frame; a hair of a seek makes the browser decode frame one, so
            // the sphere is not black before the user presses Play.
            element.currentTime = 0.001;
          }
        }}
        onPlay={() => setPlaying(true)}
        onPause={(event) => {
          setPlaying(false);
          onPosition?.((event.currentTarget as HTMLVideoElement).currentTime, true);
        }}
        onTimeUpdate={(event) => {
          const element = event.currentTarget as HTMLVideoElement;
          setTime(element.currentTime);
          if (!element.paused) onPosition?.(element.currentTime);
        }}
        onEnded={() => onEnded?.()}
      />

      {failure ? (
        <div class="notice sphere-failure" aria-live="polite">
          <h3>{failureCopy.title}</h3>
          <p>{failureCopy.detail}</p>
          <div class="pano-failure-actions">
            <button
              class="button small"
              type="button"
              onClick={() => {
                setFailure(null);
                setAttempt((value) => value + 1);
              }}
            >
              Try spherical view again
            </button>
            {onFallback ? (
              <button class="button ghost small" type="button" onClick={onFallback}>
                Use flat video
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <p class="sphere-hint">Drag or arrow keys to look · pinch or wheel to zoom · space to play · F for immersive</p>

      <div class="sphere-controls">
        <button
          class="button small"
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          aria-pressed={playing}
          onClick={togglePlay}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <span class="sphere-time">{formatTime(time)}</span>
        <input
          class="sphere-seek"
          type="range"
          min="0"
          max={duration || 0}
          step="0.1"
          value={Math.min(time, duration || 0)}
          aria-label="Seek video"
          onInput={(event) => seek(Number((event.currentTarget as HTMLInputElement).value))}
        />
        <span class="sphere-time">{formatTime(duration)}</span>
        <button
          class="button small"
          type="button"
          aria-pressed={muted}
          aria-label={muted ? 'Unmute' : 'Mute'}
          onClick={toggleMute}
        >
          {muted ? 'Muted' : 'Sound'}
        </button>
        <button class="button small" type="button" aria-pressed={immersive} onClick={() => void toggleImmersive()}>
          {immersive ? 'Exit immersive' : 'Immersive'}
        </button>
      </div>
    </div>
  );
}
