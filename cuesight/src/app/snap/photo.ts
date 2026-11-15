/**
 * Snap photos (FR-111, FR-122): decode a picked or captured image into an in-memory canvas scaled to
 * the processing size, upright (EXIF orientation applied by the app, see exif.ts), and hand out
 * `Frame`s for the vision worker. Nothing is stored or uploaded; dropping the `Photo` releases the pixels.
 *
 * Memory (12–48 MP phone photos, iOS): the stored size is read from the header first, so the platform
 * decodes straight to the processing size (createImageBitmap resizeWidth/resizeHeight); where those
 * options are not supported, the full-size bitmap lives only until it is drawn, then it is closed.
 */
import type { Frame } from '../../vision/image';
import { imageInfo, orientationTransform, orientedSize, withOrientation, type ImageInfo } from './exif';
import type { PhotoSource } from './session';

/** Longest side of a processed photo (px). The still pipeline and the player-view fit are validated here. */
export const SNAP_MAX_DIM = 960;
/** Bytes read for the header: the EXIF block (at most 64 KB) and the frame header sit at the start. */
const HEAD_BYTES = 256 * 1024;

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

/**
 * Draws any image source into a new canvas at the processing size. `orientation` (EXIF 1–8) says how
 * the source's stored pixels must be turned to be upright; w×h is the source's (stored) size.
 */
export function photoFromSource(src: CanvasImageSource, w: number, h: number, source: PhotoSource, orientation = 1): Photo {
  const shown = orientedSize(w, h, orientation);
  const { width, height } = scaledSize(shown.width, shown.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Draw the stored image at the matching (unturned) size, turned upright by the transform.
  const sw = orientation >= 5 ? height : width;
  const sh = orientation >= 5 ? width : height;
  ctx.setTransform(...orientationTransform(orientation, sw, sh));
  ctx.drawImage(src, 0, 0, sw, sh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas, width, height, source };
}

/**
 * The size to ask the platform to decode at (stored orientation), or null to decode as is (small or
 * unknown size). A JPEG gets both sides (its orientation is the app's job, so the stored size is what
 * comes out); a PNG only the width, so the aspect ratio holds whatever the platform does.
 */
export function decodeTarget(info: ImageInfo | null): { resizeWidth: number; resizeHeight?: number } | null {
  if (!info || info.width <= 0 || info.height <= 0 || Math.max(info.width, info.height) <= SNAP_MAX_DIM) return null;
  const t = scaledSize(info.width, info.height);
  return info.kind === 'jpeg' ? { resizeWidth: t.width, resizeHeight: t.height } : { resizeWidth: t.width };
}

interface Decoded {
  src: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

const bitmap = (bmp: ImageBitmap): Decoded => ({ src: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() });

/**
 * Decodes with createImageBitmap at `target` where the platform supports the options, without them
 * where it rejects them (older Safari), and through an image element where there is no createImageBitmap.
 */
async function decodeImage(blob: Blob, target: ReturnType<typeof decodeTarget>, platformOrientation: boolean): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    const resize: ImageBitmapOptions = target ? { ...target, resizeQuality: 'high' } : {};
    const tries: ImageBitmapOptions[] = [];
    if (platformOrientation) tries.push({ ...resize, imageOrientation: 'from-image' });
    if (target) tries.push(resize);
    for (const opts of tries) {
      try {
        return bitmap(await createImageBitmap(blob, opts));
      } catch {
        /* options not supported here: try with fewer */
      }
    }
    try {
      return bitmap(await createImageBitmap(blob));
    } catch {
      /* fall back to an image element */
    }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return {
    src: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    release: () => {
      URL.revokeObjectURL(url);
      img.removeAttribute('src');
    },
  };
}

/** Decodes a file or blob into an upright, processing-size photo. */
export async function decodePhoto(blob: Blob, source: PhotoSource): Promise<Photo> {
  const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
  const info = imageInfo(head);
  const jpeg = info?.kind === 'jpeg';
  const o = jpeg ? info.orientation : 1;
  // JPEG: the orientation tag is set to 1 in what the platform decodes (so no decoder turns it, whatever
  // it supports), and the app turns the pixels itself. Only the header is copied; the rest is a slice.
  const src = jpeg && o !== 1 && info.orientationAt !== null ? new Blob([withOrientation(head, info, 1), blob.slice(head.byteLength)], { type: blob.type || 'image/jpeg' }) : blob;
  const d = await decodeImage(src, decodeTarget(info), !jpeg);
  try {
    return photoFromSource(d.src, d.width, d.height, source, o);
  } finally {
    d.release();
  }
}

/** Loads one of the bundled sample photos (FR-123); same-origin, works offline once cached. */
export async function loadSample(url: string): Promise<Photo> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sample ${res.status}`);
  return decodePhoto(await res.blob(), 'sample');
}

/**
 * Frees a photo's pixels at once (FR-122): a zero-size canvas drops its backing store, so a photo that is
 * discarded does not wait for garbage collection. The photo must not be drawn or framed afterwards.
 */
export function releasePhoto(p: Photo): void {
  p.canvas.width = 0;
  p.canvas.height = 0;
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
