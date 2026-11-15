# Quickstart & Validation Scenarios: 3D Table, Two-Photo Snap Guide, Polished UI and iOS App

All commands run in `cuesight/` (the git root is its parent) unless stated. **Revised 2026-11-15** to
match `fix2b/app`.

## Run and test (web)

```bash
cd cuesight
npm ci                                    # Node ≥ 22 (required by @capacitor/cli 8.6.0)
npm run dev                               # http://localhost:5173  (?mode=practice | ?mode=snap | ?mode=camera)
npm run typecheck
npm test                                  # Vitest: 001 suites + render3d, player-view, still, Snap, icons
npm run fixtures                          # fake-camera tests/fixtures/table.y4m + the Snap fixtures (snap-*.png, snap-layout.json)
npm run icons                             # rasterise public/icon.svg → public/icons/*.png + iOS AppIcon-1024
npm run e2e                               # fixtures + build + Playwright (Chromium: Pixel 7, iPhone SE, iPad)
npm run e2e:webkit                        # build + Playwright WebKit (iPhone 15; skips the live camera and offline specs)
npm run build                             # production PWA into dist/
```

- **Force the 2D table**: `?renderer=2d`, or Settings → "3D table" off.
- **Headless WebGL2**: Playwright's headless Chromium renders WebGL2 with SwiftShader, so
  `playwright.config.ts` sets no GPU flags. If a Chromium build reports no WebGL2, launch it with
  `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` (as
  `scripts/screenshots.cjs` does).
- **e2e without `npm run e2e`**: run `npm run fixtures` first. `tests/fixtures/table.y4m` is not
  committed, and without it `camera.spec.ts` and the Live focus test in `ui.spec.ts` fail at
  "Starting camera…".
- **On a phone**: `npm run dev -- --host` over HTTPS or a LAN tunnel (camera access needs HTTPS).
  Snap works without a camera through the photo library or the bundled sample photos.

### Testing notes (`fix2b/app`)

