# Quickstart & Validation Scenarios: 3D Table, Two-Photo Snap Guide, Polished UI and iOS App

All commands run in `cuesight/` (the git root is its parent) unless stated. They are written as
raw commands. `package.json` may add npm-script aliases for them.

## Run and test (web)

```bash
cd cuesight
npm ci                                    # Node ≥ 22 (required by @capacitor/cli 8.6.0)
npm run dev                               # http://localhost:5173  (?mode=practice | ?mode=snap | ?mode=camera)
npm run typecheck
npm test                                  # Vitest: 001 suites + render3d, player-view, still, snap session, icons
npm run fixtures                          # fake-camera .y4m (001)
npx tsx scripts/make-snap-fixtures.ts     # synthetic table + player photos (+ truth JSON) for Snap tests
node scripts/make-icons.cjs               # rasterise public/icon.svg → public/icons/*.png + iOS AppIcon-1024
npm run e2e                               # Playwright (Chromium phone, SwiftShader WebGL)
npm run build                             # production PWA into dist/
```

- **Force the 2D table**: `?renderer=2d`, or Settings → "3D table" off.
- **Headless WebGL2**: if a Chromium context reports no WebGL2, launch it with `--use-angle=swiftshader
  --enable-unsafe-swiftshader --ignore-gpu-blocklist` (already set in `playwright.config.ts`).
- **On a phone**: `npm run dev -- --host` over HTTPS or a LAN tunnel (camera access needs HTTPS).
  Snap works without a camera through the photo library or the bundled sample photos.

## Validation scenarios (map to spec acceptance criteria)

