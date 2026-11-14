// Captures README screenshots from a running `vite preview` (port 4173) using the fake camera fixture.
const { chromium, devices } = require('playwright');
const path = require('node:path');
(async () => {
  const out = path.resolve(__dirname, '../docs/screenshots');
  const y4m = path.resolve(__dirname, '../tests/fixtures/table.y4m');
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`] });
  // Practice (phone portrait).
  {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto('http://localhost:4173/?mode=practice');
    await page.waitForTimeout(400);
    const pos = await page.evaluate(() => { const h = window.__cuesight; return { b: h.practiceToScreen(h.state.practice.balls.find((b) => b.id === 'b1').pos), p: h.practiceToScreen(h.state.table.pockets.find((p) => p.id === 'TR').mouthCenter) }; });
    await page.mouse.click(pos.b.x, pos.b.y);
    await page.mouse.click(pos.p.x, pos.p.y);
    await page.waitForFunction(() => window.__cuesight.state.recommended && !window.__cuesight.state.recommended.pending, null, { timeout: 15000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/practice-phone.jpg`, type: 'jpeg', quality: 82 });
    await page.locator('.panel').evaluate((el) => el.scrollTo(0, 9999));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${out}/practice-stroke.jpg`, type: 'jpeg', quality: 82 });
    await ctx.close();
  }
  // Camera (phone landscape).
  {
    const ctx = await browser.newContext({ ...devices['Pixel 7 landscape'], deviceScaleFactor: 2, permissions: ['camera'] });
    const page = await ctx.newPage();
    await page.goto('http://localhost:4173/?mode=camera');
    await page.waitForFunction(() => window.__cuesight.state.vision?.status === 'locked', null, { timeout: 20000 });
    const t = await page.evaluate(() => {
      const h = window.__cuesight;
      const balls = h.state.vision.balls;
      const b = balls.find((x) => x.label.startsWith('blue')) ?? balls.find((x) => x.kind !== 'cue');
      return h.overlayToScreen(b.pos);
    });
    await page.mouse.click(t.x, t.y);
    await page.waitForFunction(() => window.__cuesight.state.recommended && !window.__cuesight.state.recommended.pending, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/camera-landscape.jpg`, type: 'jpeg', quality: 82 });
    await ctx.close();
  }
  await browser.close();
})();
