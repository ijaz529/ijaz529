/**
 * Snap photo decoding (FR-111, spec edge cases "Photo orientation" and "Very large photos"): the JPEG
 * header is read by the app itself, so a portrait photo is upright whether or not the platform's
 * decoder honours the EXIF orientation tag (or the createImageBitmap options), and the decoded size is
 * known in advance so the platform can scale while decoding.
 */
import { describe, expect, it } from 'vitest';
import { imageInfo, jpegWithOrientation, orientationTransform, orientedSize, withOrientation } from '../../../src/app/snap/exif';
import { decodeTarget, scaledSize } from '../../../src/app/snap/photo';

/** A minimal JPEG header: SOI, optional APP0 (JFIF), SOF0 (w×h), SOS. Enough for a header parser. */
function jpeg(w: number, h: number, app0 = true): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  if (app0) out.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);
  out.push(0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
  out.push(0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0xd9);
  return Uint8Array.from(out);
}

/** The same with a little-endian ("II") EXIF block carrying a few IFD0 entries, orientation last. */
function jpegLittleEndian(w: number, h: number, o: number): Uint8Array {
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II, 42, IFD0 at 8
    0x03, 0x00, // 3 entries
    0x0f, 0x01, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x41, 0x42, 0x43, 0x00, // Make "ABC"
    0x1a, 0x01, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // XResolution (offset, unused)
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, o, 0x00, 0x00, 0x00, // Orientation
    0x00, 0x00, 0x00, 0x00,
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const len = payload.length + 2;
  const base = jpeg(w, h, false);
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...payload, ...base.slice(2)]);
}

describe('Snap photo header (orientation and size)', () => {
  it('reads the stored size, and orientation 1 when there is no EXIF block', () => {
    expect(imageInfo(jpeg(4032, 3024))).toMatchObject({ kind: 'jpeg', width: 4032, height: 3024, orientation: 1, orientationAt: null });
  });

  it('reads the EXIF orientation (big- and little-endian) and where its value sits', () => {
    for (let o = 1; o <= 8; o++) {
      const be = jpegWithOrientation(jpeg(4032, 3024), o);
      const a = imageInfo(be)!;
      expect(a).toMatchObject({ kind: 'jpeg', width: 4032, height: 3024, orientation: o });
      expect(a.orientationAt).not.toBeNull();
      const le = imageInfo(jpegLittleEndian(1200, 1600, o))!;
      expect(le).toMatchObject({ width: 1200, height: 1600, orientation: o, littleEndian: true });
    }
  });

  it('neutralises the tag in a copy (so no decoder rotates), leaving the rest of the bytes alone', () => {
    for (const bytes of [jpegWithOrientation(jpeg(800, 600), 6), jpegLittleEndian(800, 600, 8)]) {
      const info = imageInfo(bytes)!;
      const flat = withOrientation(bytes, info, 1);
      expect(imageInfo(flat)!.orientation).toBe(1);
      expect(imageInfo(bytes)!.orientation).not.toBe(1); // the original is untouched
      let diff = 0;
      for (let i = 0; i < bytes.length; i++) if (bytes[i] !== flat[i]) diff++;
      expect(diff).toBe(1);
    }
  });

  it('reads PNG dimensions; anything else is unknown (the platform decides)', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 3, 0xc0, 8, 6, 0, 0, 0]);
    expect(imageInfo(png)).toMatchObject({ kind: 'png', width: 1280, height: 960, orientation: 1 });
    expect(imageInfo(Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBeNull(); // HEIC 'ftyp'
    expect(imageInfo(Uint8Array.from([0xff, 0xd8, 0xff]))).toMatchObject({ kind: 'jpeg', width: 0, height: 0, orientation: 1 }); // truncated
  });

  it('every orientation maps the stored image upright into the display frame', () => {
    // Stored 4×2 image; where each stored corner must land on the display (EXIF/TIFF definitions).
    const w = 4;
    const h = 2;
    const corners = { tl: [0, 0], tr: [w, 0], bl: [0, h] } as const;
    const want: Record<number, Record<keyof typeof corners, [number, number]>> = {
      1: { tl: [0, 0], tr: [4, 0], bl: [0, 2] },
      2: { tl: [4, 0], tr: [0, 0], bl: [4, 2] }, // mirrored
      3: { tl: [4, 2], tr: [0, 2], bl: [4, 0] }, // 180°
      4: { tl: [0, 2], tr: [4, 2], bl: [0, 0] }, // flipped
      5: { tl: [0, 0], tr: [0, 4], bl: [2, 0] }, // transposed
      6: { tl: [2, 0], tr: [2, 4], bl: [0, 0] }, // rotate 90° clockwise to view
      7: { tl: [2, 4], tr: [2, 0], bl: [0, 4] }, // transverse
      8: { tl: [0, 4], tr: [0, 0], bl: [2, 4] }, // rotate 90° counter-clockwise to view
    };
    for (let o = 1; o <= 8; o++) {
      const [a, b, c, d, e, f] = orientationTransform(o, w, h);
      const size = orientedSize(w, h, o);
      expect(size).toEqual(o >= 5 ? { width: h, height: w } : { width: w, height: h });
      for (const [k, [x, y]] of Object.entries(corners)) {
        const q = [a * x + c * y + e, b * x + d * y + f];
        expect(q, `orientation ${o}, ${k}`).toEqual(want[o]![k as keyof typeof corners]);
      }
    }
  });

  it('decodes straight to the processing size: never a full-resolution copy when the size is known', () => {
    // A 48 MP portrait photo stored landscape (orientation 6): decoded at 960×720 stored, shown 720×960.
    const t = decodeTarget({ kind: 'jpeg', width: 8064, height: 6048, orientation: 6, orientationAt: 30, littleEndian: false })!;
    expect(t).toEqual({ resizeWidth: 960, resizeHeight: 720 });
    expect(orientedSize(t.resizeWidth, t.resizeHeight!, 6)).toEqual(scaledSize(6048, 8064));
    // Small photos are not scaled up; unknown sizes are left to the platform.
    expect(decodeTarget({ kind: 'jpeg', width: 640, height: 480, orientation: 1, orientationAt: null, littleEndian: false })).toBeNull();
    expect(decodeTarget(null)).toBeNull();
    // PNG (no orientation of ours): only the width, so the platform keeps the aspect whatever it does.
    expect(decodeTarget({ kind: 'png', width: 2560, height: 1920, orientation: 1, orientationAt: null, littleEndian: false })).toEqual({ resizeWidth: 960 });
  });
});
