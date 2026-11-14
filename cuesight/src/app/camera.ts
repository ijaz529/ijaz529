/**
 * Rear-camera capture with backpressured, downscaled frame grabs (Principle IV). Frames stay in
 * memory and are only ever transferred to the on-device vision worker (Principle V).
 */
export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return stream;
}

export function stopCamera(video: HTMLVideoElement): void {
  const s = video.srcObject as MediaStream | null;
  s?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

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