<!-- RELEASE: keep these counts in step with the README "Test status" line. -->
- e2e has **125 tests** on `fix2b/app`, all passing in the final full run (2 workers).
- `practice3d.spec.ts` runs at deviceScaleFactor 1 on the Chromium projects (SwiftShader is slow at a
  phone's pixel ratio); `webkit-iphone` keeps the iPhone 15's 3.
- "Play shot replays…" is measured in the page, after every drawn 3D frame (`gl.readPixels` against
  a still frame read the same way): the picture changes; the natural end comes under 8 s + 2 × the
  slowest frame + 1 s; and Skip (button and Escape) ends the replay within the input's own handling
  (< 1.5 s). A skip that lands after the natural end is retried at half speed.
- The presets and idle tests wait for a quiet planner and no toast: under load the device budget can
  make the recommendation `fragile`, and its toast would change the first picture and ask for a frame.
- Do not pin exact recommended strokes in e2e: the recommendation depends on the device's measured
  evaluation budget (241 against 187 evaluations were seen for the same request under load).
- `tests/e2e/wiring.spec.ts` (4 package-integration tests on chromium-phone) and
  `tests/unit/app/frozen-words.test.ts` (the frozen wording is the same in every view) guard the
  wave-2b integration. The Snap photo-label unit tests draw through the app's real photo-to-canvas
  mappings (contain ×1.25, zoomed onto `guideFocus`, ×5, and the fixture's player pose), never only
  the identity. `ui.spec.ts`'s frozen-advice test waits for the worker's full plan.
- Known load flake: practice3d "idle: no animation frames…" counted 1 frame on chromium-ipad in one
  full run at load 13; it passed alone and in every later full run. The presets, Play shot and
  blocked-drill tests are no longer flaky (35/35 with `--repeat-each 5` under load).

## Validation scenarios (map to spec acceptance criteria)

| # | Scenario | How to verify | Spec ref |
|---|---|---|---|
| Q101 | 3D table renders | `?mode=practice` on a WebGL2 browser. Rails, weave, pockets, diamonds, numbered glossy balls and soft shadows appear in the Top view within 2 s | US1-AS1, FR-101/102 |
| Q102 | Orbit, zoom, pan, presets | Drag cloth → orbit, the preset chip reads "Custom". Pinch or wheel → zoom. Two fingers → pan. Double-tap → back. The Top / Player / Orbit buttons fly the camera (they jump with reduced motion). In Player view the cue takes three slow practice strokes, then rests | US1-AS2/4, FR-103/104 |
| Q103 | Same plan in 3D | *30° cut* drill → tap the ball, then pocket TR. The card shows `30.0°` and "½-ball hit", as with `?renderer=2d` | US1-AS3, SC-104 |
| Q104 | Cue stick | With a plan → Player view. The cue sits behind the cue ball, its tip moves with the spin pad and the gap grows with power. With side spin it is posed along the cue's own (squirt-corrected) line | US1-AS4, FR-107 |
| Q105 | Play shot | *Play shot*: a 0.5 s strike, then the balls run the paths, the numbers roll without skidding, the object ball drops; the motion takes ≤ 4 s and the end position holds 3.5 s, then the layout restores. A tap, Skip or Escape ends it at once. ½× replays at half speed | US1-AS5, FR-108, SC-103 |
| Q106 | Drag in 3D | Drag a ball onto another ball: it stays clear and inside the cushions, and the plan updates | US1-AS6 |
| Q107 | Position and heatmap in 3D | Position → tap a spot; Zones → pick the next ball. The landing marker and heatmap appear on the cloth | US1-AS7 |
| Q108 | 2D fallback | `?renderer=2d`: the 2D table with every feature. A browser with WebGL2 disabled: the same, with the note "3D needs WebGL2, which this browser doesn’t offer — showing the 2D table."; a GPU context that cannot be restored: "The 3D table stopped working on this device — showing the 2D table." | US1-AS8, FR-110 |
| Q109 | Snap, table photo | `?mode=snap` → *Choose photo* → `tests/fixtures/snap-overview.png` (or *Try sample photos*, which loads `public/samples/snap-table.png`). The outline, the balls and the cue mark appear within 3 s | US2-AS1, FR-111/112 |
| Q110 | Edit layout, tap corners | Drag a ball, remove one, mark the cue ball. On a photo without the whole table: "The whole table must be in the photo — step back or turn the phone and retake it. All four corners already in view? Tap them." → *Tap corners* → 4 taps → layout found. Four taps that can't be a table are refused at once | US2-AS2/3, FR-111/113 |
| Q111 | Plan + prompt | Tap the target (and a pocket). The card shows the plan, and the prompt asks for the table-level player photo | US2-AS4, FR-114/115 |
| Q112 | Player photo guide | Choose `tests/fixtures/snap-player.png`. Within 2 s the photo shows the aim line, ghost ball, object path to the pocket, the strike dot with the miscue ring and the spin in words ("½ tip below centre"; 1 tip = ¼ R ≈ 7 mm, the card details give mm), the cue-ball inset, power `n/10` + word + meter, and the confidence | US2-AS5, FR-116/117 |
| Q113 | Manual fallback | Choose `tests/fixtures/snap-player-hard.png` (one ball visible). The reason is shown ("I can't see enough balls…": the photo shows fewer than three ball circles) → tap the cue ball, then the target → the guide is drawn with a capped confidence | US2-AS6, FR-118 |
| Q114 | Re-plan on the same photo | Change the pocket or spin: the guide redraws without a new photo. Change the target: the same photo is fitted again and the fit chip follows the new target (after a two-tap fit, tap again). Take another player photo → it fits against the same layout | US2-AS7/8, FR-116/120 |
| Q115 | Partial visibility | `snap-player-cut.png` (cue ball cut by the bottom edge). The strike-point-off-photo message appears and the strike point shows on the spin ball | FR-119 |
| Q116 | Privacy | DevTools Network during a whole Snap session: 0 requests. After *Start over*, no photo remains (and none is in storage). A photo still decoding when you leave Snap is dropped | US2-AS9, FR-122, SC-114 |
| Q117 | Design system | Every mode: dark tokens, glass panels, system font, "Live · Snap · Practice" control | US3-AS1, FR-124/125 |
| Q118 | Sheet / panel | A 390 × 844 portrait viewport: the peek shows target → pocket, cut, power and spin; drag it up to expand. A headline warning is clamped to 2 lines at the peek. At 844 × 390 landscape, or ≥ 900 px: a side panel | US3-AS2, FR-126 |
| Q119 | Shot card visuals | Big cut and power numerals, the overlap glyph, the 10-segment gauge with a min-power tick, the shaded spin ball. A screen reader reads the text equivalents | US3-AS3, FR-127 |
| Q120 | Onboarding, motion | First load (clean storage) shows the hint once. With reduced motion on, sheet, mode and camera changes are instant | US3-AS4/5, FR-128/129 |
| Q121 | Accessibility | `tests/e2e/ui.spec.ts`: hit areas ≥ 44 × 44 by `elementFromPoint` at 393×852 and 375×667, a focus ring visible on Tab, token contrast ≥ 4.5:1 for body text | FR-130, SC-111 |
| Q122 | Icons and splash | `public/icons/*` exist at their exact sizes (`npm test` → `icons.test.ts`). Add to the home screen: the crisp icon. Load on slow 3G: the branded splash | US3-AS6, FR-131, SC-115 |
| Q123 | 001 regression | `npm run e2e`: `virtual.spec.ts` and `camera.spec.ts` pass unchanged | US3-AS7 |
| Q124 | iOS Simulator | See below. The app launches, logs `[CueSight] ready` within `READY_TIMEOUT` (90 s) after every launch, and the screenshots show Practice 3D and Snap | US4-AS1, FR-134 |
| Q125 | WebKit iPhone e2e | `npm run e2e:webkit` (`playwright.webkit.config.ts`, project `webkit-iphone`) on macOS | US4-AS2, FR-135 |
| Q126 | TestFlight | See below. With secrets, a push to `main` (or a manual run with upload ticked) puts the build in App Store Connect → TestFlight. Without them, a notice and a green run | US4-AS3/4, FR-136 |
| Q127 | iOS permissions, offline | On a device (iOS 16+): the first Live or Snap camera use shows the plain-language camera alert, and Deny → Practice. Airplane mode: everything works | US4-AS5/6, FR-132/133 |
| Q128 | Power gauge | Practice, a long shot at power 2: the gauge marks the minimum, with a dashed arc "only just drops" ("Minimum X; from Y it only just drops"). Past full power it reads "Needs more than full power for pace". A frozen cue ball played too softly shows no minimum until the worker's advice arrives, and "No power gets it in with pace" when none works | FR-127 |
| Q129 | Frozen cue ball | Drag the cue ball against the object ball. The cut tile reads "Frozen · N° · stroke left/right" (never "0° · full-ball hit"); no ghost ball in 3D, the aim ribbon runs 10 cm past the object ball. In Snap the HUD reads "Frozen: stroke N° to the left/right of the line of centres". On snooker the 3D label reads "Not makeable · touching ball" / "Play away from it (a push is a foul)" | FR-117, FR-126 |

## iOS Simulator: run it locally (macOS with Xcode 26)

The script does what CI does (see [docs/ios.md](../../docs/ios.md)):

```bash
cd cuesight
npm ci
VITE_CUESIGHT_TOUR=1 npx vite build       # tour build: steps through Practice → presets → Snap samples
npx cap sync ios                          # copies dist/ into ios/App/App/public
bash scripts/ios-sim-smoke.sh             # picks a simulator, builds, installs, launches, screenshots; READY_TIMEOUT=90
```

It picks an available iPhone simulator on the newest iOS runtime (`SIM_UDID` overrides), builds with
`CODE_SIGNING_ALLOWED=NO`, boots it with a 9:41 status bar, installs, launches with the console
attached, waits for `[CueSight] ready` after each launch (default, `?mode=practice`, `?mode=snap`)
and writes the screenshots, `console-*.log` and `summary.md` to `build/sim/`. The bundle id is
`com.cuesight.app` unless you synced with `CUESIGHT_APP_ID`.

Or open the project in Xcode: `npx cap open ios`, pick an iPhone simulator and press Run. Without the
tour flag, the app starts in Practice on the Simulator (it has no camera).

## iOS Simulator job in CI

The workflow is `.github/workflows/cuesight-ios.yml` at the **git root**, with `working-directory:
cuesight`. It runs on pushes to `main` and `claude/**` and on pull requests into `main` (a pull
request from a `claude/**` branch of this repository is covered by that branch's push run), and by
hand.

1. GitHub → **Actions** → **CueSight iOS** → the latest run (or **Run workflow** on a branch).
2. The `ios-simulator` job:
   - builds the tour build and runs `cap sync`;
   - runs `scripts/ios-sim-smoke.sh`;
   - fails if `[CueSight] ready` is not logged within `READY_TIMEOUT` (90 s) after any launch (the
     first CI run reported ready after 22 s);
   - saves **ios-simulator-screenshots** (the screenshots, `console-*.log`, `xcodebuild.log` and
     `summary.md`) as an artifact.
3. The `webkit-e2e` job runs Playwright WebKit with the iPhone 15 profile and uploads the report on
   failure.

## TestFlight: configure the secrets (one time)

1. **Apple Developer Program** membership for the team. Note the **Team ID** (developer.apple.com →
   Membership).
2. **App record**: App Store Connect → Apps → **+** → New App. Platform iOS, name "CueSight", and the
   bundle ID you will use (default `com.cuesight.app`). If the bundle ID is not listed, register it
   first under developer.apple.com → Identifiers.
3. **API key**:
   1. App Store Connect → Users and Access → **Integrations** → App Store Connect API → **Team Keys** →
      **+**.
   2. Role **App Manager**. If the first upload fails with a cloud-signing or certificate permission
      error, use **Admin**, so Xcode can create a cloud-managed distribution certificate on a fresh
      runner.
   3. Download `AuthKey_<KEYID>.p8`. It can be downloaded only once.
   4. Note the **Key ID** and the **Issuer ID**.
4. **GitHub**: repository → Settings → Secrets and variables → Actions.
   - **Secrets**:
     - `APP_STORE_CONNECT_KEY_ID`: the Key ID.
     - `APP_STORE_CONNECT_ISSUER_ID`: the Issuer ID.
     - `APP_STORE_CONNECT_KEY_P8`: the `.p8` file as is, or the output of `base64 -i AuthKey_<KEYID>.p8`
       (macOS) or `base64 -w0 AuthKey_<KEYID>.p8` (Linux).
     - `APPLE_TEAM_ID`: the Team ID (may also be a variable).
   - **Variables** (optional): `IOS_BUNDLE_ID`, exactly as registered, if it is not
     `com.cuesight.app`; `XCODE_VERSION` to pin Xcode.
5. **Upload**: push to `main`, or Actions → CueSight iOS → **Run workflow** with "Upload the build to
   TestFlight" ticked (it is off by default). The `testflight` job runs only after `web`,
   `chromium-e2e`, `ios-simulator` and `webkit-e2e` pass, never for pull requests or other pushes,
   and an upload in progress is never cancelled. It then:
   1. builds the release web bundle (no tour flag) and runs `cap sync`;
   2. runs `scripts/ios-testflight.sh`: `xcodebuild archive` with automatic signing through the API
      key, with build number `<run number>.<run attempt>`;
   3. runs `xcodebuild -exportArchive` with `ExportOptions.plist`
      (`method=app-store-connect`, `destination=upload`).
6. **Testers**: after Apple's processing (usually 5–30 min), the build appears under TestFlight.
   Export compliance is pre-answered (`ITSAppUsesNonExemptEncryption = NO`). Add internal testers.

**Without secrets**: the `testflight` job prints "TestFlight upload skipped - App Store Connect secrets
are not configured (missing: …)" and succeeds. Pull requests from forks never receive secrets.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No profiles for '<bundle id>' were found` | The bundle ID differs from `IOS_BUNDLE_ID`, or the API key role is too low. Check the variable and use an Admin key |
| `Cloud signing permission error` | The API key lacks the right to create cloud-managed certificates. Use the Admin role |
| `The bundle version must be higher` | A local upload reused a build number. CI's `<run>.<attempt>` always increases; set `BUILD_NUMBER` higher for a local upload |
| The Simulator job fails waiting for `ready` | Open `console-*.log`. A missing `Loading app at …` line means `cap sync` didn't copy `dist/`; otherwise the web app did not finish its first render within `READY_TIMEOUT` |
| A 3D e2e test sees no WebGL2 | Run with `?renderer=2d` to isolate the problem, then try the SwiftShader flags above |
| `camera.spec.ts` stays at "Starting camera…" | Run `npm run fixtures` (the fake-camera `.y4m` is not committed) |
