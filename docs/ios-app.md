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
- **App Transport Security (ATS)**: iOS blocks plain-`http://` requests by
  default. We expect users to point the app at an **HTTPS** self-hosted server
  (the default is HTTPS). Only add an `NSAppTransportSecurity` exception if a
  plain-HTTP server must be supported — document it then, don't pre-weaken ATS.
- **iOS app icon + splash**: the branded AppIcon **and launch/splash screen** are
  generated **in CI** from the committed `packages/mobile/assets/` brand sources
  (`bunx @capacitor/assets generate --ios`), because the ephemeral `ios/` project
  would otherwise ship Capacitor's default bolt. Source of truth + Android
  equivalent: see [mobile-app.md](./mobile-app.md) "App icon & splash screen".

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

**Fix — a minimal native plugin (`@nicotind/capacitor-now-playing`).** Swift
`NowPlayingPlugin` (`packages/capacitor-now-playing/ios/`) sets
`MPNowPlayingInfoCenter.default().nowPlayingInfo` directly. Scope is deliberately
narrow:

- **It owns the displayed *info*** — title / artist / album / artwork / duration
  / elapsed time / `playbackState`. Artwork is fetched natively from the app's
  `/api/cover/...?token=` URL (auth via query param, no headers needed).
- **It does NOT own transport controls.** Play/pause/next/prev/seek stay on the
  Web Media Session path (`setActionHandler`), which already works on iOS — so the
  plugin registers **no** `MPRemoteCommandCenter` handlers and cannot fight
  WKWebView's own.

**Wiring.** `MediaControlsService` (`packages/web`) routes `setMetadata` /
`setPlaybackState` / `setPositionState` to the native plugin **only when
`isIosNative()`** (`lib/platform.ts`), reaching it through the injected
`Capacitor.Plugins.NicotindNowPlaying` global — so the web bundle gains **no**
`@capacitor/core` import. The metadata mapping (`toNativeMetadata` /
`pickArtworkUrl`, which picks the largest declared artwork size) is pure and unit
-tested in `lib/now-playing.spec.ts`; platform detection in `lib/platform.spec.ts`;
the iOS routing in `services/media-controls.service.spec.ts`. Android and the web
are unchanged (still `@jofr`); if the native plugin is missing the service falls
back to `@jofr` with no regression.

**Build/CI.** The plugin is a workspace dependency of `@nicotind/mobile`, so
`cap sync ios` discovers it (via the `capacitor.ios.src` marker +
`NicotindNowPlaying.podspec`) and `pod install` adds it to the ephemeral `ios/`
project — **no `deploy.yml` change**. The Swift compiles in the macOS `ios` job
(`xcodebuild`), the build-level gate.

**Open validation (on-device).** WKWebView may re-assert its *own* now-playing
session and blank our fields; the plugin counters this by re-pushing the **full**
info dictionary on every update, and the player's ~2 s position tick keeps it
sticky. Whether that's sufficient — and whether artwork loads under ATS — must be
confirmed on a real device (see checklist).

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
package `Payload/App.app` into `NicotinD-unsigned.ipa` → attach to the Release.
A failure here does **not** block the server deploy.

> **Cost:** GitHub-hosted `macos-*` runners bill at ~10× the Linux minute rate.
> The job is bounded to releases (same gate as `deploy`), but it is a real new
> line item.

## Open prerequisites checklist

- [ ] Apple Developer Program account ($99/yr) — for any signed install / TestFlight / App Store.
- [ ] Signing secrets in the repo (certificate, provisioning profile, App Store Connect API key) — then flip the CI build to signed.
- [ ] A Mac to generate + **commit** the `ios/` project (durable native config) — replaces the ephemeral-generate path.
- [x] **On-device test of background audio** — confirmed working (backgrounded playback continues).
- [ ] **On-device test of the Now Playing card** — confirm the native `MPNowPlayingInfoCenter` plugin shows title/artist/album + artwork + the position scrubber, and that WKWebView doesn't overwrite it (the re-push-on-update mitigation holds). Confirm artwork loads (ATS / HTTPS server).
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
  service-level routing in `services/media-controls.service.spec.ts` (on iOS,
  `setMetadata`/`setPlaybackState`/`setPositionState` hit the native plugin with
  mapped args; invalid positions are dropped). These run in the web `ci` job
  (`vitest run`). The Swift `NowPlayingPlugin` itself has no unit test — it is
  build-gated by the macOS `ios` job and validated on-device (above).
- The above (non-Swift) run in the CI `ci` job (`bun test … packages/mobile/src`,
  the API test glob, and the web `vitest run`). The `ios` build job is the
  build-level gate (analogous to Android's `assembleRelease`); like Android there
  is **no device/simulator test in CI** — on-device validation of the Now Playing
  card is a documented manual gate.
