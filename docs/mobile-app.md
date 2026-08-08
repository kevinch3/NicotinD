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
can't target Android). What we _do_ adopt from Immich is the **server-URL entry screen** for
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
  from the server's Devices page). Pairing URLs are typically HTTPS (Tailscale Funnel or a
  reverse-proxied deployment), but plain-`http` LAN servers also work: the Android shell allows
  cleartext + mixed content (issue #390 — `android:usesCleartextTraffic="true"` in the manifest +
  `allowMixedContent: true` in `capacitor.config.ts`). Without those, the WebView's
  `https://localhost` origin blocked every `http://` API call twice over (cleartext policy + mixed
  content), making LAN-only self-hosted servers unreachable from the app entirely — the accepted
  trade-off is that a self-hosted music server on a private LAN is exactly the deployment that has
  no TLS. **iOS carries the mirror exception (issue #397)**: `ios-plist.ts` now writes
  `NSAppTransportSecurity: { NSAllowsArbitraryLoads: true }` into the generated Info.plist —
  arbitrary-loads rather than the scoped `NSAllowsLocalNetworking` because a self-hosted server can
  live on any hostname or raw IP (not just `.local`), and the sideloaded IPA never faces App Store
  review's justification requirement. Unverified on hardware (no signed device build), but the
  plist patching path itself is the same CI-exercised one as the audio/camera keys.
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
  - **The native seed is asynchronous, so the service also exposes `whenReady()`** — a promise that
    resolves once the _initial_ `online` value is known. On web/Electron (and when the plugin is
    missing) the seed is synchronous, so `whenReady()` is already-resolved; on native it settles after
    the plugin's `getStatus()` promise resolves **or rejects** (a failed/hung seed must never leave
    `whenReady()` pending forever — it would hang bootstrap, worse than the ANR it guards). This seam
    exists purely because `SetupService.check()` runs synchronously in the app initializer while the
    native seed is a promise — see the next bullet.
