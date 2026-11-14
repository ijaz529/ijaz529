/**
 * Icon set and iOS packaging checks (spec 002 T150, FR-131/FR-132, SC-115). Pure file checks: parses each PNG's
 * IHDR for exact size and colour type (2 = RGB, no alpha; 6 = RGBA) and validates the manifest and the
 * iOS asset catalog / Info.plist essentials. Regenerate the PNGs with `npm run icons`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function ihdr(path: string): { width: number; height: number; bitDepth: number; colorType: number } {
  const b = readFileSync(path);
  expect([...b.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(b.toString('ascii', 12, 16)).toBe('IHDR');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bitDepth: b[24]!, colorType: b[25]! };
}

const ICONS: { file: string; size: number; alpha: boolean }[] = [
  { file: 'public/icons/favicon-32.png', size: 32, alpha: true },
  { file: 'public/icons/icon-180.png', size: 180, alpha: false },
  { file: 'public/icons/icon-192.png', size: 192, alpha: true },
  { file: 'public/icons/icon-512.png', size: 512, alpha: true },
  { file: 'public/icons/icon-maskable-512.png', size: 512, alpha: false },
  { file: 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png', size: 1024, alpha: false },
];

describe('app icons', () => {
  it('has the vector master', () => {
    const svg = readFileSync('public/icon.svg', 'utf8');
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    expect(svg).toContain('id="art"'); // scripts/make-icons.cjs scales this group for the maskable variant
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // no external references (offline, Constitution V)
  });

  for (const icon of ICONS) {
    it(`${icon.file} is ${icon.size}×${icon.size} ${icon.alpha ? 'RGBA' : 'RGB without alpha'}`, () => {
      const h = ihdr(icon.file);
      expect(h).toEqual({ width: icon.size, height: icon.size, bitDepth: 8, colorType: icon.alpha ? 6 : 2 });
    });
  }

  it('the launch-screen images are opaque 2732×2732', () => {
    for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
      expect(ihdr(`ios/App/App/Assets.xcassets/Splash.imageset/${f}`)).toMatchObject({ width: 2732, height: 2732, colorType: 2 });
    }
  });

  it('the iOS asset catalog references the single 1024 px universal icon', () => {
    const c = JSON.parse(readFileSync('ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json', 'utf8')) as {
      images: { filename: string; idiom: string; platform: string; size: string }[];
    };
    expect(c.images).toEqual([{ filename: 'AppIcon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }]);
  });
});

describe('web app manifest', () => {
  const m = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as {
    short_name: string; display: string; theme_color: string; background_color: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };
  it('uses the brand colours and standalone display', () => {
    expect(m.short_name).toBe('CueSight');
    expect(m.display).toBe('standalone');
    expect(m.theme_color).toBe('#070B14');
    expect(m.background_color).toBe('#070B14');
  });
  it('lists PNG icons that exist, with any and maskable purposes', () => {
    for (const i of m.icons) {
      expect(existsSync(`public/${i.src}`)).toBe(true);
      const [w] = i.sizes.split('x').map(Number);
      expect(ihdr(`public/${i.src}`).width).toBe(w);
    }
    expect(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
    expect(m.icons.some((i) => i.purpose === 'any' && i.sizes === '192x192')).toBe(true);
  });
  it('the service worker precaches every manifest icon', () => {
    const sw = readFileSync('public/sw.js', 'utf8');
    for (const i of m.icons) expect(sw).toContain(`./${i.src}`);
  });
});

describe('iOS project', () => {
  const plist = readFileSync('ios/App/App/Info.plist', 'utf8');
  const value = (key: string): string | null => {
    const r = new RegExp(`<key>${key}</key>\\s*<(string|true|false)\\s*/?>([^<]*)`).exec(plist);
    return r ? (r[1] === 'string' ? r[2]!.trim() : r[1]!) : null;
  };
  it('declares the camera and photo-library purposes in plain language', () => {
    expect(value('NSCameraUsageDescription')).toMatch(/never leave your phone/);
    expect(value('NSPhotoLibraryUsageDescription')).toMatch(/never leave your phone/);
  });
  it('is named CueSight, exempt from export encryption and not full-screen-only', () => {
    expect(value('CFBundleDisplayName')).toBe('CueSight');
    expect(value('ITSAppUsesNonExemptEncryption')).toBe('false');
    expect(value('UIRequiresFullScreen')).toBe('false');
  });
  it('targets iOS 16 and wires the custom bridge view controller', () => {
    const pbx = readFileSync('ios/App/App.xcodeproj/project.pbxproj', 'utf8');
    expect(pbx.match(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)!.every((l) => l.includes('16.0'))).toBe(true);
    expect(pbx).toContain('CueSightViewController.swift in Sources');
    expect(readFileSync('ios/App/App/SceneDelegate.swift', 'utf8')).toContain('CueSightViewController()');
  });
  it('pins Capacitor exactly to 8.6.0 as dev dependencies only', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: object; devDependencies: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
    for (const p of ['@capacitor/cli', '@capacitor/core', '@capacitor/ios']) expect(pkg.devDependencies[p]).toBe('8.6.0');
  });
});
