/**
 * Capacitor 8 configuration for the CueSight iOS app (spec 002, US4).
 *
 * - The web bundle is the same offline PWA build (`vite build` -> dist/). No `server.url`: the app
 *   always runs the bundled assets from capacitor://localhost (a secure context, so getUserMedia and
 *   module workers work) and never loads anything from the network (Constitution V).
 * - No Capacitor plugins and no runtime import of @capacitor/core in app code (Constitution VII);
 *   the native bridge injects `window.Capacitor` and the app only feature-detects it.
 * - The bundle id defaults to com.cuesight.app. Override it at sync time with
 *   `CUESIGHT_APP_ID=com.example.cuesight npx cap sync ios`; CI overrides the Xcode setting
 *   PRODUCT_BUNDLE_IDENTIFIER with the repository variable IOS_BUNDLE_ID instead.
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: process.env.CUESIGHT_APP_ID || 'com.cuesight.app',
  appName: 'CueSight',
  webDir: 'dist',
  backgroundColor: '#070B14',
  loggingBehavior: 'debug',
  ios: {
    // NB: in Capacitor 8 `ios.scheme` is the *Xcode build scheme* used by `cap run/build`, which is
    // `App` in the generated project (CI also builds `-scheme App`). The name people see is
    // CFBundleDisplayName = "CueSight" in ios/App/App/Info.plist.
    scheme: 'App',
    // The web layer owns the safe areas (env(safe-area-inset-*)): no automatic content inset.
    contentInset: 'never',
    backgroundColor: '#070B14',
    allowsLinkPreview: false,
    preferredContentMode: 'mobile',
    // webContentsDebuggingEnabled is left unset: Safari Web Inspector works in Debug builds only.
  },
  plugins: {},
};

export default config;
