/**
 * Rear-camera capture with backpressured, downscaled frame grabs (Principle IV). Frames stay in
 * memory and are only ever transferred to the on-device vision worker (Principle V).
 */
/** The part of a `<video>` element the camera code uses (a fake one in unit tests). */
export interface VideoSink {
  srcObject: MediaProvider | null;
  muted: boolean;
  playsInline: boolean;
  play(): Promise<void>;
}
export type GetUserMedia = () => Promise<MediaStream>;

/** The rear camera, asked for once per start. Throws `InsecureContext` where the API is missing. */
export const requestRearCamera: GetUserMedia = () => {
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(Object.assign(new Error('insecure'), { name: 'InsecureContext' }));
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
};

function stopTracks(s: MediaProvider | null | undefined): void {
  (s as MediaStream | null | undefined)?.getTracks?.().forEach((t) => t.stop());
}

/**
 * Shows `stream` in `video`. The stream it replaces is stopped first; when `play()` fails, `stream`
 * is stopped and detached before the error is rethrown, so a failed start never leaves a live camera.
 */
async function attach(video: VideoSink, stream: MediaStream): Promise<MediaStream> {
  if (video.srcObject && video.srcObject !== stream) stopTracks(video.srcObject);
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
  } catch (e) {
    stopTracks(stream);
    if (video.srcObject === stream) video.srcObject = null;
    throw e;
  }
  return stream;
}

export async function startCamera(video: VideoSink, gum: GetUserMedia = requestRearCamera): Promise<MediaStream> {
  return attach(video, await gum());
}

export function stopCamera(video: VideoSink): void {
  stopTracks(video.srcObject);
  video.srcObject = null;
}

export type CameraStart = { kind: 'started'; stream: MediaStream } | { kind: 'stale' } | { kind: 'error'; error: unknown };

/**
 * One camera for Live mode, safe against overlapping starts and stops (Live → Practice → Live while
 * the permission prompt or the sensor is still starting, a double "Try again"):
 *  - a start while another is in flight returns that same start (one `getUserMedia` call);
 *  - `stop()` invalidates every start in flight: a stream that arrives later is stopped at once and
 *    the start resolves `stale` (as does the AbortError of an interrupted `play()`), never `error`.
 */
export function createCameraSession(video: VideoSink, gum: GetUserMedia = requestRearCamera) {
  let gen = 0;
  let starting: Promise<CameraStart> | null = null;
  let stream: MediaStream | null = null;
  const live = (s: MediaStream | null) => !!s && s.getVideoTracks().some((t) => t.readyState === 'live');

  function stop(): void {
    gen++;
    starting = null;
    stopTracks(stream);
    stream = null;
    stopCamera(video);
  }

  function start(): Promise<CameraStart> {
    if (starting) return starting;
    if (stream && live(stream) && video.srcObject === stream) return Promise.resolve({ kind: 'started', stream });
    if (stream) stop();
    const g = ++gen;
    const run = (async (): Promise<CameraStart> => {
      try {
        const s = await gum();
        if (g !== gen) {
          stopTracks(s);
          return { kind: 'stale' };
        }
        await attach(video, s);
        if (g !== gen) {
          stopTracks(s);
          if (video.srcObject === s) video.srcObject = null;
          return { kind: 'stale' };
        }
        stream = s;
        return { kind: 'started', stream: s };
      } catch (error) {
        return g === gen ? { kind: 'error', error } : { kind: 'stale' };
      }
    })();
    starting = run;
    void run.then(() => {
      if (starting === run) starting = null;
    });
    return run;
  }

  return {
    start,
    stop,
    /** A started stream that is still capturing. */
    active: () => live(stream),
    stream: () => stream,
  };
}
export type CameraSession = ReturnType<typeof createCameraSession>;

/** `native`: running inside the iOS app (Capacitor), where the switch is in the Settings app, not a browser. */
export function describeCameraError(e: unknown, native = false): string {
  const name = (e as { name?: string })?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Camera access was blocked. CueSight needs the camera to see the table — everything is processed on this device and never uploaded. ${native ? 'Open Settings › CueSight › Camera to allow it' : 'Allow camera access in your browser settings'}, or use the practice table.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device. You can still plan shots on the practice table.';
    case 'NotReadableError':
      return 'The camera is busy in another app. Close it and try again, or use the practice table.';
    case 'InsecureContext':
      return 'The camera only works over HTTPS (or localhost). Open CueSight from a secure address, or use the practice table.';
    default:
      return `Couldn't start the camera (${name || String(e)}). You can use the practice table meanwhile.`;
  }
}

/** Downscales video frames to at most `maxDim` px for processing. */
export class FrameGrabber {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  constructor(readonly maxDim = 640) {
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  }
  grab(video: HTMLVideoElement): { width: number; height: number; buffer: ArrayBuffer } | null {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const s = Math.min(1, this.maxDim / Math.max(vw, vh));
    const w = Math.round(vw * s);
    const h = Math.round(vh * s);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.ctx.drawImage(video, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h);
    return { width: w, height: h, buffer: img.data.buffer as ArrayBuffer };
  }
}
