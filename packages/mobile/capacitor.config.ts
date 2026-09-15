import type { CapacitorConfig } from '@capacitor/cli';
// Extensionless on purpose: the Capacitor CLI loads this file by registering
// `require.extensions['.ts']` and require()ing it, so a `.js` specifier would
// resolve to a file that does not exist on disk. tsconfig uses
// moduleResolution "bundler", which accepts the extensionless form too.
import pkg from './package.json';
import { fdroidIncludePlugins } from './src/fdroid';

// NICOTIND_FDROID=1 builds the F-Droid variant: the same locked dependency tree
// with the non-free Capacitor plugins excluded. See src/fdroid.ts and
// docs/fdroid.md (issue #1168).
const fdroid = process.env.NICOTIND_FDROID === '1';

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
    // which the API CORS allowlist (NATIVE_APP_ORIGINS) accepts. Mixed content
    // is allowed because a self-hosted LAN server is plain http (issue #390):
    // from the https://localhost origin every http API call is mixed content,
    // and blocking it made such servers unreachable ("Couldn't reach a
    // NicotinD server"). Pairs with usesCleartextTraffic in AndroidManifest.
    allowMixedContent: true,
    // `includePlugins` REPLACES Capacitor's dependency scan, so it is only set
    // for the F-Droid variant — leaving it undefined elsewhere keeps the normal
    // build on Capacitor's own discovery rather than on a list to maintain.
    ...(fdroid
      ? { includePlugins: fdroidIncludePlugins(pkg.dependencies, pkg.devDependencies) }
      : {}),
  },
  ios: {
    // iOS WKWebView serves the app from `capacitor://localhost` (already in the
    // API CORS allowlist). `contentInset: 'always'` lets the SPA handle the safe
    // areas itself (BottomNav/player already account for the home indicator).
    contentInset: 'always',
  },
};

export default config;
