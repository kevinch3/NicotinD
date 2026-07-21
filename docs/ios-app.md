# iOS app — feasibility assessment & integration

This document records the feasibility assessment and integration approach for an
**iOS** build of NicotinD, the sibling of the shipped [Android app](mobile-app.md).
It exists so the decision, the new requirements iOS imposes, and the tradeoffs we
accepted are not lost. It is the index entry's deep-dive (see CLAUDE.md → "Mobile
app").

## Verdict

**Feasible, low code risk.** The Android effort already built the entire
native-enablement layer in a platform-neutral way, so iOS reuses it almost
verbatim. The real cost and risk are concentrated in **distribution, signing,
macOS CI, and on-device validation — not the app code.**

## What is already reusable, unchanged

iOS uses the *same* Capacitor shell (`packages/mobile`) wrapping the *same*
`@nicotind/web` Angular build. Everything below was written for Android but is
platform-agnostic and works on iOS with no change:

- **Platform detection** — `lib/platform.ts` `isNativePlatform()` reads
  Capacitor's injected global (no `@capacitor/core` dep in the web bundle), true
  on iOS too.
- **Runtime server config + picker** — `ServerConfigService`
  (`apiUrl()`/`wsUrl()`), the server-picker page (`pages/server-config/`),
  `serverGuard`, the `authInterceptor` rewrite, the service-worker-off-on-native
  path, and every direct `apiUrl()`/`wsUrl()` call site.
- **CORS** — `nativeAppCors()` (`packages/api/src/middleware/cors.ts`) **already
  allow-lists `capacitor://localhost`**, the iOS WKWebView origin, and exposes
  the `Content-Range`/`Accept-Ranges`/`Content-Length` headers for 206 range
  streaming. **No API change was needed** (only a comment + a test assertion).
- **Background audio + lock-screen controls** — `MediaControlsService` +
  `buildMediaMetadata` wrap `@jofr/capacitor-media-session`; on iOS the plugin is
  a thin wrapper over the Web Media Session API (WKWebView supports it on
  iOS 16.4+). Same code path.
- **Versioning** — the monorepo semver drives the app version. `iosVersion()`
  (`packages/mobile/src/version.ts`) reuses the shared monotonic integer scheme
  to produce `CFBundleShortVersionString` + `CFBundleVersion`, exactly as
  `androidVersion()` does for Android.

## New requirements iOS introduces

- **Apple Developer Program ($99/yr)** for *any* non-jailbreak signed install,
  TestFlight, or App Store. We do not have one yet — see distribution below.
- **macOS runner + Xcode + CocoaPods** for builds. `cap add ios` and `xcodebuild`
  cannot run on Linux, so the maintainer's Linux host cannot generate or build
  the iOS project; CI does it on a `macos-14` runner.
- **`UIBackgroundModes: [audio]` in `Info.plist`** for background playback.
  Because the `ios/` project is generated ephemerally (below), this is injected
  by `scripts/ios-plist.ts` rather than hand-edited in a committed plist.
- **`NSCameraUsageDescription` in `Info.plist`** for the QR device-pairing
  scanner (`@capacitor/barcode-scanner` — see
  [device-pairing.md](./device-pairing.md)); injected by the same
  `scripts/ios-plist.ts` patch. Without it iOS terminates the app on first
  camera access.
- **App Transport Security (ATS)**: iOS blocks plain-`http://` requests by
  default. We expect users to point the app at an **HTTPS** self-hosted server
  (the default is HTTPS). Only add an `NSAppTransportSecurity` exception if a
  plain-HTTP server must be supported — document it then, don't pre-weaken ATS.
- **iOS app icon + splash**: the branded AppIcon **and launch/splash screen** are
  generated **in CI** from the committed `packages/mobile/assets/` brand sources
  (`bunx @capacitor/assets generate --ios`), because the ephemeral `ios/` project
  would otherwise ship Capacitor's default bolt. Source of truth + Android
  equivalent: see [mobile-app.md](./mobile-app.md) "App icon & splash screen".