- **`SetupService.isOffline` is now a `computed`** (`!network.online() || serverUnreachable`) instead of
  a boot-only writable signal, so every existing consumer (library source swap, nav gating, redirects,
  the new banner) reacts to connectivity flips in **both** directions with no reload. `check()` **skips
  the HTTP probe entirely when the device already reports offline** — the fast path that removes the
  blank-screen boot wait (and the flurry of failing offline requests) behind the ANR.
  - **The fast path only works if the seed has landed.** `check()` **`await`s `network.whenReady()`
    first** (bounded by `NETWORK_SEED_TIMEOUT_MS` = 1500 ms so a broken/absent plugin whose
    `getStatus()` never resolves can't hang boot — it falls through to the probe instead). Without this
    await the bug was still live: at the instant `check()` runs, the native `online()` signal is still
    its optimistic `true` (the `getStatus()` promise hasn't resolved yet), so the offline fast path was
    _silently skipped_ on a real offline launch and bootstrap blocked on the 3 s HTTP probe — the exact
    ANR/crash-on-blink the whole section exists to prevent. The seed is a _local_ OS query
    (ConnectivityManager), so the await normally costs a few ms, and on web it's already-resolved so
    the e2e suite / browser boot are unaffected.
- **The offline switch is automatic in both directions** (the app _detects_ offline and enters/leaves
  that mode by itself, mid-session included):
  - **Enter**: the device signal covers radio-level drops instantly; for the "device network fine,
    server gone" case the `authInterceptor` reports any **status-0** (no-HTTP-response) failure on an
    `/api`/`/rest` path to `SetupService.reportServerFailure()`, which runs a **verification probe**
    before flipping the app offline — one flaky request must never bounce the whole UI. Reports are
    single-flight and ignored while already flagged (the recovery poll owns retries, so N failing
    background polls can't turn into N probes). Any HTTP status ≥ 1 means the server answered and is
    never reported.
  - **Leave**: while flagged unreachable, `SERVER_RECOVERY_POLL_MS` (20 s) re-probes — the only state
    in which the app generates background probe traffic — and a **reconnect fast path** (an `effect`
    on the offline→online transition of the network signal) probes _immediately_, so leaving airplane
    mode / regaining Wi-Fi restores online mode in one round-trip instead of a poll-interval wait.
    The reconnect probe also fires when `status` is still `null` — i.e. an offline **launch** skipped
    the boot probe entirely, so the app has never learned the server's setup state and must catch up
    now. A healthy already-probed session reconnecting after a tunnel/elevator blip adds **no**
    probe (unit-tested), preserving the zero-extra-traffic property. **Third leave-path — the
    success signal (issue #372)**: the interceptor also reports every SUCCESSFUL `/api`/`/rest`
    response (`SetupService.reportServerSuccess()`), and a real HTTP response while flagged
    unreachable is itself the reachability proof — the flag clears instantly with **no** probe
    (unless `status` is still `null`, the offline-launch catch-up, which does probe) and the
    recovery poll is cancelled. This is what heals the app the moment any background request (the
    disk pill, the transfers poll, a heartbeat) reaches a recovered server, instead of waiting up
    to 20 s or for a device online event that never fires in a server-side outage — and it is what
    made the order-dependent `offline.spec.ts` e2e flake (the reconnect fast path's device event
    occasionally going quiet under Playwright's `context.setOffline`) deterministic: 5/5 green
    with retries disabled on the exact repro pair that previously failed most runs.
    `SetupService.verify()` is the single writer of `serverUnreachable` in both directions, so every
    trigger (boot, interceptor report, poll, reconnect) shares one decision path.
  - **Offline keeps the session**: the boot `refreshToken`/`getMe` chain (now the exported
    `refreshSession` in `app.config.ts`) runs _after_ `check()` and only when online — an offline
    launch keeps the stored JWT so the on-device library stays usable, instead of burning doomed
    auth requests (part of the old offline boot flurry). When the app later returns online, a
    one-shot self-destroying `effect` runs the deferred refresh so roles/flags re-sync without a
    reload — **without** the autoplay resume (`withAutoplay: false`): music suddenly starting
    minutes after launch because connectivity returned would be a surprise, not a restore.
- **Native Sentry is trimmed** (`observability/sentry.ts` `nativeShell` arg on `loadSentry`, passed
  from `main.ts`, whose call site is try/catch-wrapped): Session Replay (rrweb DOM recording) +
  browser tracing (wrapping every fetch/XHR) run on the WebView main thread and churned on the
  failing offline requests — the prime ANR suspect, active only in the release build. Error reporting
  is kept; replay/tracing are dropped on Capacitor/Electron. (Since #285 the SDK loads lazily on every
  surface, so it no longer runs _before_ bootstrap anywhere; the native trimming stays because the
  instrumentation is WebView-heavy once loaded.)
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

## Android TV support

The Android APK is usable on Android TV / TV boxes via direct sideload, and it **appears on the TV
home launcher** (issue #388): `AndroidManifest.xml` declares the
`android.intent.category.LEANBACK_LAUNCHER` category on MainActivity's existing MAIN/LAUNCHER
intent-filter, an `android:banner="@drawable/banner"` (320×180 xhdpi PNG rendered by
`bun run icons:source` from `native-icons.ts`'s `bannerSvg()` — `@capacitor/assets` has no banner
concept, so the generator writes it straight into the committed `res/drawable-xhdpi/`), and
`<uses-feature android:name="android.software.leanback" android:required="false"/>`. The shipped
banner is a **disc + "NicotinD" wordmark lockup** (`BannerWordmark`): Google's TV app-icon
guideline requires the app name inside the banner art (launchers may render no separate label), and
the wordmark is converted to SVG **paths** via `opentype.js` + the committed
`assets/fonts/Roboto-Bold.ttf` (Apache-2.0, notice alongside) rather than SVG `<text>`, because
librsvg shapes text with host fonts and would break the committed-deterministic-output property.
The `CAMERA` permission (QR pairing) otherwise implies `android.hardware.camera required=true`, so
the manifest relaxes it too — on a camera-less TV the QR scan path simply stays unavailable while
the manual pairing code works. The original
"sideload-only ⇒ no leanback declarations" decision rested on a wrong premise: `LEANBACK_LAUNCHER`
is what makes **any** installed APK (sideloaded included) show up on the Google TV home row — it is
not a Play-Store-listing requirement; without it the app was only reachable via Settings → Apps.
One activity serves both form factors — extra intent-filter categories never un-match phone
launchers (verified on-device), and both TV-ish `uses-feature`s are `required="false"` so phone
installs are unaffected. `AndroidManifest.xml` also declares
`<uses-feature android:name="android.hardware.touchscreen" android:required="false"/>` so the app
isn't blocked/degraded on a touchscreen-less device. `packages/mobile/src/android-manifest.test.ts`
locks all of this in (the first manifest-content test — pure XML no compiler checks).

**Google TV Play Next + Assistant voice (`@nicotind/capacitor-tv-channels`)**: the repo's first
Android-side Capacitor plugin (`packages/capacitor-tv-channels/`, mirroring
`capacitor-now-playing`'s shape with `"capacitor": {"android": {"src": "android"}}` and no JS
package — the web reaches it through the `Capacitor.Plugins.NicotindTvChannels` global). It keeps
ONE "Continue listening" entry in the launcher's Watch Next row for the current track
(`publishPlayNext`/`clearPlayNext` via androidx.tvprovider `WatchNextProgram`; the previous row id
lives in SharedPreferences so publishes replace, never accumulate; every method is gated on
`UiModeManager` reporting a television so phones no-op; failures are swallowed — Play Next is
best-effort and must never break playback). The same plugin bridges the Assistant's
`MEDIA_PLAY_FROM_SEARCH` intent (a **separate** manifest intent-filter — never merged into the
MAIN filter) to a `playFromSearch` web event, retained (`notifyListeners(..., true)`) so a
cold-start voice launch isn't lost before the web layer attaches. Web side:
`services/native/tv-channels.service.ts` publishes on track change (the MediaSession-artwork URL
recipe) and answers voice queries via the pure `lib/play-from-search.ts` ranker (core `fold`,
exact-title > title-prefix > all-tokens; null keeps current playback) over a `q=`-filtered
`/api/library/songs` page. `deploy.yml`'s mobile path filter includes the new package.

**Launcher channel row (issue #395)**: the same plugin also maintains ONE preview channel on the
launcher home — `publishChannel`/`clearChannel` via androidx.tvprovider `Channel`/`PreviewProgram`
(`TYPE_PREVIEW` channel, `TYPE_ALBUM` programs, 1:1 poster art). Same discipline as Play Next:
channel id in SharedPreferences, replace-all program semantics per publish (the preview-program
table forbids query selections, so the wipe filters client-side over the app's own rows), every
method TV-gated + best-effort. The channel logo is rendered from the app icon
(`ChannelLogoUtils`) so there's no second asset to sync; `requestChannelBrowsable` runs once on
creation (some launchers auto-surface an app's first channel and ignore it). Each tile's intent
URI carries the album's in-app route as a `nicotind_route` extra, forwarded to the web as a
retained `deepLink` event (same cold-start buffering as `playFromSearch`) — the web side runs it
through `sanitizeReturnUrl` (an intent extra is craftable by any app on the device, same trust
level as a returnUrl) before `router.navigateByUrl`. Web content: `TvChannelsService.syncChannel`
publishes the 12 newest albums as a translated "Recently added" row, driven by an effect on
auth token + i18n readiness (the `ready` gate keeps a raw key off the launcher; a language switch
retitles the row); sign-out deletes the channel (which cascades its programs). No background
sync — the row refreshes whenever the app runs, which for a music app the user opens to play is
the natural cadence; a WorkManager periodic sync remains out of scope. Verified on the google-tv
emulator end-to-end: bridge payload → provider row inserts (temporary instrumentation, since the
shell can't query another app's TV-provider rows) → firing a tile's intent (`am start … --es
nicotind_route /library/albums/<id>`) lands on that album's detail page.

**Overscan calibration (Settings → Appearance, TV only)**: real panels overscan differently, so the safe-area insets are now per-device presets (`lib/tv-overscan.ts`: Off / Standard / Extra, localStorage `nicotind-tv-overscan`, the language-picker per-device rationale) applied as inline `--tv-overscan-x/y` on the root at bootstrap (main.ts, overriding the stylesheet defaults; Standard equals the defaults so fresh installs look unchanged) and switchable live from an `isTvUi()`-gated preset row.

**Overscan safe area (TV builds only)**: TVs may crop up to ~5% of every edge, so `main.ts` stamps
a `tv-build` class on `<html>` via `lib/platform.ts`'s `applyTvBuildClass` (pure, unit-tested) and
`styles.css` insets _content_ into the action-safe area (`--tv-overscan-x/y`, ≈ the Android TV
48/27dp-at-1080p guideline) on the app shell's stable landmarks — `header`, `main`,
`[data-bottom-chrome]`, and the Now Playing sheet — while surfaces/backgrounds keep bleeding to the
physical edge (the standard TV treatment). Non-TV builds are untouched: every rule is scoped under
`html.tv-build`, and the class is only applied when `isTvBuild()`.

**Dedicated TV player (Now Playing)**: the sheet root is a mixed nav group — header close, the
cover's track-info button and the transport's Radio toggle are direct items, with the
transport/tabs/queue registering as child groups, so the whole sheet is one vertical D-pad sweep
(issue #389, the first mixed-entries consumer; `now-playing-tv.spec.ts` walks it). A 1080p TV at
density 320 is a **960×540 CSS viewport** —
below Tailwind's `lg` (1024px) — so the sheet used to render the mobile _stacked_ layout in a short
landscape window and the cover pushed the whole transport below the fold (the "only shows the art
cover" report). On TV the sheet is now a 10-foot player: the current cover, stretched and heavily
blurred, backs the whole sheet (`--np-tv-backdrop` bound in `now-playing.component.html`, drawn by
the root's `::before` at `z-index:-1` — the fixed root's `z-[60]` makes it a stacking context, so
the layer sits above the sheet background but below all content). **`tvBackdropUrl` returns null
while the sheet is closed (issue #439)** — the sheet is never unmounted, only translated below the
viewport, and the `::before`'s `inset: -6%` reaches 32px back _inside_ a 540px TV viewport, where
`blur(56px)` smeared the cover's colour a further ~56px up. Because `z-[60]` sits above the
mini-player's `z-50`, that wash painted _over_ the bottom of every route, tinting with whatever was
playing (measured: a +4.2 luminance ramp at the bottom edge, flat after the fix). The fix is to
withhold the URL, **not** `overflow: hidden` on the sheet — the sheet's transform makes it the
containing block for the fixed-position TV queue overlay, so clipping it would clip that too. The
art is centered; the
seek/transport is a bottom-pinned glass bar (Netflix/Spotify convention; `position:absolute` on the
`app-now-playing-transport` host, overriding its `contents` display); shuffle/repeat are
template-gated out of the transport; and the stacked queue/lyrics panels + pointer-drag resize
handle are template-gated off in favour of a top-right **Next-up chip** (head of the queue, placed
left of the header's device switcher). **The chip opens a queue overlay (issue #399)**: it's a
focusable nav item in the sheet's root group; Enter opens
`NowPlayingTvQueueComponent` — a right-aligned glass panel where each queued track is a horizontal
child group of [jump, remove]. Jump reuses `jumpToQueueIndex` (the #233 consume-up-to semantics)
and closes the overlay; removing the last row closes it too rather than stranding focus. Being
`@if`-rendered it takes the #398 modal shape (`registerOverlayCloser` in the constructor), so
Escape/hardware Back close it topmost-first, and closing restores focus to the chip (the MenuPanel
discipline, via a host query — signal view queries don't populate in the JIT vitest harness). Components read TV-ness via `lib/platform.ts`'s
**`isTvUi()`** — the `tv-build` _root class_, not the build-time env — so
`packages/e2e/tests/now-playing-tv.spec.ts` exercises the real TV template in the prod bundle by
stamping the class at a 960×540 viewport (transport fully on-screen + pinned low, shuffle/repeat
absent, chip content/position, backdrop layer present). **Remote playback out of the box**:
verified on a fresh tv-build install — "Make this device available as an audio output" defaults ON
(`resolveTvDefaultedPreference`) and the device self-registers in Connected devices; an explicit
stored toggle always wins over the default (so reinstalled test devices with old data can differ). The
default device _name_ on a TV is `"NicotinD TV"` (issue #393; the UA-derived fallback said
"Chrome on Android") — a stored user-chosen name still wins.

A separate Angular build configuration (`bun run --filter @nicotind/web build -- --configuration
tv`, `angular.json`) swaps in `environments/environment.tv.ts` (`tvBuild: true`, otherwise
identical to the prod environment), exposed via `lib/platform.ts`'s `isTvBuild()`. This is a
**build-time flag, not a runtime Android `UiModeManager` check** — simpler and sufficient for
sideload-only distribution, at the cost of needing a separately-built bundle (`bunx cap sync
android` after building with `--configuration tv`) rather than one universal APK auto-detecting TV
at runtime. Going through `bun run --filter @nicotind/web build` (rather than calling `ng build`
directly) matters: it runs this package's `prebuild` script (generates `changelog.json`) first, the
same as every other build of this package. The `tv` configuration deliberately **duplicates**
`production`'s budgets/optimization/serviceWorker settings rather than extending it — Angular CLI
configuration composition doesn't deep-merge array properties like `fileReplacements`, so `"tv"`
can't just layer on top of `"production"` — which means the two must be kept in sync by hand;
nothing currently enforces that automatically, so update both together if `production` changes.

The only behavior this flag currently changes: `RemotePlaybackService.remoteEnabled` defaults to
`true` on a TV build when the user has never explicitly toggled "Allow remote control" (an explicit
choice, stored in `localStorage` under `nicotind_remote_enabled`, always wins — resolved by the one
shared `resolveTvDefaultedPreference` helper in `lib/platform.ts`, used both by
`RemotePlaybackService`'s signal and by the WS `REGISTER` payload in `playback-ws.service.ts`, so
the two can't disagree about whether the TV is opted in) — so a TV instance is controllable from a
phone via the existing device-agnostic remote-playback relay (`docs/remote-playback.md`) after
signing in on the TV once (the **approve-from-phone flow** in `docs/device-pairing.md` — the TV
displays a QR + code and signs itself in with zero typing). Hardware media-key handling (a TV
remote's transport buttons) is **verified on the Google TV emulator**: `KEYCODE_MEDIA_PLAY_PAUSE`
(85) toggles playback and `KEYCODE_MEDIA_NEXT`/`PREVIOUS` (87/88) change tracks through
`@jofr/capacitor-media-session`'s existing MediaSession action handlers, no code changes needed.
On TV that is also the answer to the Space/K parity gap: every focused element is a `<button>` (so
the global Space shortcut is suppressed by design) and a remote has no K key — play/pause belongs
to the media keys, which work.

**D-pad navigation (Phase 3 extends this to grids)**: a `'grid'` axis was added
(`lib/tv-nav-grid.ts`'s `inferColumnsPerRow`, comparing rendered `offsetTop` across items — no
`grid-template-columns` parsing, works across any responsive breakpoint) — ArrowLeft/Right move
within a row (clamped, no wrap to the next row), ArrowUp/Down jump a full row landing on the same
column, clamped into a shorter final row. Applied to every Library page card grid (albums,
compilations, singles/EPs, artists, genres) + the Library playlists list, artist-detail's
albums/singles/appears-on grids, the Search page's catalog albums grid + artist chips, the
album-hunt-modal candidate list, and — via one shared change to `TrackRowComponent` itself — every
song list built on it (library Songs tab, album/genre/artist/playlist detail pages). **Settings/Admin/Extensions coverage (Phase 4)**: applied to Settings' theme/budget/auto-preserve grids and account action list, the Devices/agent-tokens revoke lists, Admin's services grid, log-service buttons, processing-task checkboxes, and user-management action buttons, and the Extensions (plugins) page's enable/configure buttons per card. Forms stay Tab-order-only by design — native `<input>`/`<select>` elements are never wrapped in `appTvNavItem`, so arrow keys keep their native meaning inside them (caret movement, select-value change, number increment). **Find-a-song flow coverage (issue #389)**: the Library **tabs bar** is a horizontal group; the album-detail **action row** (Play/Select/Download/Share/Fix/Remove) is a horizontal group; **every `TrackRowComponent` is its own horizontal child group** (title + like + remove + ⋯ menu toggle as items) nested inside the surrounding vertical list, enabled by the mixed items+child-groups directive rework; and **`MenuPanelComponent` speaks D-pad** — the first action autofocuses on open, ArrowUp/Down move between actions (stopPropagation so the list behind never navigates underneath), Enter activates, and closing restores focus to the trigger (only when focus was inside the panel — an outside click keeps its own focus). This is what finally exposes `SongMenuService`'s Play next / Add to queue to remote users; the keyboard-only journey is locked in by `packages/e2e/tests/library-dpad-tv.spec.ts`. **The #389 tail is closed (issue #396)**: `TvNavItemDirective` gained an Enter/Space→`click()` activation passthrough for hosts with no native key activation (skipped for buttons/inputs — a synthesized click would double-fire — and for keys coming from a focusable descendant), which is what the Admin **duplicates list** needed — the panel is one vertical group where the find button, every song row (`<label>` wrapping its checkbox; the passthrough makes Enter toggle it, and the label's native forward-to-control means the checkbox flips exactly once) and the delete button share one sweep. The **streaming panel**'s two checkbox rows got per-row horizontal groups with the checkbox as the item, while its `<select>`s deliberately stay **outside every group's subtree** (the structural invariant the user-row test pins: a select inside a group would have its option cycling intercepted) — select rows remain served by the WebView's spatial navigation and the native TV picker dialog. And the **fullscreen karaoke overlay** is now a vertical group of two horizontal rows — header (exit / browse / vocal-mute) + transport (prev / play-pause / next) — so all six buttons are D-pad reachable; the browse-mode lyric lines keep their existing tabindex/Enter handling (D-pad line browsing is possible follow-up work, but browse mode is primarily the wheel/touch gesture surface). The full keyboard shortcut table (Phase 6) is also still just Space/K.

**The mini-player grab notch (issue #432)**: the one affordance in the player chrome that had
**no** D-pad path. Both the notch and the bar were bound solely to `(pointerdown)` →
`onBarPointerDown` → `createPointerDrag`; a remote emits key events, never pointer events, so
expanding Now Playing from the mini-player was impossible. It looked half-alive only because
`PlayerTransportMiniComponent`'s prev/play/next are `appTvNavItem`s — `player.component.html` itself
carried zero `appTvNav*` markers. The notch is now an `appTvNavItem` with a `(click)` handler
(`openNowPlaying()`), which the directive's Enter/Space→`click()` passthrough also reaches.

It deliberately stays a `<div>` rather than becoming a `<button>`: `onBarPointerDown` bails on
`target.closest('button')`, so promoting it would have silently killed the touch swipe-to-open drag
the notch exists to serve. The double-activation a tap produces (pointer gesture _and_ the native
click) is harmless — `setNowPlayingOpen(true)` is idempotent.

That required one change to the shared directive. `TvNavItemDirective` bound
`[attr.role]="itemRole()"`, which returns `null` outside a grid group, and a host binding always
beats a static template attribute — so `role="button"` on the notch would have been silently erased.
`itemRole()` now falls back to the role the template authored (captured before the binding can
overwrite it), keeping `gridcell` behaviour inside grids and no longer clobbering author intent
anywhere else.

**DI crosses a component boundary but NOT an `ngTemplateOutlet` one (the Phase 4 final-review
fix)**: the Extensions page rendered every plugin card from a shared `<ng-template #card let-p>`
declared as a **sibling** of its three `<section appTvNavGroup>` blocks and instantiated inside each
with `<ng-container [ngTemplateOutlet]="card">`. An embedded view is created from its template's
**declaration** context (`TemplateRef.createEmbeddedViewImpl` uses `_declarationLView` /
`_declarationTContainer`), and the node injector walks that declaration ancestry — not the DOM
position of the `<ng-container>` that instantiated it. So every `appTvNavItem` in the card resolved
`inject(TvNavGroupDirective, {optional: true})` to `null`, `registerItem` never ran, all three
groups held zero items, and D-pad navigation on the entire page was a **silent** no-op (`onKeydown`
returns early on an empty group; an unmatched directive selector is not an Angular error). This is
the second instance of the same class of bug as the Phase 3 `@ContentChildren` one, and it shipped
through three task reviews for the same reason: the tests asserted `hasAttribute('appTvNavItem')`,
and a directive-selector attribute stays in the rendered DOM whether or not the directive is
imported, applied, or able to reach its group.

`ngTemplateOutletInjector` does **not** fix it — it feeds `embeddedViewInjector`, part of the
environment/provider fallback chain, not the node-injector chain this DI uses. The fix extracts the
card into a real `PluginCardComponent` (`pages/plugins/plugin-card.component.*`), because DI _does_
cross a real component's view boundary — the same mechanism `TrackRowComponent`'s title button
relies on. **Every Phase 4 page therefore now carries at least one behavioural test** (a real
`KeyboardEvent` moving `document.activeElement`, or an assertion on the group's registered
`items()` where a page has structurally only one item, as Admin's one-element services grid does) —
attribute assertions alone are treated as insufficient for this directive pair.

Two smaller Phase 4 corrections shipped with it. Admin's **processing-task checkbox list is
`axis="grid"`, not `vertical`**: each row lays its run + gate checkbox out side-by-side while DOM
order is run₁, gate₁, run₂, gate₂ …, so on the vertical axis ArrowDown moved to the same row's gate
box (visually to the _right_) and Left/Right did nothing; `inferColumnsPerRow` reads the two
same-`offsetTop` checkboxes as 2 columns. And Settings' auto-preserve grid **no longer declares a
static `role="radiogroup"`**: `TvNavGroupDirective` binds `[attr.role]` on every change-detection
pass, so a hand-written role on the same element is silently overwritten (it rendered as
`role="grid"`). The directive's role is authoritative — as it already is for every other group in
the codebase, none of which declare their own.

**Items register via DI, never via `@ContentChildren` (the Phase 3 final-review fix)**: an Angular
content query stops at a component's view boundary — a component's template is a black box to its
ancestors. Phase 3 put `appTvNavItem` on the title button inside **`TrackRowComponent`'s own
template** and wrapped `<app-track-row>` with `appTvNavGroup` in five consumer pages
(album/genre/playlist detail, library-songs, artist-detail Songs), so the group's
`@ContentChildren` query saw **zero** items on all five. That was worse than a silent no-op:
`TvNavItemDirective`'s `inject(TvNavGroupDirective, {optional: true})` **does** cross a component
boundary (DI walks the element-injector tree via TNode ancestry), so each item found the group,
evaluated `items().indexOf(this) === activeIndex()` as `-1 === 0`, and pinned itself to
`tabindex="-1"` — actively removing every song title from the keyboard Tab order for **all** users
on **all** platforms, not just TV.

The fix inverts discovery: `TvNavItemDirective` calls `group.registerItem(this)` from its own
constructor and `unregisterItem` from a `DestroyRef.onDestroy` — using the one lookup that provably
crosses the boundary. This also removed the whole `forwardRef`/`QueryList`/`ngAfterContentInit`
apparatus (and with it the circular-import hazard the earlier `forwardRef` in the
`@ContentChildren` decorator existed to work around — there is no longer an eagerly-evaluated
decorator argument referencing `TvNavItemDirective`).

**`items()` sorts on read, not on registration** (measured, not assumed): registration order is
meaningless, because Angular instantiates directives in whatever order the create pass reaches them
and — critically — **the host element is not yet attached to the document at constructor time**
(`isConnected === false` for anything inside an `@for`/embedded view or a nested component), so
`compareDocumentPosition` there returns an arbitrary order. A first attempt that sorted inside
`registerItem` reversed every group and failed 12 of the directive's 18 existing tests. `items()` is
therefore a plain function that reads the registration signal (keeping it a reactive dependency for
the `tabIndex`/`effect` consumers) and derives document order at read time — the earliest point at
which the DOM is guaranteed live.

**The sort is memoized, and both halves of its invalidation are load-bearing.** A full re-sort on
every call is too expensive (each item's `tabIndex` computed calls `items()`, so it is O(n) reads per
change-detection pass), so the sorted array is cached. The cache is only _stored_ once every element
`isConnected` — which is why it cannot be a `computed()`, as that would memoize the first, detached,
wrong evaluation. And it is only _reused_ subject to two checks:

1. **`isInDomOrder` on read** — an O(n) adjacent-pair scan (sortedness is transitive under document
   order, so consecutive pairs suffice) verifying the cached array is still in document order.
   Keying the memo on the registration array's identity alone is **not** enough: a **pure reorder** —
   the same item set re-rendered in a new order — moves the views without any destroy/create, so
   nothing registers or unregisters and the identity never changes. This is a production path, not a
   hypothetical: `ListControlsService.filtered()` does a plain client-side `[...items()].sort(...)`
   whenever the user changes a Library grid's sort dropdown, and every one of those grids is an
   `appTvNavGroup` whose `@for` tracks by a stable id. Without the check, `items()` served the stale
   order forever.
2. **A `MutationObserver` on the group host (`childList`, deliberately _without_ `subtree`)** bumping
   a `domVersion` signal that `items()` also reads. `items()` being correct is not sufficient when
   nothing asks it again: a pure reorder writes to no signal, so the item `tabIndex` computeds never
   re-evaluate and the rendered roving `tabindex="0"` stays on the card that used to be first. Every
   current consumer repeats a _direct_ child of the group (an `<a>` card, an `<li>`, a `<button>`, an
   `<app-track-row>`), so omitting `subtree` catches every real reorder while ignoring the far
   noisier churn deeper inside a row; a future consumer that repeats something nested deeper degrades
   gracefully — `items()` still self-heals on read, so navigation stays correct and only the rendered
   `tabindex` could lag. The bump is unconditional rather than guarded on the cache still being
   stale, because `items()` self-heals and would otherwise silently repair the cache before the
   callback runs, hiding the very change it exists to report.

The directive spec's pure-reorder test drives exactly this (an `@for` over a signal, re-set to the
reversed order, asserting the _same_ element objects moved rather than being re-created), and
removing either half of the invalidation makes it fail in a different way.

**ARIA**: the group host is `role="grid"` on the `grid` axis and `role="toolbar"` otherwise;
`aria-orientation` only accepts `horizontal`/`vertical` per the ARIA spec, so it is bound to `null`
(omitted) on the grid axis rather than emitting an invalid `aria-orientation="grid"`.

**Test-quality note**: the Phase 3 consumer-page specs run with `NO_ERRORS_SCHEMA`, which renders an
unrecognised attribute into the DOM verbatim — so an assertion that only checks for the _presence_
of `appTvNavGroup`/`appTvNavItem` passes even if the directives were never imported. That gap is why
the bug above survived three task reviews. Each of `library`, `artist-detail` and `search` now
carries at least one **behavioral** test (focus the first item, dispatch a real `ArrowDown`/
`ArrowRight` `KeyboardEvent`, assert `document.activeElement` moved), and
`track-row.component.spec.ts` hosts two real `<app-track-row>` elements inside a real group to cover
the cross-component-boundary case itself — the five consumer page specs cannot, since the JIT
harness can't bind a nested component's signal inputs (see `src/testing/signal-input.ts`) and they
stub the rows out.

**Global keyboard shortcuts (Phase 2)**: `KeyboardShortcutsService`
(`packages/web/src/app/services/keyboard-shortcuts.service.ts`, initialized once from `App`) — so
far just Space/K toggle play/pause app-wide. Space is suppressed when a focused `<button>`/`<a>`
would otherwise handle it (native Space/Enter activation wins there — e.g. a focused queue row);
K has no such native meaning so it always works outside a text field. **The rest of the table now ships (Phase 5)**: `J`/`L` (previous/next track), `M` (toggle vocal
mute), `N` (open Now Playing), `ArrowLeft`/`ArrowRight` (seek ±10s), and `/` (navigate to Acquire).

Three guards make the arrow keys safe to own globally:

1. **Never on a modifier chord** — `handle()` bails immediately on
   `ctrlKey || metaKey || altKey`. Without it, `Alt+ArrowLeft`/`Alt+ArrowRight` (browser
   Back/Forward) matched the seek branch and were `preventDefault`'d, silently breaking history
   navigation app-wide, and `Ctrl+J`/`Ctrl+L`/`Ctrl+N`/`Cmd+M`/`Ctrl+K` each _also_ fired their
   player action because `event.key` for a modifier chord is still the bare letter. `Shift` is
   deliberately **not** in the guard (it only produces the uppercase `J`/`K`/`L`/`M`/`N` already
   handled, and `Shift+/` → `'?'`, which matches nothing).
2. **Never on a focused `<select>`** — a closed `<select>` changes its selected option on
   ArrowLeft/ArrowRight, a preventable default the seek branch would otherwise steal (there are
   `<select>`s in the Library sort dropdowns, Settings, Admin and the track-info sheet). The check
   is narrower than the Space branch's `isNativelyActivatable()` on purpose:
   `BUTTON`/`A`/`SUMMARY`/`role=button` have no arrow-key behaviour to protect, and excluding them
   would kill seeking for the very common case of a focused button.
3. **Never when a D-pad nav group already claimed the press** — `event.defaultPrevented`. Since
   `TvNavGroupDirective` `preventDefault`s **every key its axis navigates by, including one clamped
   at a group boundary** (see `tv-nav-group.directive.ts`), grid/list navigation and seeking never
   double-fire on the same arrow press — an edge press is a true no-op rather than an unexpected
   ±10s jump. A key the group's axis does _not_ navigate by (ArrowUp inside a `horizontal` group;
   ArrowUp at a grid's first row, where there is no row to jump to) stays un-prevented and reaches
   the global handler — neither is a seek key, so nothing leaks.
4. **Never on a TV build** (issue #387) — the seek branch returns before `preventDefault()` when
   `isTvBuild()`. On Android TV, the WebView's built-in D-pad **spatial focus navigation** is what
   moves focus between elements not covered by a nav group; `preventDefault()` on the keydown is
   exactly what cancels that focus move. This is why vertical D-pad movement always worked (ArrowUp/
   Down are never intercepted) while horizontal was dead across the whole Now Playing sheet — the
   transport row could never even be _entered_ horizontally. Seeking on TV stays available through
   the focused seek bar (a native `<input type="range">` consumes ArrowLeft/Right to scrub) and the
   remote's hardware media keys via MediaSession. Non-TV builds keep the seek shortcut unchanged.

**Hardware Back (issue #394)**: Android's Back button used to finish the activity from anywhere
(the observed TV behavior of "Back exits the app"). `BackButtonService`
(`services/native/back-button.service.ts`, initialized from `App`, `@capacitor/app` reached
through the Capacitor global so `@capacitor/*` stays out of the web bundle) now decides in priority
order: (1) the topmost registered overlay closes — a minimal LIFO `BackHandlerStack`
(`lib/back-handlers.ts`, pure + unit-tested) that Now Playing registers persistently
(karaoke-fullscreen exits first, then the sheet; state-checked so per-open pushes always sit above
it), and `TrackInfoService`/`MenuPanelComponent` push onto per-open; (2) any non-home route walks
`Location.back()`; (3) only at home with nothing open does `App.exitApp()` run.

**Escape shares the stack (issue #398)**: `BackButtonService.initialize()` also attaches one
document-level Escape listener (all platforms, `AbortController` teardown on destroy) that runs
`stack.handleBack()` — so Escape and hardware Back have identical topmost-first semantics, and one
press closes only the topmost overlay instead of every open modal's own `document:keydown.escape`
handler firing at once. Unlike Back it never falls through to navigation: Escape means "close",
not "go back" (an empty stack leaves the event untouched, and an event something downstream
already `preventDefault`-ed is skipped). The 8 per-component handlers migrated onto it in two
shapes: modals rendered under an `@if` (confirm-dialog, changelog, album-hunt, metadata-fix,
artist-genre, artist-identity) — where component lifetime IS open lifetime — call the
`registerOverlayCloser(close)` helper (exported from `back-button.service.ts`: stack push in the
constructor, `DestroyRef` unregister) once; overlays that outlive their open state (MenuPanel,
the artist-image album picker) keep managing their registration per open/close. The library
playlist-rename input keeps its element-scoped Escape (cancel-the-rename is caret-local, not an
overlay) but now `preventDefault`s so the global listener never also closes an overlay behind it.

**Deliberately not built**: `Escape`-as-back (would need to arbitrate against 7+ existing per-component modal Escape
handlers with no current shared "is a modal open" signal — real, separate work) and any
volume shortcut (this app has no volume-level control to wire one to).

**Phase 3/4 final-review follow-ups (issues #356-#359), resolved**:

- **Perf (#357)**: `TvNavGroupDirective.indexOf(item)` is now O(1) — the memoized sort keeps an
  `item→index` `Map` in lockstep with `this.sorted`, rebuilt only when the sort itself is
  recomputed. Wrapping `items()` itself in a real `computed()` (which would have collapsed its
  n-per-keypress re-invocations to one) was tried and **reverted**: it broke the pure-reorder
  correctness test, since a `computed()` only re-runs when a tracked signal's value changes, and a
  pure `@for` reorder changes neither `itemsSignal` nor `domVersion` synchronously (the
  `MutationObserver` bump is async) — `computed()` kept serving the pre-reorder answer until a
  later microtask. The `isInDomOrder` O(n)-per-read scan therefore still runs on every `items()`
  call; only the `indexOf` half of the issue was safely fixable.
- **Desync (#358)**: both axes now resolve "where focus currently is" for a keydown from the
  event's own origin item (`originIndex`, shared by the vertical/horizontal and grid branches),
  rather than the grid axis deriving it from the event target while vertical/horizontal read
  `activeIndex()` directly. `activeIndex.set(next)` still runs from the resolved origin, so a
  post-reorder desync self-corrects on the very next keypress with no separate resync path needed.
- **ARIA grid conformance (#359)**: `role="grid"` axis groups now get real `role="row"`/`role="gridcell"`
  descendants (WAI-ARIA's grid role requires them). A directive-side fix — reparenting
  already-rendered items into synthetic wrapper elements via `Renderer2` — was prototyped and
  **rejected**: verified with a real TestBed reproduction that moving an `@for`-rendered node into a
  wrapper div, then mutating the underlying array, leaves Angular's own reconciliation silently
  stale (no exception, just a DOM that stops reflecting the model — confirmed on both add and
  remove). The shipped fix is template-level instead: `TvNavGroupDirective` exposes a `gridColumns`
  signal (`lib/tv-nav-grid.ts`'s `gridColumnCount`, reading the container's own resolved
  `grid-template-columns` via `ResizeObserver`, independent of any already-rendered item — sidesteps
  `inferColumnsPerRow`'s chicken/egg problem of needing already-laid-out items to infer columns from);
  every `axis="grid"` template chunks its flat item array with the new `chunk()` helper and renders
  one `role="row"` `display:contents` wrapper per chunk, so Angular owns the wrapper structure from
  the start like any other view. The one exception is Admin's processing-task list
  (`class="space-y-2"`, not a CSS grid at all — each task's run+gate pair is already one wrapper
  `<div>` per `@for` iteration, so it just gets `role="row"` directly with no `chunk()` involved).
- **Queue Remove reachability (#356)**: `TvNavGroupDirective` now supports **nested child groups** —
  a group with no parent behaves exactly as before, but a group whose ancestor is itself a
  `TvNavGroupDirective` registers as that ancestor's child (mirroring how a `TvNavItemDirective`
  registers with its nearest group) via `parentGroup`/`registerChildGroup`. The Now Playing queue's
  row wrapper is now `axis="horizontal"` (`[jump, remove]`), nested inside the queue's
  `axis="vertical"` rows group: ArrowRight from the jump button reaches Remove (handled entirely by
  the inner group, unchanged from a plain 2-item group); ArrowDown/Up move between rows, handled by
  the OUTER group. **Mixed containers (issue #389)**: a group's direct `items()` and its
  `childGroups()` are now navigated as ONE DOM-ordered sequence (`mergedEntries()`, a linear
  two-pointer merge of the two already-sorted arrays) — the old model's early-return that made a
  group with any child groups ignore its own direct items is gone, which is what lets the TV Now
  Playing root own a close button, the nested transport group, and a radio button in one sweep.
  Landing on an entry dispatches polymorphically: `item.focusElement()` vs
  `group.focusActiveItem()` (now recursive through nested groups). Only one item across the whole
  nested tree may hold `tabindex="0"` at a time (a roving-tabindex composite has exactly one Tab
  stop) — the `activeKind` signal (`'item' | 'group'`, defaulting to the first merged entry's kind
  until real focus lands) discriminates which side of a mixed container owns the stop:
  `TvNavItemDirective.tabIndex` gates on `directItemsActive()` (active child AND kind `item`), and
  a child group's `isActiveChild` requires kind `group` — both kept in sync purely through the
  real-focus `notifyFocused` → `notifyActiveChildGroup` chain (which now bubbles to every
  ancestor), never written from keydown handling directly. Grid-axis groups with child groups
  deliberately do not navigate (no current need, unchanged).

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
  keystore, runs `./gradlew assembleRelease`, renames Gradle's bare `app-release.apk` to the
  versioned `NicotinD-<version>.apk` (via `$NICOTIND_VERSION_NAME`, for naming cohesion with the
  desktop assets), then repeats the web-build → `cap sync` → `assembleRelease` sequence with the
  Angular **`tv` configuration** to produce `NicotinD-TV-<version>.apk` (the flavor that actually
  carries `tvBuild:true` — before issue #387 the tv config was never built by CI, so no released
  APK ever had TV behavior). Both staged APKs are
  attached to the GitHub Release for the version tag. The two share one `applicationId`/signature —
  install `NicotinD-TV-*.apk` on TVs, the plain one on phones; installing the wrong flavor silently
  swaps TV behavior. Required repo secrets:
  `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
  (until they're set, the job builds an unsigned APK / fails loudly — it never ships a broken keystore).

## Self-update from GitHub releases (Android + TV)

The sideloaded APK has no store channel, so the app updates **itself**: Settings → Account →
**Check for updates** (the same button the PWA uses; `UpdateService.enabled` is true on the native
Android shell even without a service worker). The native check fetches
`api.github.com/…/releases/latest` directly (unauthenticated, CORS-open; the same endpoint the
server's daily update-check polls) and compares the tag against the build's `APP_VERSION` via the
shared `compareVersions` — moved to `@nicotind/core` (`version.ts`) so the server and web use one
implementation, re-exported through the web's browser-safe `types/core.ts` shim. On "available" the
toast offers **Install** (not the PWA's Reload): `applyUpdate()` hands the
`@nicotind/capacitor-apk-update` plugin (`packages/capacitor-apk-update/`, the tv-channels plugin
shape — Android-only, reached via the `Capacitor.Plugins.NicotindApkUpdate` global) the
flavor-matched asset URL — `NicotinD-TV-<v>.apk` when `isTvUi()`, `NicotinD-<v>.apk` otherwise
(pure `lib/apk-update.ts`, asset names locked to what deploy.yml attaches). The plugin streams the
download to the app cache on its own thread (progress events → a `settings-update-progress` line),
then opens the system installer through the app FileProvider (`ACTION_VIEW` +
`application/vnd.android.package-archive`; manifest carries `REQUEST_INSTALL_PACKAGES`, and the
manifest test pins both the permission and the FileProvider `<cache-path>` it depends on). Android's
one-time **"install unknown apps"** prompt appears on first use with a direct Settings deep-link —
D-pad navigable on TV. The final accept and the **signature check are the system's**: CI signs every
release with the one stable keystore from repo secrets, so release→release updates install cleanly;
a locally-built debug APK updating onto a CI release (or vice versa) is rejected as a package
conflict — that's Android working as intended, not a bug. Verified on the google-tv emulator
end-to-end against the live v0.1.306 release: version toast → real CDN download → unknown-apps
prompt → installer "Do you want to update this app?". Note the flow only exists **from** builds that
carry it — the first release with this feature must still be sideloaded manually once.

### `@capacitor/barcode-scanner` build requirements (root `build.gradle` + `variables.gradle`)

The QR device-pairing plugin (`@capacitor/barcode-scanner`) pulls its native lib
`com.github.outsystems:osbarcode-android` — and building it needs two things that broke the
`android` release job when the plugin first landed (v0.1.222):

- **An extra Maven repo.** Despite the `com.github.*` group name, osbarcode is **not** on JitPack,
  Google, or Maven Central — it lives on OutSystems' **Azure Artifacts** public feed. The plugin
  declares that repo in _its own_ `build.gradle`, but a subproject's repositories are **not**
  consulted when `:app` resolves its transitive runtime classpath — only the root `allprojects`
  repos are. So `android/build.gradle`'s `allprojects.repositories` must mirror it (scoped with
  `content { includeGroup 'com.github.outsystems' }` so nothing else routes through Azure).
- **`minSdkVersion = 26`.** osbarcode declares `minSdk 26`; with the Capacitor default of 22 the
  manifest merger fails (_"minSdkVersion 22 cannot be smaller than version 26"_). Bumped in
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
