/**
 * Image header reading for Snap photos (pure, no DOM): the stored size of a JPEG or PNG and a JPEG's
 * EXIF orientation, read by the app itself so a portrait photo comes out upright whether or not the
 * platform's decoder (or its createImageBitmap options) honours the tag, and so the photo can be
 * decoded straight to the processing size (spec edge cases "Photo orientation" and "Very large photos").
 *
 * Orientation values are the EXIF/TIFF ones: 1 upright, 2 mirrored, 3 rotated 180°, 4 flipped,
 * 5 transposed, 6 needs 90° clockwise to view, 7 transverse, 8 needs 90° counter-clockwise to view.
 */

export interface ImageInfo {
  kind: 'jpeg' | 'png';
  /** Stored size in pixels (0 when the header was cut before the size). */
  width: number;
  height: number;
  /** EXIF orientation (1–8; 1 when absent). */
  orientation: number;
  /** Byte offset of the orientation value (a 16-bit integer), or null without an EXIF tag. */
  orientationAt: number | null;
  littleEndian: boolean;
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Reads the header of a JPEG or PNG (the first few hundred KB are enough); null for other formats. */
export function imageInfo(b: Uint8Array): ImageInfo | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const u32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
    return { kind: 'png', width: u32(16), height: u32(20), orientation: 1, orientationAt: null, littleEndian: false };
  }
  if (b.length < 3 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const info: ImageInfo = { kind: 'jpeg', width: 0, height: 0, orientation: 1, orientationAt: null, littleEndian: false };
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const m = b[i + 1]!;
    if (m === 0xff) {
      i++; // fill byte
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2; // markers without a length
      continue;
    }
    if (m === 0xd9 || m === 0xda) break; // end of image, start of scan: no header after this
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2) break;
    const start = i + 4;
    if (m === 0xe1 && info.orientationAt === null) readExif(b, start, Math.min(b.length, i + 2 + len), info);
    else if (SOF.has(m) && start + 5 <= b.length) {
      info.height = (b[start + 1]! << 8) | b[start + 2]!;
      info.width = (b[start + 3]! << 8) | b[start + 4]!;
      break;
    }
    i += 2 + len;
  }
  return info;
}

/** APP1 payload: "Exif\0\0" then a TIFF header and IFD0; picks out tag 0x0112 (Orientation, SHORT). */
function readExif(b: Uint8Array, start: number, end: number, info: ImageInfo): void {
  if (end - start < 14 || b[start] !== 0x45 || b[start + 1] !== 0x78 || b[start + 2] !== 0x69 || b[start + 3] !== 0x66 || b[start + 4] !== 0 || b[start + 5] !== 0) return;
  const t = start + 6;
  const le = b[t] === 0x49 && b[t + 1] === 0x49;
  if (!le && !(b[t] === 0x4d && b[t + 1] === 0x4d)) return;
  const u16 = (i: number) => (le ? b[i]! | (b[i + 1]! << 8) : (b[i]! << 8) | b[i + 1]!);
  const u32 = (i: number) => (le ? (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0 : ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0);
  if (u16(t + 2) !== 42) return;
  const ifd = t + u32(t + 4);
  if (ifd + 2 > end) return;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + 12 * k;
    if (e + 12 > end) return;
    if (u16(e) !== 0x0112) continue;
    if (u16(e + 2) !== 3) return; // must be a SHORT
    const o = u16(e + 8);
    info.littleEndian = le;
    info.orientationAt = e + 8;
    info.orientation = o >= 1 && o <= 8 ? o : 1;
    return;
  }
}

/** A copy of `b` with the EXIF orientation value set to `o` (the header must have one: info.orientationAt). */
export function withOrientation(b: Uint8Array, info: Pick<ImageInfo, 'orientationAt' | 'littleEndian'>, o: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(b);
  const at = info.orientationAt;
  if (at === null || at + 2 > out.length) return out;
  out[at] = info.littleEndian ? o & 255 : (o >> 8) & 255;
  out[at + 1] = info.littleEndian ? (o >> 8) & 255 : o & 255;
  return out;
}

/** A JPEG with an EXIF block carrying orientation `o` inserted after its start marker (for tests and fixtures). */
export function jpegWithOrientation(jpeg: Uint8Array, o: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, o & 255, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const len = payload.length + 2;
  const out = new Uint8Array(jpeg.length + 2 + len);
  out.set(jpeg.subarray(0, 2), 0);
  out.set([0xff, 0xe1, len >> 8, len & 255, ...payload], 2);
  out.set(jpeg.subarray(2), 6 + payload.length);
  return out;
}

/** Display size of a stored w×h image under orientation `o`. */
export function orientedSize(w: number, h: number, o: number): { width: number; height: number } {
  return o >= 5 && o <= 8 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * Canvas transform [a, b, c, d, e, f] (as for setTransform) that draws a stored image of size w×h,
 * placed at (0, 0), upright into a canvas of orientedSize(w, h, o).
 */
export function orientationTransform(o: number, w: number, h: number): [number, number, number, number, number, number] {
  switch (o) {
    case 2:
      return [-1, 0, 0, 1, w, 0];
    case 3:
      return [-1, 0, 0, -1, w, h];
    case 4:
      return [1, 0, 0, -1, 0, h];
    case 5:
      return [0, 1, 1, 0, 0, 0];
    case 6:
      return [0, 1, -1, 0, h, 0];
    case 7:
      return [0, -1, -1, 0, h, w];
    case 8:
      return [0, -1, 1, 0, 0, w];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}
