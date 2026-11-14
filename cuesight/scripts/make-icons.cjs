#!/usr/bin/env node
/**
 * CueSight icon pipeline (spec 002, US3/US4, research R-31).
 *
 *   node scripts/make-icons.cjs            (npm run icons)
 *   node scripts/make-icons.cjs --preview  (also writes docs/screenshots/icon-preview.png)
 *
 * Rasterises the vector master public/icon.svg with the pre-installed Playwright Chromium (the
 * reference SVG renderer for the PWA anyway): the SVG is drawn into a <canvas> at the target size
 * (super-sampled, then box-filtered down in Node), the pixels come back with getImageData, and an
 * in-house PNG encoder writes them. No new dependencies.
 *
 * Outputs (all committed):
 *   public/icons/favicon-32.png              32   RGBA  small-size variant, rounded tile
 *   public/icons/icon-180.png               180   RGB   apple-touch-icon (iOS masks it itself)
 *   public/icons/icon-192.png               192   RGBA  manifest "any", rounded tile
 *   public/icons/icon-512.png               512   RGBA  manifest "any", rounded tile
 *   public/icons/icon-maskable-512.png      512   RGB   manifest "maskable": artwork inside the 80 % safe circle
 *   ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png   1024  RGB (App Store rejects alpha)
 *   ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732{,-1,-2}.png  2732  RGB launch screen
 *
 * "RGB" outputs are composited onto the brand background #070B14 and written as PNG colour type 2,
 * so they have no alpha channel at all; the script re-reads every IHDR to verify it.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const MASTER = path.join(ROOT, 'public/icon.svg');
const BG = [0x07, 0x0b, 0x14]; // --bg #070B14
const SPLASH = ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'].map(
  (f) => `ios/App/App/Assets.xcassets/Splash.imageset/${f}`,
);

/**
 * variant: full | maskable (artwork scaled into the safe zone) | small (no fine detail, bolder strokes).
 * texture: keep the felt weave (only worth its bytes on the 1024 px App Store icon).
 */
