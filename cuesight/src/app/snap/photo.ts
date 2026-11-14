/**
 * Snap photos (FR-111, FR-122): decode a picked or captured image into an in-memory canvas scaled to
 * the processing size, honouring the EXIF orientation, and hand out `Frame`s for the vision worker.
 * Nothing is stored or uploaded; dropping the `Photo` releases the pixels.
 */
import type { Frame } from '../../vision/image';
import type { PhotoSource } from './session';

/** Longest side of a processed photo (px). The still pipeline and the player-view fit are validated here. */
export const SNAP_MAX_DIM = 960;

export interface Photo {
  /** The scaled photo (also what the stage draws). */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  source: PhotoSource;
}

export function scaledSize(w: number, h: number, maxDim = SNAP_MAX_DIM): { width: number; height: number } {
  const s = Math.min(1, maxDim / Math.max(1, w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Draws any image source into a new canvas at the processing size. */
export function photoFromSource(src: CanvasImageSource, w: number, h: number, source: PhotoSource): Photo {
  const { width, height } = scaledSize(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, width, height);
  return { canvas, width, height, source };
}

/** Decodes a file or blob (EXIF orientation applied) into a processing-size photo. */
export async function decodePhoto(blob: Blob, source: PhotoSource): Promise<Photo> {
  if (typeof createImageBitmap === 'function') {
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      bmp = await createImageBitmap(blob);
    }
    try {
      return photoFromSource(bmp, bmp.width, bmp.height, source);
    } finally {
      bmp.close();
    }
  }
  // Fallback: an <img> (browsers apply the EXIF orientation to images by default).
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return photoFromSource(img, img.naturalWidth, img.naturalHeight, source);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Loads one of the bundled sample photos (FR-123); same-origin, works offline once cached. */
export async function loadSample(url: string): Promise<Photo> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sample ${res.status}`);
  return decodePhoto(await res.blob(), 'sample');
}

/** A fresh frame (copy of the pixels) for the vision worker; its buffer can be transferred. */
export function frameOf(p: Photo): Frame {
  const img = p.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, p.width, p.height);
  return { width: p.width, height: p.height, data: img.data };
}

/** Grabs the current video frame as a full-resolution photo. */
export function photoFromVideo(video: HTMLVideoElement): Photo | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  return photoFromSource(video, w, h, 'camera');
}
