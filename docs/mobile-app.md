# Mobile app (Capacitor Android)

NicotinD ships a native **Android app** that wraps the existing Angular web UI in a
[Capacitor](https://capacitorjs.com/) shell. It connects to any self-hosted NicotinD server
(default `https://nicotined.kevinroberts.ar`) and adds native value on top of the web — chiefly
**background audio with lock-screen controls**.

## Why wrap instead of going native (the Immich divergence)

[Immich](https://github.com/immich-app/immich) — the mentor for this work — ships a **separate native
Flutter app** and a SvelteKit web app that share only an **OpenAPI-generated API client**. We
deliberately diverge: with a single maintainer, a second native codebase is double the work. Instead we
**wrap the one Angular app** with Capacitor (Cordova's modern successor; Electron is desktop-only and
can't target Android). What we *do* adopt from Immich is the **server-URL entry screen** for
self-hosting. NicotinD already exposes `/openapi.json` + `/doc`, so a future native client remains
possible without new server work — but it is explicitly out of scope here.

## Packages & project layout

`packages/mobile` is a thin Capacitor workspace:

- `capacitor.config.ts` — `appId: ar.kevinroberts.nicotind`, `webDir: ../web/dist` (the Angular build),
  default `https` Android scheme (serves from `https://localhost`).
- `android/` — the generated Gradle project (committed; build outputs, `.gradle/`, copied web assets and
  generated Capacitor config are git-ignored by the generated `.gitignore`s, so it's source-only).
- `src/version.ts` — pure `androidVersion(semver)` → `{ versionName, versionCode }` (unit-tested); keeps
  `bun run release` the single source of truth for the app version.
- `scripts/android-env.ts` — prints `NICOTIND_VERSION_{NAME,CODE}` for CI to feed gradle.
- `src/native-icons.ts` — pure SVG builders for the brand mark (unit-tested), and
  `scripts/generate-native-icons.ts` + `assets/` — see **App icons** below.

The web app is built once and copied into the shell; there is **no second UI codebase**.

## App icon & splash screen (Android + iOS)

Both the native launcher icon **and** the launch/splash screen are the **NicotinD
brand mark** (dark `#09090b` field, indigo `#6366f1` disc, off-white play glyph) — the
**same mark as the PWA manifest icon / favicon** (`packages/web/scripts/generate-icons.ts`),
not the default Capacitor bolt. One brand SVG is the source of truth, defined in
`src/native-icons.ts` (pure, unit-tested builders):

- `fullIconSvg` — the opaque full mark (iOS AppIcon + legacy Android launcher).
- `backgroundSvg` + `foregroundSvg` — the Android **adaptive** icon layers; the
  foreground glyph is scaled to `FOREGROUND_SAFE_ZONE` = 0.66 so launcher masks never
  clip it.
- `splashSvg` — the **splash**: the mark centred on the dark field, disc spanning
  `SPLASH_DISC_FRACTION` = 0.22 of the width so it's never cropped when the square
  source is letterboxed to a device aspect ratio. The same dark mark is used for both
  light and dark mode (the app is dark-branded), so `splash.png` and `splash-dark.png`
  are identical.

Generation is two steps via the official **`@capacitor/assets`** tool:

1. `bun run --filter @nicotind/mobile icons:source` — `scripts/generate-native-icons.ts`
   rasterizes the SVG (via `sharp`) into the `assets/` source images: three 1024²
   icon layers (`icon-only`, `icon-foreground`, `icon-background`) + two 2732²
   splashes (`splash`, `splash-dark`). These are **committed** so CI needs no native
   `sharp` build.
2. `bun run --filter @nicotind/mobile icons:generate` (`bunx @capacitor/assets generate`)
   — rasterizes the sources into the Android mipmaps + adaptive-icon XML + splash
   drawables (light `drawable-*` and dark `drawable-night-*`), and the iOS AppIcon +
   splash sets when an `ios/` project is present.

The **Android** outputs are committed (regenerate + commit when the mark changes, like
the PWA icons). The **iOS** AppIcon + splash are generated in CI because `ios/` is
ephemeral — see [ios-app.md](./ios-app.md). Two artifacts of the regen: the old
`values/ic_launcher_background.xml` color was dropped (the adaptive icon now references
PNG background layers, not `@color/…`), and `@capacitor/assets` reflows
`AndroidManifest.xml` whitespace on each run — that cosmetic churn is reverted so only
the icon/splash assets change.

## Server-aware Angular (the core enabler)

The web app historically assumed **same-origin relative `/api/*` paths**. A shipped app has no
same-origin server, so this was made runtime-configurable — safe on web (a no-op) and functional on
native:

- **`ServerConfigService`** (`packages/web/src/app/services/server-config.service.ts`) holds the API
  `baseUrl` (persisted in `localStorage`). It is `''` on web (relative, unchanged) and defaults to the
  canonical server on native. `apiUrl(path)` / `wsUrl(path)` turn `/api`…/`/rest`… paths absolute. Pure
  URL logic lives in `lib/server-url.ts` (`normalizeServerUrl`, `buildApiUrl`, `buildWsUrl`,
  `isHealthyResponse`) and platform detection in `lib/platform.ts` (`isNativePlatform()` reads
  Capacitor's injected global — **no `@capacitor/core` dependency in the web bundle**, so the same
  `dist/` ships to both browser and shell).
- **Interceptor** (`interceptors/auth.interceptor.ts`) rewrites `/api`/`/rest` HttpClient requests to the
  configured server (covering all of `ApiService` with zero edits) and redirects on 401 via the Angular
  `Router` (not `window.location` — a hard navigation breaks in the WebView).
- **Direct (non-HttpClient) URLs** use `server.apiUrl()`/`wsUrl()`: stream/cover URLs and Media Session
  artwork in `player.component.ts`, the playback WebSocket, `preserve.service.ts` blob fetches, the admin
  log `EventSource`, and the share view. **Cover-art `<img>` tags** are handled centrally in
  **`CoverArtComponent`** (`resolvedSrc` computed) — the single chokepoint for every `<app-cover-art>`.
- **Server-picker screen** (`pages/server-config/`, route `/server`): validates the entry against
  `GET /api/health`, persists, routes to `/login`. **`serverGuard`** (`guards/auth.guard.ts`) forces it on
  native first launch (`needsConfiguration()`); on web `needsConfiguration()` is always false, so the
  picker **never appears** and the existing e2e suite is unaffected.
- **QR device pairing** (see [device-pairing.md](device-pairing.md)): the picker's native-only
  **Scan QR** button (`@capacitor/barcode-scanner`, reached through the `Capacitor.Plugins` global via
  `scanBarcode()` in `services/native/native-capabilities.ts` so `@capacitor/*` stays out of the web
  bundle; requires the `CAMERA` permission added to the Android manifest) reads the server's
  Link-a-device QR, probes its candidate URLs, claims the one-time token, and lands **connected and
  signed in** in one scan. A **pairing code** field is the manual fallback (URL + 6-char code typed
  from the server's Devices page). No cleartext config is needed — the pairing URLs are HTTPS
  (Tailscale Funnel or a reverse-proxied deployment).
- **Service worker disabled on native** (`app.config.ts`): the WebView serves assets locally, so ngsw
  caching is redundant and can fight Capacitor / cross-origin API calls. IndexedDB offline still works.

## Network / offline detection (fixes the offline-launch ANR)

Offline used to be inferred **once**, at boot, from the startup setup probe failing — with **no**
`navigator.onLine`, no window online/offline listeners, and no `@capacitor/network`. On an offline
**launch** the native default server (`DEFAULT_SERVER_URL`) is unreachable, so bootstrap blocked on the
`SetupService.check()` probe for its full ~3 s timeout on a blank WebView, which on slower devices read
as **"app not responding" (ANR) → close-after-a-blink**. The offline state also never updated at
runtime, so dropping the network mid-session never re-routed the UI to on-device tracks.

The fix has four parts:

- **`NetworkStatusService`** (`services/network-status.service.ts`) is the single live connectivity
  source: a `online` signal seeded from **`@capacitor/network`** `getStatus()` and kept current via its
  `networkStatusChange` listener on native (reached through `getCapacitorPlugin('Network')` — **no
  `@capacitor/network` import in the web bundle**, same convention as the rest of the shell), and from
  `navigator.onLine` + window `online`/`offline` events on web/Electron. The Android WebView's
  `navigator.onLine` is unreliable (often stuck `true`), which is why native must use the plugin.
  `@capacitor/network` is a `packages/mobile` dependency (ships in the APK, self-registers).
- **`SetupService.isOffline` is now a `computed`** (`!network.online() || serverUnreachable`) instead of
  a boot-only writable signal, so every existing consumer (library source swap, nav gating, redirects,
  the new banner) reacts to connectivity flips in **both** directions with no reload. `check()` **skips
  the HTTP probe entirely when the device already reports offline** — the fast path that removes the
  blank-screen boot wait (and the flurry of failing offline requests) behind the ANR.
- **Native Sentry is trimmed** (`observability/sentry.ts` `nativeShell` arg, passed from `main.ts`,
  which also wraps `initSentry` in try/catch): Session Replay (rrweb DOM recording) + browser tracing
  (wrapping every fetch/XHR) ran on the WebView main thread **before** bootstrap and churned on the
  failing offline requests — the prime ANR suspect, active only in the release build. Error reporting is
  kept; replay/tracing are dropped on Capacitor/Electron.
- **Mid-use hardening**: the player skips a doomed network stream for a non-preserved track while offline
  (was a silent infinite spinner) and toasts instead (`player.component.ts` `stopForOffline`);
  `preserveCollection` swallows per-track offline fetch rejections (was an unhandled rejection that
  aborted the batch); GET requests get a 30 s interceptor timeout so a read can't hang forever in the
  WebView. The existing **offline banner** in the app shell (`layout.component.html`, now carrying
  `data-testid="offline-banner"`) is driven by the reactive `isOffline()` signal, so it now
  appears/hides live on a mid-session connectivity change rather than only at boot. See `docs/web-ui.md`
  §Offline / network detection.

## CORS (cross-origin from the WebView)

The native shell runs from `https://localhost` and calls the server cross-origin. Auth is a **Bearer
token** (no cookies), so a fixed origin allowlist suffices. `middleware/cors.ts` (`nativeAppCors()`,
mounted before auth on `/api/*`) allows `https://localhost` / `http://localhost` /
`capacitor://localhost`, permits `Authorization`/`Range` headers, and **exposes
`Content-Range`/`Accept-Ranges`/`Content-Length`** so cross-origin **206 range streaming and seeking**
work. The web UI is same-origin and unaffected. (The playback WebSocket performs no Origin check; auth is
via the `?token=` query param.)

## Background audio + system controls

The Android WebView **does not support the Web Media Session API**, so `navigator.mediaSession` calls are
silently ignored — no lock-screen / notification controls appear — and WebView HTML5 audio is **suspended
when the app is backgrounded**. Both are solved with **`@jofr/capacitor-media-session`**: on Android it
implements a native `MediaSession` **and runs a media-playback foreground service** (keeping audio alive
backgrounded); on web/iOS it's a thin wrapper over the Web API, so one code path serves all platforms.

> The web build also has an **Auto-preserve queue** toggle in Settings → Offline storage that pre-buffers
> the next-N queued tracks into IndexedDB so the browser's locked-screen network throttle (Android Chrome,
> iOS Web) can't stall streaming playback. Native shells (Capacitor iOS/Android, Electron) **skip** the
> coordinator entirely — they already run a foreground service / own the audio session natively, so the
> failure mode this guards against doesn't apply. See `docs/web-ui.md` §Auto-preserve queue.

Wiring (so it stays maintainable and testable):
- **`MediaControlsService`** (`packages/web/src/app/services/media-controls.service.ts`) wraps the plugin
  with guarded, best-effort calls (`setMetadata` / `setPlaybackState` / `setActionHandler` /
  `setPositionState`). The plugin is **lazily imported** (dynamic `import()`), so unit tests and the
  initial web chunk never pull in Capacitor, and a browser without media-session support just no-ops.
- **`buildMediaMetadata`** (`lib/media-metadata.ts`, pure + unit-tested) builds the title/artist/album +
  multi-size artwork (artwork URLs go through `ServerConfigService.apiUrl`).
- `player.component.ts` drives it: metadata + playback-state effects, action handlers (play/pause/next/
  prev/seek), and `setPositionState` on the 2 s progress tick (keeps the notification scrubber in sync and
  enables `seekto`). The plugin **requires** an explicit `setPlaybackState('playing')` + registered
  play/pause handlers for the notification to appear — both are wired.
- Manifest permissions: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS`,
  `WAKE_LOCK`.

**Capacitor version note**: `@jofr/capacitor-media-session@4` officially supports **Capacitor 6**, so
`packages/mobile` is pinned to Capacitor 6 (CI uses **JDK 17**). This trades "latest Capacitor" for a
media-session plugin on its supported major — the right call for a feature that can't be validated in CI
and must work first try on device. Revisit if the plugin (or a equivalent) ships Capacitor 7+ support.

Still device-validated, not CI-validated: confirm on a physical device that playback continues
backgrounded and the lock-screen controls/scrubber work.

## OAuth login (proposed — not yet implemented)

Google + Microsoft OAuth login is **proposed** for NicotinD as an `auth` plugin
kind, with full mobile parity. The complete design lives in
[oauth-auth.md](oauth-auth.md); this section covers the mobile-specific parts.

The native app and the served web UI share the **same server callback** — the
provider redirects back to `${NICOTIND_PUBLIC_URL}/api/auth/callback/:provider`
in both cases. The difference is the **final hop**: the server inspects
`state.client` (`'web'` or `'mobile'`, recorded when the flow started) and
302-redirects to:

- **web**: `/auth/callback#token=…` (SPA route parses the hash)
- **mobile**: `nicotind://auth-callback#token=…&provider=…` (a custom-scheme
  deep link the Capacitor app receives via `@capacitor/app`'s `appUrlOpen`
  listener)

The mobile login button opens the provider consent screen in the **system
browser** (`@capacitor/browser`, not the WebView) so the user authenticates with
their real Google/Microsoft session. After consent: system browser → server
callback → `nicotind://` deep link → the app reads `#token=…` →
`AuthService.login()` → navigates to `/`.

Proposed new deps (already Capacitor 6 compatible): `@capacitor/app`,
`@capacitor/browser`. The `nicotind` custom scheme is registered in
`capacitor.config.ts` + an Android intent-filter in `AndroidManifest.xml`. No
new native plugin — just the official ones.

## Developer workflow

Requires JDK 17 + the Android SDK (Android Studio). From the repo root:

```bash
bun install
bun run --filter @nicotind/web build      # produces packages/web/dist
cd packages/mobile
bunx cap sync android                      # copy web + plugins into android/
bunx cap run android                       # build & launch on device/emulator
```

The app opens to the **server-picker** (default `https://nicotined.kevinroberts.ar`); connect → login →
browse → play.

## Release & signing

- **Versioning**: `android/app/build.gradle` reads `NICOTIND_VERSION_{NAME,CODE}` from the environment;
  CI derives them from `package.json` via `scripts/android-env.ts` → `androidVersion()`. So the existing
  `bun run release` drives the app version with no second source of truth.
- **Signing**: the release `signingConfig` is supplied entirely via env. With no keystore env (local dev)
  the release build is left unsigned so contributors can `assembleRelease` without secrets.
- **CI** (`.github/workflows/deploy.yml`, `android` job): gated like `deploy` (the `chore(release):`
  commit or a manual run) and runs in parallel with it — a failure here does **not** block the server
  deploy (no `needs` linkage), but it is **not** `continue-on-error`: a genuine build break turns the
  release run red so it can't ship a tag with no APK. It builds the web, `cap sync`s, decodes the
  keystore, runs `./gradlew assembleRelease`, and
  attaches the APK to the GitHub Release for the version tag. Required repo secrets:
  `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
  (until they're set, the job builds an unsigned APK / fails loudly — it never ships a broken keystore).

### `@capacitor/barcode-scanner` build requirements (root `build.gradle` + `variables.gradle`)

The QR device-pairing plugin (`@capacitor/barcode-scanner`) pulls its native lib
`com.github.outsystems:osbarcode-android` — and building it needs two things that broke the
`android` release job when the plugin first landed (v0.1.222):

- **An extra Maven repo.** Despite the `com.github.*` group name, osbarcode is **not** on JitPack,
  Google, or Maven Central — it lives on OutSystems' **Azure Artifacts** public feed. The plugin
  declares that repo in *its own* `build.gradle`, but a subproject's repositories are **not**
  consulted when `:app` resolves its transitive runtime classpath — only the root `allprojects`
  repos are. So `android/build.gradle`'s `allprojects.repositories` must mirror it (scoped with
  `content { includeGroup 'com.github.outsystems' }` so nothing else routes through Azure).
- **`minSdkVersion = 26`.** osbarcode declares `minSdk 26`; with the Capacitor default of 22 the
  manifest merger fails (*"minSdkVersion 22 cannot be smaller than version 26"*). Bumped in
  `variables.gradle` (drops Android < 8.0, forced by the merged QR feature).

Both were verified locally by `./gradlew :app:assembleDebug` (unsigned; exercises the same
dependency resolution + manifest merge as `assembleRelease`) producing a working APK. CI only
surfaced the repo error first because it fails at dependency resolution before the manifest merge.

## Tests (quality gates)

- `lib/server-url.ts` (`packages/web/src/app/lib/server-url.spec.ts`) — normalize/build/health logic.
- `lib/media-metadata.ts` (`media-metadata.spec.ts`) — title/artist/album + multi-size artwork building.
- `middleware/cors.ts` (`packages/api/src/middleware/cors.test.ts`) — allowed-origin reflection, exposed
  Range headers, preflight OPTIONS, disallowed-origin rejection.
- `src/version.ts` (`packages/mobile/src/version.test.ts`) — version mapping + monotonicity; run in CI via
  the `ci` job's `bun test … packages/mobile/src`.
- The Android `assembleRelease` (CI `android` job) is the build-level gate; there is no emulator in CI, so
  shared logic stays in the unit-tested helpers above.

## Known optimization (not yet done)

The web is built independently in the `ci`, `e2e`, `android`, and Docker stages. Factoring it into a
single uploaded artifact consumed by `e2e` + `android` would cut redundant builds — left as a separate
CI refactor to avoid entangling it with the app work.