| # | Scenario | How to verify | Spec ref |
|---|---|---|---|
| Q101 | 3D table renders | `?mode=practice` on a WebGL2 browser. Rails, weave, pockets, diamonds, numbered glossy balls and soft shadows appear in Overview within 2 s | US1-AS1, FR-101/102 |
| Q102 | Orbit, zoom, pan, presets | Drag cloth → orbit, the preset chip reads "Custom". Pinch or wheel → zoom. Two fingers → pan. Double-tap → back. Overview / Player view / Broadcast buttons fly the camera (they jump with reduced motion) | US1-AS2/4, FR-103/104 |
| Q103 | Same plan in 3D | *30° cut* drill → tap the ball, then pocket TR. The card shows `30.0°` and "½-ball hit", as with `?renderer=2d` | US1-AS3, SC-104 |
| Q104 | Cue stick | With a plan → Player view. The cue sits behind the cue ball, its tip moves with the spin pad and the gap grows with power | US1-AS4, FR-107 |
| Q105 | Play shot | *Play shot*: the balls run the paths, the numbers roll without skidding, the object ball drops, the replay ends ≤ 4 s and the layout restores. A tap skips it | US1-AS5, FR-108, SC-103 |
| Q106 | Drag in 3D | Drag a ball onto another ball: it stays clear and inside the cushions, and the plan updates | US1-AS6 |
| Q107 | Position and heatmap in 3D | Position → tap a spot; Zones → pick the next ball. The landing marker and heatmap appear on the cloth | US1-AS7 |
| Q108 | 2D fallback | `?renderer=2d`, or a browser with WebGL2 disabled: the 2D table with every feature, and the note "3D table isn't available on this device" | US1-AS8, FR-110 |
| Q109 | Snap, table photo | `?mode=snap` → *Choose photo* → `tests/fixtures/snap-table.png` (or *Try sample photos*). The outline, the balls and the cue mark appear within 3 s → Confirm | US2-AS1, FR-111/112 |
| Q110 | Edit layout, tap corners | Drag a ball, remove one, mark the cue ball. On a photo with a corner cut off → *Tap corners* → 4 taps → layout found | US2-AS2/3, FR-113 |
| Q111 | Plan + prompt | Tap the target (and a pocket). The card shows the plan, and the prompt asks for the table-level player photo | US2-AS4, FR-114/115 |
| Q112 | Player photo guide | Choose `tests/fixtures/snap-player.png`. Within 2 s the photo shows the aim line, ghost ball, object path to the pocket, the strike dot with the miscue ring and "½ tip low…", the cue-ball inset, power `n/10` + word + meter, and the confidence | US2-AS5, FR-116/117 |
| Q113 | Manual fallback | Choose `tests/fixtures/snap-player-hard.png` (one ball visible). The reason is shown → tap the cue ball, then the target → the guide is drawn with a capped confidence | US2-AS6, FR-118 |
| Q114 | Re-plan on the same photo | Change the pocket or spin. The guide redraws without a new photo. Take another player photo → it fits against the same layout | US2-AS7/8, FR-120 |
| Q115 | Partial visibility | `snap-player-cut.png` (cue ball cut by the bottom edge). The strike-point-off-photo message appears and the strike point shows on the spin ball | FR-119 |
| Q116 | Privacy | DevTools Network during a whole Snap session: 0 requests. After *Start over*, no photo remains (and none is in storage) | US2-AS9, FR-122, SC-114 |
| Q117 | Design system | Every mode: dark tokens, glass panels, system font, "Live · Snap · Practice" control | US3-AS1, FR-124/125 |
| Q118 | Sheet / panel | A 390 × 844 portrait viewport: the peek shows target → pocket, cut, power and spin; drag it up to expand. At 844 × 390 landscape, or ≥ 900 px: a side panel | US3-AS2, FR-126 |
| Q119 | Shot card visuals | Big cut and power numerals, the overlap glyph, the 10-segment gauge with a min-power tick, the shaded spin ball. A screen reader reads the text equivalents | US3-AS3, FR-127 |
| Q120 | Onboarding, motion | First load (clean storage) shows the hint once. With reduced motion on, sheet, mode and camera changes are instant | US3-AS4/5, FR-128/129 |
| Q121 | Accessibility | `tests/e2e/ui.spec.ts`: every button ≥ 44 × 44, focus ring visible on Tab, contrast ≥ 4.5:1 for body text | FR-130, SC-111 |
| Q122 | Icons and splash | `public/icons/*` exist at their exact sizes (`npm test` → `icons.test.ts`). Add to the home screen: the crisp icon. Load on slow 3G: the branded splash | US3-AS6, FR-131, SC-115 |
| Q123 | 001 regression | `npm run e2e`: `virtual.spec.ts` and `camera.spec.ts` pass unchanged | US3-AS7 |
| Q124 | iOS Simulator | See below. The app launches, logs `[CueSight] ready` and the screenshots show Practice 3D and Snap | US4-AS1, FR-134 |
| Q125 | WebKit iPhone e2e | `npx playwright test --project=webkit-iphone` on macOS | US4-AS2, FR-135 |
| Q126 | TestFlight | See below. With secrets, the build appears in App Store Connect → TestFlight. Without them, a notice and a green run | US4-AS3/4, FR-136 |
| Q127 | iOS permissions, offline | On a device: the first Live or Snap camera use shows the plain-language camera alert, and Deny → Practice. Airplane mode: everything works | US4-AS5/6, FR-132/133 |

## iOS Simulator: run it locally (macOS with Xcode 26)

```bash
cd cuesight
npm ci
VITE_CUESIGHT_TOUR=1 npx vite build       # tour build: steps through Practice → presets → Snap samples
npx cap sync ios                          # copies dist/ into ios/App/App/public
UDID=$(xcrun simctl list devices available -j | node -e '
  const d=JSON.parse(require("fs").readFileSync(0)).devices;
  const rts=Object.keys(d).filter(k=>k.includes("iOS")).sort().reverse();
  for (const r of rts){const x=d[r].find(v=>v.name.startsWith("iPhone")); if(x){console.log(x.udid);break;}}')
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination "id=$UDID" -derivedDataPath build/ios \
  CODE_SIGNING_ALLOWED=NO build
xcrun simctl boot "$UDID"; xcrun simctl bootstatus "$UDID" -b
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100
xcrun simctl install "$UDID" build/ios/Build/Products/Debug-iphonesimulator/App.app
BUNDLE_ID=$(node -p 'require("./capacitor.config.json").appId')
xcrun simctl launch --console-pty "$UDID" "$BUNDLE_ID" | tee sim.log &
# wait for "[CueSight] ready", then for each "[CueSight] tour <step>" marker:
xcrun simctl io "$UDID" screenshot shots/practice-overview.png
```

