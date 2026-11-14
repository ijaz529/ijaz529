// Captures the README screenshots (docs/screenshots/) from a running build or dev server.
//   npx vite preview --port 4173 --strictPort &   # or: npx vite --port 4173
//   node scripts/screenshots.cjs                   # CUESIGHT_URL=http://localhost:5184 to use another server
// Uses the synthetic table video as the fake camera and the committed Snap photos (tests/fixtures).
const { chromium, devices } = require('playwright');
const path = require('node:path');

const BASE = (process.env.CUESIGHT_URL || 'http://localhost:4173').replace(/\/$/, '');
const out = path.resolve(__dirname, '../docs/screenshots');
const fx = path.resolve(__dirname, '../tests/fixtures');
const jpg = (page, name) => page.screenshot({ path: `${out}/${name}.jpg`, type: 'jpeg', quality: 82 });
const settled = (page) => page.waitForFunction(() => !window.__cuesight.view3d || !window.__cuesight.view3d.isAnimating || !window.__cuesight.view3d.isAnimating(), null, { timeout: 5000 });
const twoFrames = (page) =>
  page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(!window.__cuesight.view3d?.isAnimating?.())))), null, { timeout: 8000 });
/** Taps a ball, then the pocket, locating the pocket after the first tap (the table re-frames when the sheet or the Snap card grows). */
async function tapBallThenPocket(page, sel, pocketId) {
  const b = await page.evaluate((s) => {
    const h = window.__cuesight;
    const L = h.state.mode === 'snap' ? h.state.snap.layout : h.state.practice.balls;
    const ball = s.id ? L.find((x) => x.id === s.id) : L.reduce((a, c) => (Math.hypot(c.pos.x - s.near.x, c.pos.y - s.near.y) < Math.hypot(a.pos.x - s.near.x, a.pos.y - s.near.y) ? c : a));
    return { id: ball.id, at: h.practiceToScreen(ball.pos) };
  }, sel);
  await page.mouse.click(b.at.x, b.at.y);
  await page.waitForFunction((id) => window.__cuesight.state.targetId === id, b.id, { timeout: 8000 });
  // The table re-frames (animated) when the sheet or the Snap card grows: wait until the pocket is still.
  const at = () => page.evaluate((k) => window.__cuesight.practiceToScreen(window.__cuesight.state.table.pockets.find((p) => p.id === k).mouthCenter), pocketId);
  let q = await at();
  for (let i = 0; i < 60; i++) {
    await twoFrames(page);
    await page.waitForTimeout(150);
    const r = await at();
    if (Math.hypot(r.x - q.x, r.y - q.y) < 0.5) break;
    q = r;
  }
  await page.mouse.click(q.x, q.y);
  await page.waitForFunction((k) => window.__cuesight.state.pocketId === k, pocketId, { timeout: 8000 });
}
const recommended = (page) => page.waitForFunction(() => window.__cuesight.state.recommended && !window.__cuesight.state.recommended.pending, null, { timeout: 15000 });

(async () => {
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${fx}/table.y4m`,
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  });
  const phone = async (extra = {}) => {
    const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'], deviceScaleFactor: 2, ...extra });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('cuesight.onboarded', '1');
      } catch {}
    });
    return { ctx, page: await ctx.newPage() };
  };

  // Practice: the 3D table (overview, plan), the player's view, and the stroke controls.
  {
    const { ctx, page } = await phone();
    await page.goto(`${BASE}/?mode=practice`);
    await page.waitForTimeout(600);
    await settled(page);
    await tapBallThenPocket(page, { id: 'b1' }, 'TR');
    await recommended(page);
    await page.waitForTimeout(500);
    await jpg(page, 'practice-phone');
    await page.evaluate(() => window.__cuesight.setCamera('player'));
    await page.waitForTimeout(1200);
    await jpg(page, 'practice-player-view');
    await page.evaluate(() => window.__cuesight.setCamera('broadcast'));
    await page.waitForTimeout(1200);
    await jpg(page, 'practice-broadcast');
    await page.getByRole('button', { name: 'Expand shot details' }).click();
    await page.waitForTimeout(300);
    await page.locator('#sheet-body').evaluate((el) => el.scrollTo(0, 9999));
    await page.waitForTimeout(300);
    await jpg(page, 'practice-stroke');
    await ctx.close();
  }

  // Snap: the table photo → layout and plan → the player's photo with the guide.
  {
    const { ctx, page } = await phone();
    await page.goto(`${BASE}/?mode=snap`);
    await page.waitForTimeout(600);
    await jpg(page, 'snap-intro');
    await page.setInputFiles('#snap-file-table', `${fx}/snap-overview.png`);
    await page.waitForFunction(() => window.__cuesight.state.snap.step === 'review', null, { timeout: 30000 });
    await page.waitForTimeout(800);
    await settled(page);
    await tapBallThenPocket(page, { near: { x: 0.3, y: 0.15 } }, 'TR');
    await recommended(page);
    await page.waitForTimeout(600);
    await jpg(page, 'snap-table');
    await page.setInputFiles('#snap-file-player', `${fx}/snap-player.png`);
    await page.waitForFunction(() => window.__cuesight.state.snap.step === 'guide', null, { timeout: 30000 });
    await page.waitForTimeout(700);
    await jpg(page, 'snap-guide');
    await ctx.close();
  }

  // Live camera (phone landscape).
  {
    const ctx = await browser.newContext({ ...devices['Pixel 7 landscape'], deviceScaleFactor: 2, permissions: ['camera'] });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('cuesight.onboarded', '1');
      } catch {}
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/?mode=camera`);
    await page.waitForFunction(() => window.__cuesight.state.vision?.status === 'locked', null, { timeout: 20000 });
    const t = await page.evaluate(() => {
      const h = window.__cuesight;
      const balls = h.state.vision.balls;
      const b = balls.find((x) => x.label.startsWith('blue')) ?? balls.find((x) => x.kind !== 'cue');
      return h.overlayToScreen(b.pos);
    });
    await page.mouse.click(t.x, t.y);
    await recommended(page).catch(() => {});
    await page.waitForTimeout(500);
    await jpg(page, 'camera-landscape');
    await ctx.close();
  }
  await browser.close();
})();