## OAuth login (proposed — not yet implemented)

Google + Microsoft OAuth login is **proposed** for NicotinD with full mobile
parity, including iOS. The complete design lives in
[oauth-auth.md](oauth-auth.md); this section covers the iOS-specific parts.

The iOS app uses the same Capacitor shell (`packages/mobile`) as Android, so
the OAuth deep-link handoff (**`nicotind://auth-callback#token=…`**) works
identically on both. The only iOS-specific addition is:

- **`CFBundleURLTypes` for the `nicotind` URL scheme** in `Info.plist`. Because
  `ios/` is generated ephemerally (no committed project — see below), this is
  injected by `scripts/ios-plist.ts` at build time, not hand-edited. The script
  already patches `UIBackgroundModes` and version keys; the OAuth scheme is one
  more `PlistBuddy` entry.

No macOS CI test job is added for OAuth — the deep-link is a config/plist
declaration, not code that compiles, and the token-handling JS lives in the
web bundle (unit-tested via vitest, same as the existing Now Playing routing
tests). On-device validation is the gate: tap "Sign in with Google" from the
iOS app → system browser opens → consent → app receives the deep link → lands in
the authenticated state.

## The macOS / "no committed `ios/`" constraint

Android committed a hand-generated `android/` Gradle tree. We **cannot** mirror
that for iOS on a Linux host, so the CI `ios` job **generates `ios/` ephemerally
each run** (`bunx cap add ios` → `cap sync ios`) and patches `Info.plist` with a
script. Tradeoff: native config does not persist in git and is not reviewable in
a PR.

**Upgrade path (when a Mac is available):** generate and **commit** `ios/`
(mirroring `android/`), move the `UIBackgroundModes`/version edits into the
committed `Info.plist`, and drop the generate-on-the-fly + plist-patch CI steps.
At that point the iOS job collapses to `cap sync ios` + `xcodebuild`, just like
Android's `cap sync android` + `gradlew`.

## Distribution — tradeoffs and the chosen path

iOS has **no free-sideload equivalent** to Android's "attach an APK to a GitHub
Release and install it." Options considered:

| Option | Apple acct | Review | Notes |
|---|---|---|---|
| **App Store (public)** | Required | Full review | High rejection risk for a Soulseek/P2P-acquisition app (even with acquisition default-off). Most work, most scrutiny. |
| **TestFlight** | Required | Review for external testers | 90-day build expiry; 10k external tester cap. Realistic for trusted self-hosters. |
| **Ad-hoc / unsigned IPA** ✅ | Not required (unsigned) | None | Attach `.ipa` to the GitHub Release; users install via AltStore/Sideloadly (re-signs with their own Apple ID: 7-day expiry on a free ID, 1 year on a paid dev account) or registered-UDID ad-hoc (≤100 devices/yr). |
| Jailbreak-only | No | None | Out of scope. |

**Chosen: ad-hoc / unsigned IPA.** Rationale: no Apple account yet, fastest path,
and acceptable for a self-hosted power-user audience who already sideload the
Android APK. The CI build is **unsigned** (`CODE_SIGNING_ALLOWED=NO`); the `.ipa`
is install-ready only through AltStore/Sideloadly, which re-sign on-device.

When an Apple account is acquired, the same CI job upgrades to a signed build by
swapping `CODE_SIGNING_ALLOWED=NO` for a signing certificate, provisioning
profile, and App Store Connect API key (mirroring how `ANDROID_KEYSTORE_*` secrets
are wired into the `android` job), and optionally adding a TestFlight upload step.

## Safe-area / notch (sticky header)

