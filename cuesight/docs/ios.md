# CueSight on iOS: build, Simulator, TestFlight

The iOS app is a thin [Capacitor 8](https://capacitorjs.com) shell around the same offline web app that
ships as the PWA. There are no Capacitor plugins and no network calls: the bundled `dist/` is served from
`capacitor://localhost` (a secure context, so the camera and Web Workers work), and every frame stays on
the phone (Constitution V). Capacitor is a **dev** dependency only (`@capacitor/cli`, `core`, `ios`, pinned to
`8.6.0`); the web bundle keeps zero runtime npm dependencies. The native side links the Capacitor Swift
package (`capacitor-swift-pm` 8.6.0) through Swift Package Manager; there is no CocoaPods.

| Item | Value |
|---|---|
| Bundle ID | `com.cuesight.app` (override: `IOS_BUNDLE_ID` in CI, `CUESIGHT_APP_ID` for `cap sync`, or Xcode) |
| Display name | CueSight |
| Minimum iOS | 16.0 (iPhone and iPad, all orientations, iPad multitasking allowed) |
| Version | `MARKETING_VERSION` = `package.json` version; build number = CI run number `.` attempt |
| Permissions | Camera ("CueSight uses the camera to see the table and guide your shot. Frames never leave your phone."), Photo library (choosing a table photo) |
| Export compliance | `ITSAppUsesNonExemptEncryption = NO` (no prompt in App Store Connect) |
| Privacy manifest | `ios/App/App/PrivacyInfo.xcprivacy`: no tracking, no data collected |

## Build and run on a Mac

Requirements: macOS with **Xcode 26** or newer (Capacitor 8's Swift package is built with it, and App Store
Connect requires a current SDK), Node 22.

```bash
cd cuesight
npm ci
npm run cap:sync          # vite build && cap sync ios  -> copies dist/ into ios/App/App/public
npm run ios:open          # or: open ios/App/App.xcodeproj
```

In Xcode pick an iPhone simulator and press Run. To run on your own iPhone, select the **App** target →
Signing & Capabilities → choose your Team (and a unique bundle ID if `com.cuesight.app` is taken), plug the
phone in and Run. Re-run `npm run cap:sync` after every web change.

App icon and launch screen come from `public/icon.svg`; regenerate every PNG (PWA icons, `AppIcon-1024.png`,
launch-screen images, and `docs/screenshots/icon-preview.png` with `--preview`) with:

```bash
npm run icons             # node scripts/make-icons.cjs (headless Chromium, no extra dependencies)
```

### What is committed in `ios/`

`ios/` was generated with `npx cap add ios --packagemanager SPM` (this works on Linux too; it needs no
Xcode) and then customised:

- `App/App/CueSightViewController.swift`: a `CAPBridgeViewController` subclass. It keeps camera video inline
  (`allowsInlineMediaPlayback`, no user action required for playback) and answers WebKit's media-capture
  permission request for the app's own origin only, so the only camera prompt is the system one. Debug builds
  also accept a launch argument `-CueSightStartQuery "mode=practice"` that starts the web app with that query
  string (the Simulator job uses it to screenshot each mode). `SceneDelegate.swift` and `Main.storyboard`
  use this class.
- `App/App/Info.plist`: display name, camera and photo-library purpose strings, all orientations,
  `UIRequiresFullScreen = NO`, light status bar, dark appearance, `ITSAppUsesNonExemptEncryption = NO`,
  `arm64` device capability.
- `App/App.xcodeproj`: deployment target iOS 16.0, a shared `App` scheme, the new Swift file and privacy
  manifest.
- `App/App/Assets.xcassets`: `AppIcon-1024.png` (single-size universal icon, RGB without alpha as the App
  Store requires) and the dark launch-screen images; `LaunchScreen.storyboard` uses `#070B14`.
- `ExportOptions.plist`: App Store Connect export with `destination = upload`; CI fills in the team ID.

`cap sync` regenerates, and git ignores, `App/App/public/`, `App/App/capacitor.config.json`,
`App/App/config.xml` and `capacitor-cordova-ios-plugins/`. Build output goes to `build/` (ignored).

The web app needs no service worker inside the app: `capacitor://` pages cannot use one, and the assets are
already bundled. `src/app/main.ts` should therefore register `sw.js` only when
`window.Capacitor?.isNativePlatform?.()` is not true and the page is served over http(s).

## The Simulator smoke test

`bash scripts/ios-sim-smoke.sh` (after `npm run cap:sync`) does what CI does, on your Mac:

1. picks an available iPhone simulator on the newest iOS runtime (or uses `SIM_UDID`);
2. `xcodebuild ... -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build`;
3. boots it (dark appearance, 9:41 status bar), installs, grants photo-library access;
4. launches with the console attached and waits for Capacitor's `Loading app at capacitor://localhost` and
   the web app's `[CueSight] ready` log line;
5. screenshots the launch, the home screen, every `[CueSight] tour <step>` (web build with
   `VITE_CUESIGHT_TOUR=1`), then relaunches with `?mode=practice` and `?mode=snap` and screenshots those;
6. fails on a build or install error, a crash, a web bundle that does not load, or a blank screen; a missing
   `ready` marker is a warning.

Everything lands in `build/sim/` (`*.png`, `console-*.log`, `xcodebuild.log`, `summary.md`).

## CI: `.github/workflows/cuesight-ios.yml`

The workflow lives at the **git root** (the app is in `cuesight/`). It runs on pushes to `main` and
`claude/**` that touch `cuesight/**`, and on demand (Actions → **CueSight iOS** → Run workflow).

| Job | Runner | What it does |
|---|---|---|
| `web` | ubuntu | `npm ci`, typecheck, Vitest, `vite build`, gzip sizes in the run summary |
| `chromium-e2e` | ubuntu | the Playwright suite with Chromium and the synthetic fake camera |
| `ios-simulator` | macos-15 | newest Xcode, tour web build, `cap sync`, `scripts/ios-sim-smoke.sh`; artifact **ios-simulator-screenshots** |
| `webkit-e2e` | macos-15 | `playwright.webkit.config.ts`: the e2e suite in WebKit with the iPhone 15 profile (the live fake-camera spec is Chromium-only and skipped) |
| `testflight` | macos-15 | after `web` and `ios-simulator`: archive + upload, only when the secrets below exist; otherwise a notice and a green, skipped job |

The Xcode version is the newest one installed on the runner; pin one with the repository variable
`XCODE_VERSION` (for example `26.1`). Superseded runs on the same branch are cancelled.

## TestFlight: one-time setup

1. **Apple Developer Program**: enrol (or use your organisation's team). Note the **Team ID**
   (developer.apple.com → Account → Membership details).
2. **Register the bundle ID**: developer.apple.com → Certificates, IDs & Profiles → Identifiers → **+** →
   App IDs → App → Bundle ID *Explicit*, e.g. `com.cuesight.app` (or your own reverse-DNS ID). No extra
   capabilities are needed.
3. **Create the app record**: App Store Connect → Apps → **+** → New App → platform iOS, name "CueSight"
   (or any available name), primary language, the bundle ID from step 2, a SKU such as `cuesight-ios`.
4. **Create an API key**: App Store Connect → Users and Access → **Integrations** → App Store Connect API →
   Team Keys → **+**. Name it "CueSight CI" and give it the **App Manager** role. Download
   `AuthKey_<KEYID>.p8` (only possible once) and note the **Key ID** and the **Issuer ID** shown above the
   key list. If the first upload fails with a cloud-signing or certificate permission error, the key needs
   the **Admin** role so Xcode can create the cloud-managed distribution certificate on a fresh runner.
5. **Add the GitHub secrets and variables**: repository → Settings → Secrets and variables → Actions.
   - Secrets:
     - `APP_STORE_CONNECT_KEY_ID`: the Key ID
     - `APP_STORE_CONNECT_ISSUER_ID`: the Issuer ID
     - `APP_STORE_CONNECT_KEY_P8`: the `.p8` file, either pasted as-is (the `-----BEGIN PRIVATE KEY-----`
       text) or base64: `base64 -i AuthKey_<KEYID>.p8 | pbcopy` (macOS) / `base64 -w0 AuthKey_<KEYID>.p8` (Linux)
     - `APPLE_TEAM_ID`: the Team ID (may also be a repository *variable*)
   - Variables (optional): `IOS_BUNDLE_ID` if you registered something other than `com.cuesight.app`;
     `XCODE_VERSION` to pin Xcode.
6. **Run it**: push to `main` or a `claude/**` branch, or Actions → CueSight iOS → **Run workflow** (keep
   "Upload the build to TestFlight" ticked). The `testflight` job builds the release web bundle, runs
   `scripts/ios-testflight.sh` (`xcodebuild archive` with automatic signing through the API key, then
   `xcodebuild -exportArchive` with `ios/ExportOptions.plist`, which uploads to App Store Connect) and writes
   the version and build number to the run summary.
7. **Testers**: after Apple's processing (usually 5–30 minutes; you get an email) the build appears under
   App Store Connect → your app → **TestFlight**. Add yourself to an internal testing group and install it
   with the TestFlight app. Export compliance is pre-answered by the Info.plist.

Every push uploads a new build (build numbers are `<run number>.<attempt>`, always increasing). To upload
only on demand, untick the box when dispatching and remove `'claude/**'` from the `push` branches, or delete
the secrets.

You can also upload from your Mac: `npm run cap:sync`, then
`ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_P8="$(cat AuthKey_….p8)" APPLE_TEAM_ID=… bash scripts/ios-testflight.sh`
(`UPLOAD=0` exports a signed `.ipa` to `build/export` instead).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No profiles for '<bundle id>' were found` | The bundle ID is not registered, differs from `IOS_BUNDLE_ID`, or the key's role is too low (try Admin) |
| `Cloud signing permission error` | Give the API key the Admin role (it must be allowed to create the distribution certificate) |
| `The bundle version must be higher than the previously uploaded version` | A local upload used a lower number; set `BUILD_NUMBER` higher than the last CI run |
| `Invalid Pre-Release Train` / version closed | Bump `version` in `package.json` (the marketing version) after a version is released |
| `module compiled with Swift … cannot be imported` | The runner picked an Xcode older than 26; set the variable `XCODE_VERSION` |
| Simulator job: `Loading app at` never logged | `cap sync` did not run or `dist/` is empty; check the build step and `console-default.log` |
| Simulator job: warning about the `ready` marker | The web app did not log `[CueSight] ready`; open the screenshots and `console-*.log` |

## Limitations

- **No camera in the Simulator.** Live mode cannot be exercised there: use Practice, or Snap with photos from
  the library (drag a photo onto the Simulator window to add it to Photos). The smoke test screenshots
  Practice and Snap for this reason.
- **The camera inside WKWebView needs a real device.** Test Live and the Snap "take photo" path on an iPhone
  (Xcode Run or TestFlight). Expect the system camera prompt once; if denied, the app explains and offers
  Practice.
- WebKit e2e in CI uses Playwright's WebKit build, which is close to but not identical to the WKWebView in a
  given iOS release.
- TestFlight upload needs a paid Apple Developer membership and the secrets above; without them the job is
  skipped, never failed.