const OUTPUTS = [
  { file: 'public/icons/favicon-32.png', size: 32, variant: 'small', shape: 'squircle', alpha: true },
  { file: 'public/icons/icon-180.png', size: 180, variant: 'full', shape: 'square', alpha: false },
  { file: 'public/icons/icon-192.png', size: 192, variant: 'full', shape: 'squircle', alpha: true },
  { file: 'public/icons/icon-512.png', size: 512, variant: 'full', shape: 'squircle', alpha: true },
  { file: 'public/icons/icon-maskable-512.png', size: 512, variant: 'maskable', shape: 'square', alpha: false },
  { file: 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png', size: 1024, variant: 'full', shape: 'square', alpha: false, texture: true },
];

// ---------------------------------------------------------------------------------------------
// PNG encoder (colour type 2 = RGB or 6 = RGBA, 8 bit), adaptive per-row filters.
// ---------------------------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
/** pixels: Uint8Array of w*h*ch samples. ch 3 -> colour type 2, ch 4 -> colour type 6. */
function encodePng(pixels, w, h, ch) {
  const stride = w * ch;
  const out = Buffer.alloc((stride + 1) * h);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  const zero = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : zero;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const o = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? row[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[i] - pred) & 0xff;
        o[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = ch === 3 ? 2 : 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(out, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** Reads width, height, bit depth and colour type from a PNG's IHDR. */
function readIhdr(buf) {
  if (buf.readUInt32BE(12) !== 0x49484452) throw new Error('not a PNG IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
}

// ---------------------------------------------------------------------------------------------
// Pixel helpers (Node side).
// ---------------------------------------------------------------------------------------------
/** Box-filter an RGBA image down by an integer factor, in premultiplied alpha. */
function downsample(rgba, n, k) {
  if (k === 1) return rgba;
  const m = n / k;
  const out = new Uint8Array(m * m * 4);
  const kk = k * k;
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < m; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < k; j++) {
        let i = ((y * k + j) * n + x * k) * 4;
        for (let q = 0; q < k; q++, i += 4) {
          const al = rgba[i + 3];
          r += rgba[i] * al; g += rgba[i + 1] * al; b += rgba[i + 2] * al; a += al;
        }
      }
      const o = (y * m + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / kk);
    }
  }
  return out;
}
/** Composite RGBA over the brand background and drop the alpha channel. */
function flatten(rgba, bg = BG) {
  const px = rgba.length / 4;
  const out = new Uint8Array(px * 3);
  for (let p = 0; p < px; p++) {
    const a = rgba[p * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) out[p * 3 + c] = Math.round(rgba[p * 4 + c] * a + bg[c] * (1 - a));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Browser side: draw the (variant-adjusted) SVG into a canvas and return the raw pixels.
// ---------------------------------------------------------------------------------------------
/* eslint-disable no-undef */
async function browserRaster({ svgText, size, variant, shape, splash, texture }) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  if (variant === 'maskable') {
    // Maskable safe zone = centred circle of radius 0.4 * size. Shrink the artwork (not the
    // background) so every important pixel lands well inside it.
    doc.getElementById('art').setAttribute('transform', 'translate(512 512) scale(0.8) translate(-512 -512)');
  }
  svg.setAttribute('class', [variant === 'small' ? 'small' : '', texture ? '' : 'flat'].join(' ').trim());
  const N = splash ? 2732 : size;
  const tile = splash ? 1024 : size;
  svg.setAttribute('width', String(tile));
  svg.setAttribute('height', String(tile));
  const xml = new XMLSerializer().serializeToString(doc);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = N;
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  /** iOS-like continuous-corner tile: a superellipse |x|^5 + |y|^5 = 1. */
  const squircle = (cx, cy, half) => {
    g.beginPath();
    const steps = 720, e = 2 / 5;
    for (let s = 0; s <= steps; s++) {
      const t = (s / steps) * Math.PI * 2;
      const c = Math.cos(t), si = Math.sin(t);
      const x = cx + half * Math.sign(c) * Math.pow(Math.abs(c), e);
      const y = cy + half * Math.sign(si) * Math.pow(Math.abs(si), e);
      if (s === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  };
  if (splash) {
    // Launch screen: the brand background, a faint felt glow, and the icon tile centred.
    g.fillStyle = '#070B14';
    g.fillRect(0, 0, N, N);
    // A tight glow keeps the flat background flat (small PNG) while lifting the tile.
    const glow = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N * 0.2);
    glow.addColorStop(0, 'rgba(24,163,116,0.20)');
    glow.addColorStop(0.55, 'rgba(14,107,79,0.07)');
    glow.addColorStop(1, 'rgba(14,107,79,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, N, N);
    const T = 560, x0 = (N - T) / 2, y0 = (N - T) / 2;
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.6)';
    g.shadowBlur = 90;
    g.shadowOffsetY = 34;
    squircle(N / 2, N / 2, T / 2);
    g.fillStyle = '#0A3D35';
    g.fill();
    g.restore();
    g.save();
    squircle(N / 2, N / 2, T / 2);
    g.clip();
    g.drawImage(img, x0, y0, T, T);
    g.restore();
    // hairline rim, like a glass tile edge
    g.save();
    squircle(N / 2, N / 2, T / 2 - 1.5);
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 3;
    g.stroke();
    g.restore();
  } else {
    if (shape === 'squircle') {
      squircle(N / 2, N / 2, N / 2);
      g.clip();
    }
    g.drawImage(img, 0, 0, N, N);
  }
  const data = g.getImageData(0, 0, N, N).data;
  // Return as base64 in slices (large strings are fine, but keep the btoa input bounded).
  const parts = [];
  const STEP = 3 * 1024 * 1024;
  for (let i = 0; i < data.length; i += STEP) {
    const sub = data.subarray(i, Math.min(data.length, i + STEP));
    let bin = '';
    for (let j = 0; j < sub.length; j += 0x8000) bin += String.fromCharCode.apply(null, sub.subarray(j, j + 0x8000));
    parts.push(btoa(bin));
  }
  return { n: N, parts };
}
/* eslint-enable no-undef */

async function render(page, svgText, opts) {
  const ss = opts.splash ? 1 : Math.max(1, Math.min(4, Math.floor(2048 / opts.size)));
  const { n, parts } = await page.evaluate(browserRaster, { ...opts, size: opts.size * ss, svgText });
  const rgba = new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p, 'base64'))));
  return { rgba: downsample(rgba, n, ss), size: n / ss };
}

function write(file, buf) {
  const abs = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
}