On the iOS build the sticky top header sat **under** the status bar / notch —
content reached the very top with no safe-area gap. Two changes fix it, both
universal (no-ops where there's no notch):

- `index.html` viewport meta gains `viewport-fit=cover` — required for
  `env(safe-area-inset-*)` to be non-zero on notched iOS (on desktop / non-notched
  it stays 0).
- the header (`layout.component.html`) folds the inset into its top padding:
  `pt-[calc(0.75rem+env(safe-area-inset-top))]` (`0.75rem` = the old `py-3` top).
  The header background extends up behind the status bar; its content sits below
  the notch. Mirrors the existing bottom chrome (`env(safe-area-inset-bottom)` on
  the player / bottom-nav).

Web is provably unchanged (the header `padding-top` resolves to `12px`, asserted
in `packages/e2e/tests/mobile-ux.spec.ts`). **On-device top positioning is a
manual gate**; if `contentInset: 'always'` (capacitor.config) double-counts the
top inset, switch iOS `contentInset` to `'never'` so CSS `env()` is the single
source of truth. See [web-ui.md](web-ui.md) "Safe-area header".

## iOS Now Playing (lock-screen / Control Center card)

**Problem.** `@jofr/capacitor-media-session` ships **no iOS native code** — the
package contains only `android/` (a real native plugin) and `dist/` (web). So on
iOS, Capacitor falls back to the **web** implementation, which is literally
`navigator.mediaSession.metadata = new MediaMetadata(...)` / `setPositionState(...)`
inside WKWebView. There is **no bridge to `MPNowPlayingInfoCenter`**. WKWebView
auto-wires play/pause to the actively-playing `<audio>` element (so transport
controls appear), but it does **not** reliably surface JS-set
metadata/artwork/position for **cross-origin** web audio. Net effect on device:
the system player showed play/pause + state but **no title/artist, no thumbnail,
no scrubber/time**.

**Root cause (why the first attempt never worked).** The plugin's *original*
design set `nowPlayingInfo` but registered **no** `MPRemoteCommandCenter` target
and **never activated an `AVAudioSession`** — on the theory that WKWebView keeps
owning transport and we only "add" the display info. That can't work: iOS only
*displays* `nowPlayingInfo` for the app that **owns** the now-playing session,
and ownership requires an active audio session **plus** at least one registered
remote command. WKWebView has both for its `<audio>` element, so the system kept
reading WebKit's (metadata-less, cross-origin) session and the card stayed blank.
The "re-push the full dict on every update" mitigation was racing a contest we'd
never entered.

**Fix — the native plugin (`@nicotind/capacitor-now-playing`) takes ownership.**
Swift `NowPlayingPlugin` (`packages/capacitor-now-playing/ios/`):

- **Owns the displayed *info*** — title / artist / album / artwork / duration /
  elapsed / `playbackState` via `MPNowPlayingInfoCenter`. Artwork is fetched
  natively from the app's absolute `https://…/api/cover/...?token=` URL (auth via
  query param, no headers); failures emit an `artworkError` event for diagnosis.
- **Owns transport.** On first playback it activates `AVAudioSession(.playback)`
  (`ensureSession`, idempotent, lazy) and registers the lock-screen commands
  (`registerCommands`: play/pause/next/prev/`changePlaybackPosition`), each
  forwarding a single `remoteCommand` event (`{ action, seekTime? }`) to JS. This
  is what makes us the system now-playing app so the card actually renders.

**Transport-ownership flip.** Because the plugin now owns
`MPRemoteCommandCenter`, the web layer **must not** also wire WKWebView's Web
Media Session `setActionHandler` on iOS — doing both fires every lock-screen
action **twice**. So `MediaControlsService.setActionHandler` branches on
`isIosNative()`: on iOS it stores handlers in a `Map<MediaAction, …>` and attaches
**one** `addListener('remoteCommand', …)` that dispatches to them; web/Android
keep the unchanged `@jofr` path. `player.component.ts` is untouched (its Effect 4
already wraps handlers in `zone.run`).

