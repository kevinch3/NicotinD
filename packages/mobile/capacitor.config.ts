import type { CapacitorConfig } from '@capacitor/cli';

// The bundled web app is loaded from a local origin in the WebView and talks to
// the user's self-hosted server cross-origin (see ServerConfigService + the API
// CORS middleware). `webDir` points at the @nicotind/web Angular build output;
// run `bun run --filter @nicotind/web build` before `cap sync`.
const config: CapacitorConfig = {
  appId: 'ar.kevinroberts.nicotind',
  appName: 'NicotinD',
  webDir: '../web/dist',
  android: {
    // Capacitor's default `https` scheme serves the app from https://localhost,
    // which the API CORS allowlist (NATIVE_APP_ORIGINS) accepts.
    allowMixedContent: false,
  },
  ios: {
    // iOS WKWebView serves the app from `capacitor://localhost` (already in the
    // API CORS allowlist). `contentInset: 'always'` lets the SPA handle the safe
    // areas itself (BottomNav/player already account for the home indicator).
    contentInset: 'always',
  },
};

export default config;