async function preview(browser) {
  // A fake home screen showing the icon at 1024, 180, 60 and 29 px (documentation only).
  const uri = (f) => 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, f)).toString('base64');
  const big = uri('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png');
  const page = await browser.newPage({ viewport: { width: 1760, height: 1104 }, deviceScaleFactor: 1 });
  const tile = (px, src) =>
    `<div style="width:${px}px;height:${px}px;border-radius:${px * 0.2237}px;overflow:hidden;box-shadow:0 ${px * 0.04}px ${px * 0.12}px rgba(0,0,0,.45)"><img src="${src}" width="${px}" height="${px}" style="display:block"></div>`;
  const dummy = (px, c) =>
    `<div style="width:${px}px;height:${px}px;border-radius:${px * 0.2237}px;background:${c};opacity:.9"></div>`;
  const label = 'font:500 13px -apple-system,system-ui,sans-serif;color:#F4F6FB;margin-top:7px;text-align:center';
  const cap = 'font:500 15px -apple-system,system-ui,sans-serif;color:#A9B3C7;margin-top:14px;text-align:center;font-variant-numeric:tabular-nums';
  await page.setContent(`<!doctype html><html><body style="margin:0;width:1760px;height:1104px;background:radial-gradient(120% 90% at 70% 0%,#1d3557 0%,#0c1322 45%,#070B14 100%);display:flex;gap:64px;padding:40px;box-sizing:border-box">
    <div><div style="width:1024px;height:1024px;border-radius:229px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.55)"><img src="${big}" width="1024" height="1024" style="display:block"></div></div>
    <div style="display:flex;flex-direction:column;gap:56px;padding-top:24px">
      <div style="display:flex;flex-direction:column;align-items:center">${tile(180, big)}<div style="${cap}">180 px</div></div>
      <div style="display:grid;grid-template-columns:repeat(4,60px);gap:22px 28px;padding:22px;border-radius:28px;background:rgba(255,255,255,.06)">
        ${[dummy(60, '#3a4a6b'), tile(60, big), dummy(60, '#5b3d6e'), dummy(60, '#2f5d50')].map((t, i) => `<div style="display:flex;flex-direction:column;align-items:center">${t}<div style="${label}">${i === 1 ? 'CueSight' : '&nbsp;'}</div></div>`).join('')}
      </div>
      <div style="${cap};margin-top:-40px">60 px home screen</div>
      <div style="display:flex;align-items:center;gap:14px;padding:12px 16px;border-radius:14px;background:rgba(255,255,255,.07);width:300px">
        ${tile(29, big)}<div style="font:400 17px -apple-system,system-ui,sans-serif;color:#F4F6FB">CueSight</div>
      </div>
      <div style="${cap};margin-top:-40px">29 px settings</div>
    </div></body></html>`);
  await page.waitForTimeout(150);
  const out = path.join(ROOT, 'docs/screenshots/icon-preview.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, omitBackground: false });
  await page.close();
  console.log('wrote docs/screenshots/icon-preview.png');
}

async function main() {
  const svgText = fs.readFileSync(MASTER, 'utf8');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><html><body style="margin:0;background:#070B14"></body></html>');
    for (const o of OUTPUTS) {
      const { rgba, size } = await render(page, svgText, o);
      const png = o.alpha ? encodePng(rgba, size, size, 4) : encodePng(flatten(rgba), size, size, 3);
      write(o.file, png);
      const h = readIhdr(png);
      if (h.width !== o.size || h.height !== o.size || h.colorType !== (o.alpha ? 6 : 2)) throw new Error(`bad output ${o.file}`);
      console.log(`wrote ${o.file}  ${h.width}x${h.height}  ${o.alpha ? 'RGBA' : 'RGB (no alpha)'}  ${(png.length / 1024).toFixed(0)} KB`);
    }
    const { rgba } = await render(page, svgText, { size: 2732, variant: 'full', shape: 'square', splash: true });
    const splash = encodePng(flatten(rgba), 2732, 2732, 3);
    for (const f of SPLASH) write(f, splash);
    console.log(`wrote ${SPLASH.length} launch-screen images  2732x2732  RGB  ${(splash.length / 1024).toFixed(0)} KB each`);
    if (process.argv.includes('--preview')) await preview(browser);
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { encodePng, readIhdr };