**Wiring.** `MediaControlsService` (`packages/web`) routes `setMetadata` /
`setPlaybackState` / `setPositionState` to the native plugin **only when
`isIosNative()`** (`lib/platform.ts`), reaching it through the injected
`Capacitor.Plugins.NicotindNowPlaying` global — so the web bundle gains **no**
`@capacitor/core` import. The metadata mapping (`toNativeMetadata` /
`pickArtworkUrl`, which picks the largest declared artwork size) is pure and unit
-tested in `lib/now-playing.spec.ts`; platform detection in `lib/platform.spec.ts`;
the iOS routing + transport dispatch in `services/media-controls.service.spec.ts`.
Android and the web are unchanged (still `@jofr`); if the native plugin is missing,
*info* falls back to `@jofr` with no regression (transport simply no-ops on iOS
until the plugin ships — we deliberately do **not** fall back to `@jofr` transport
to avoid the double-fire).

**Build/CI.** The plugin is a workspace dependency of `@nicotind/mobile`, so
`cap sync ios` discovers it (via the `capacitor.ios.src` marker +
`NicotindCapacitorNowPlaying.podspec` — the podspec filename and `s.name` **must**
match the pod name Capacitor derives from the package name
`@nicotind/capacitor-now-playing` → `NicotindCapacitorNowPlaying`, or `pod install`
fails with "No podspec found") and `pod install` adds it to the ephemeral `ios/`
project — **no `deploy.yml` change**. The Swift compiles in the macOS `ios` job
(`xcodebuild`), the build-level gate.

**Verification — on-device diagnostics panel (no macOS CI).** Swift can't be
unit-tested on the Linux dev host, and we deliberately did **not** add a macOS
test job (cost). Instead the plugin exposes `getDiagnostics()` and the
**Settings → "Now Playing (iOS)"** panel (rendered only when `isIosNative()`,
`data-testid="now-playing-diagnostics"`) reads it back: is the plugin
registered? is the `AVAudioSession` configured + which category? are the commands
registered? how many `nowPlayingInfo` keys are populated? what was the last
artwork outcome? This turns the manual gate from "stare at the lock screen and
guess" into a structured self-check. The plugin also `print`s
`NICOTIND_NOWPLAYING_LOADED` in `load()` so registration is visible in Console.app.

To validate on device: play a track → open the panel → expect `pluginRegistered:
true`, `commandsRegistered: true`, `audioCategory: playback`, several
now-playing keys, `artwork: ok`. Then lock the screen and confirm the card shows
title/artist/artwork/scrubber and that play/pause/next/seek each fire **once**.
**Crucially, confirm background audio still plays** after the `AVAudioSession`
change — activating our session is the one residual regression risk that only a
device can rule out (mitigated: we use `.playback`, activate lazily on first
play, and only `setActive(false)` in `clear()`).

**Interruption recovery (lost ownership without symptoms).** `sessionConfigured`
/`commandsRegistered` are one-shot latches — `ensureSession`/`registerCommands`
no-op forever once they've run once. That's a problem because an interruption
(phone call, Siri, another app starting audio, a route change) deactivates our
`AVAudioSession` system-side with **no callback** other than
`AVAudioSession.interruptionNotification`; ownership of the now-playing slot then
silently passes to whatever else is holding an active session, while the latches
keep reporting `sessionConfigured: true` / `commandsRegistered: true` in
`getDiagnostics()` — i.e. the panel can look fully healthy (`isOtherAudioPlaying:
true` is the tell) while the lock-screen card belongs to another app. The plugin
now observes `AVAudioSession.interruptionNotification` in `load()` and, on
`.ended`, resets both latches and re-runs `ensureSession()` / `registerCommands()`
/ `apply()` to reclaim the session and re-push the existing `nowPlayingInfo`.

## Background-audio risk (resolved on-device)

Android **guarantees** background audio via the plugin's native media-playback
foreground service. **iOS was the unknown:** the `@jofr` plugin's iOS path is a
Web Media Session *wrapper*, not a foreground service, so backgrounded playback
relies on WKWebView honoring `UIBackgroundModes: [audio]` with an actively-playing
element. **This has now been confirmed working on a real device** — backgrounded
playback continues. The remaining iOS media gap was the *Now Playing card content*
(metadata/artwork/time), addressed by the native plugin above. If WKWebView ever
suspends audio in a future iOS, the fallback is a dedicated native-audio Capacitor
plugin (larger effort).

## Capacitor version

