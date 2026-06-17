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

The web app is built once and copied into the shell; there is **no second UI codebase**.

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
- **Service worker disabled on native** (`app.config.ts`): the WebView serves assets locally, so ngsw
  caching is redundant and can fight Capacitor / cross-origin API calls. IndexedDB offline still works.

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
  deploy. It builds the web, `cap sync`s, decodes the keystore, runs `./gradlew assembleRelease`, and
  attaches the APK to the GitHub Release for the version tag. Required repo secrets:
  `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
  (until they're set, the job builds an unsigned APK / fails loudly — it never ships a broken keystore).

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