Or open the project in Xcode: `npx cap open ios`, pick an iPhone simulator and press Run. Without the
tour flag, the app starts in Practice on the Simulator (it has no camera).

## iOS Simulator job in CI

The workflow is `.github/workflows/ios.yml` at the **git root**, with `working-directory: cuesight`.
It runs on every push and pull request.

1. GitHub → **Actions** → **iOS** → the latest run (or **Run workflow** on a branch).
2. The `ios-simulator` job:
   - builds the tour build;
   - picks an available iPhone simulator;
   - installs and launches the app;
   - fails if `[CueSight] ready` is missing after 60 s;
   - saves `ios-screenshots` (one PNG per tour step) and `sim.log` as artifacts.
3. The `webkit-e2e` job runs Playwright WebKit with the iPhone profile and uploads the report on
   failure.

## TestFlight: configure the secrets (one time)

1. **Apple Developer Program** membership for the team. Note the **Team ID** (developer.apple.com →
   Membership).
2. **App record**: App Store Connect → Apps → **+** → New App. Platform iOS, name "CueSight", and the
   bundle ID you will use (for example `app.cuesight.ios`). If the bundle ID is not listed, register
   it first under developer.apple.com → Identifiers.
3. **API key**:
   1. App Store Connect → Users and Access → **Integrations** → App Store Connect API → **Team Keys** →
      **+**.
   2. Role **Admin**. This lets Xcode create a cloud-managed distribution certificate on a fresh
      runner. App Manager works only when signing assets already exist.
   3. Download `AuthKey_<KEYID>.p8`. It can be downloaded only once.
   4. Note the **Key ID** and the **Issuer ID**.
4. **GitHub**: repository → Settings → Secrets and variables → Actions.
   - **Secrets**:
     - `APP_STORE_CONNECT_KEY_ID`: the Key ID.
     - `APP_STORE_CONNECT_ISSUER_ID`: the Issuer ID.
     - `APP_STORE_CONNECT_KEY_P8`: the output of `base64 -i AuthKey_<KEYID>.p8` (macOS), or of
       `base64 -w0 AuthKey_<KEYID>.p8` (Linux).
     - `APPLE_TEAM_ID`: the Team ID.
   - **Variables**: `IOS_BUNDLE_ID`, exactly as registered.
5. **Upload**: push to `main`, or Actions → iOS → **Run workflow** with **upload = true**. The
   `testflight` job then:
   1. builds the release web bundle (no tour flag) and runs `cap sync`;
   2. runs `xcodebuild archive` with automatic signing through the API key, with build number
      `run_number` + `run_attempt`;
   3. runs `xcodebuild -exportArchive` with `ExportOptions.plist`
      (`method=app-store-connect`, `destination=upload`).
6. **Testers**: after Apple's processing (usually 5–30 min), the build appears under TestFlight.
   Export compliance is pre-answered (`ITSAppUsesNonExemptEncryption = NO`). Add internal testers.

**Without secrets**: the `testflight` job prints `TestFlight upload skipped — App Store Connect
secrets are not configured` and succeeds. Pull requests from forks never receive secrets.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No profiles for '<bundle id>' were found` | The bundle ID differs from `IOS_BUNDLE_ID`, or the API key role is too low. Check the variable and use an Admin key |
| `Cloud signing permission error` | The API key lacks the right to create cloud-managed certificates. Use the Admin role |
| `The bundle version must be higher` | A re-run reused a build number. The `run_attempt` suffix prevents this; check `CURRENT_PROJECT_VERSION` |
| The Simulator job times out waiting for `ready` | Open `sim.log`. A missing `⚡️  Loading app at …` line means `cap sync` didn't copy `dist/` |
| A 3D e2e test sees no WebGL2 | Check the SwiftShader flags in `playwright.config.ts`, then run with `?renderer=2d` to isolate the problem |