Stay pinned to **Capacitor 6** across both platforms — it matches Android and
`@jofr/capacitor-media-session@4`'s supported major. Do not split majors across
platforms. Revisit alongside the Android pin if/when the media-session plugin
ships Capacitor 7+ support.

## CI job

`.github/workflows/deploy.yml` → `ios` job (`runs-on: macos-14`), gated and
parallelized exactly like `android`/`deploy` (`workflow_dispatch` or a
`chore(release):` commit). Steps: build web → `cap add ios`/`cap sync ios` →
generate the branded AppIcon (`bunx @capacitor/assets generate --ios`, from the
committed `assets/` sources) → derive version (`scripts/ios-env.ts` →
`$GITHUB_ENV`) → patch Info.plist (`scripts/ios-plist.ts`) → `xcodebuild …
CODE_SIGNING_ALLOWED=NO build` →
package `Payload/App.app` into the versioned `NicotinD-<version>-unsigned.ipa`
(via `$NICOTIND_IOS_SHORT_VERSION`, for naming cohesion with the desktop/Android assets) → attach
to the Release. A failure here does **not** block the server deploy.

> **Cost:** GitHub-hosted `macos-*` runners bill at ~10× the Linux minute rate.
> The job is bounded to releases (same gate as `deploy`), but it is a real new
> line item.

## Open prerequisites checklist

- [ ] Apple Developer Program account ($99/yr) — for any signed install / TestFlight / App Store.
- [ ] Signing secrets in the repo (certificate, provisioning profile, App Store Connect API key) — then flip the CI build to signed.
- [ ] A Mac to generate + **commit** the `ios/` project (durable native config) — replaces the ephemeral-generate path.
- [x] **On-device test of background audio** — confirmed working (backgrounded playback continues).
- [ ] **On-device test of the Now Playing card** — with the plugin now owning the `AVAudioSession` + `MPRemoteCommandCenter`: confirm the card shows title/artist/album + artwork + scrubber, lock-screen transport fires **once** per press, artwork loads (ATS / HTTPS), **and background audio still plays**. Use the Settings → "Now Playing (iOS)" diagnostics panel to read back plugin/session/command/artwork state.
- [x] iOS app icon + launch/splash screen (branded, generated in CI from the shared brand mark).

## Tests / quality gates

- `iosVersion()` is unit-tested in `packages/mobile/src/version.test.ts` (mirrors
  `androidVersion`, asserts the shared monotonic scheme).
- `buildPlistBuddyCommands()` is unit-tested in
  `packages/mobile/src/ios-plist.test.ts` (the pure logic behind the plist patch).
- `nativeAppCors()` has an explicit `capacitor://localhost` assertion in
  `packages/api/src/middleware/cors.test.ts`.
- **iOS Now Playing** (the native-plugin routing): the pure metadata mapping is
  tested in `packages/web/src/app/lib/now-playing.spec.ts` (`pickArtworkUrl`
  picks the largest size; `toNativeMetadata` mapping), platform detection in
  `lib/platform.spec.ts` (`isIosNative`/`getCapacitorPlugin`), and the
  service-level routing + **transport dispatch** in
  `services/media-controls.service.spec.ts` (on iOS, `setMetadata`/
  `setPlaybackState`/`setPositionState` hit the native plugin with mapped args;
  invalid positions are dropped; `setActionHandler` routes through a single
  `remoteCommand` listener and **not** `@jofr`, each action dispatches to its own
  handler with `seekTime` only for `seekto`; `getDiagnostics` passes through). These
  run in the web `ci` job (`vitest run`).
- **The Swift `NowPlayingPlugin` itself has no automated test** — Swift can't run
  on the Linux dev host and we chose not to add a macOS CI test job (cost). This
  is a conscious exception to the "every test runs in CI" gate; the substitute
  native-verification mechanism is the **on-device diagnostics panel**
  (Settings → "Now Playing (iOS)", backed by `getDiagnostics()`), documented above.
  The Swift is still build-gated by the macOS `ios` job (`xcodebuild`).
