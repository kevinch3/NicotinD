# Proposal: a native mobile + TV client (Kotlin Multiplatform core, native UIs)

**Status:** proposed, NOT built — decision record, 2026-09-30. Nothing here ships: no repo, no
package, no dependency. Read it when the question "should phones and TVs leave Capacitor?" comes
back.

**Decision if we go:** a separate, isolated repository under a **codename** (the product name is
pending legal's naming strategy), built as a **Kotlin Multiplatform (KMP) shared core** with a
**native UI per platform** — Jetpack Compose (+ Compose for TV) on Android, SwiftUI on iOS (+ tvOS).

**Why not now:** the desktop app. Electron loads the *same* Angular build the phones and TVs do
(`packages/desktop/electron/main.ts:59`, backend sidecar serves `NICOTIND_WEB_DIST`), so the Angular
SPA must stay alive for desktop and the browser regardless. Starting a native client today means
running three UI stacks (Angular, Compose, SwiftUI) for one small team. Revisit when one of the
[triggers](#when-to-revisit) below fires.

## Alternatives considered

| Approach | Phone | Android TV | Apple TV | Feel | UI codebases |
| --- | --- | --- | --- | --- | --- |
| **KMP core + native UI (chosen)** | ✅ | ✅ Compose for TV | ✅ SwiftUI | fully native | 2 thin, 1 shared core |
| React Native (Expo) + `react-native-tvos` | ✅ | ✅ | ✅ | native widgets, JS logic | 1 |
| Compose Multiplatform (Kotlin UI on iOS) | ✅ | ✅ | ❌ no tvOS | Skia-drawn on iOS | 1 |
| Flutter | ✅ | ⚠️ hand-rolled D-pad focus | ❌ no official tvOS | engine-drawn | 1 |
| Pure native, nothing shared | ✅ | ✅ | ✅ | fully native | 2 full apps |
| Stay on Angular + Capacitor (today) | ✅ | ✅ via WebView workarounds | ❌ | WebView | 1 (shared with web) |

The deciding argument: in a music player the platform-specific parts are **not the UI** — they are
background audio, lock-screen/media-session, TV launcher rows, voice search and offline files. Those
are native under *every* option (today they are three hand-written Capacitor plugins plus
`@capgo/capacitor-media-session`). What is worth sharing is the **logic** (API client, auth, queue
state, offline cache, sync); what is worth keeping native is the **player and the screens**. KMP
splits exactly on that line, and it is the only option with first-class focus handling on *both*
TV platforms.

## Shape of the isolated project

```
<codename>/
  shared/        KMP: Ktor client, kotlinx.serialization DTOs, auth + token store,
                 queue/playback state machine, offline cache (SQLDelight), remote-playback WS
  androidApp/    Compose; `phone` + `tv` flavors (androidx.tv), Media3 MediaSessionService
  iosApp/        SwiftUI; iOS + tvOS targets, AVPlayer, MPNowPlayingInfoCenter
```

It talks to NicotinD only over the public HTTP API — JWT bearer auth, OAuth via the existing
`nicotind://auth-callback` redirect ([oauth-auth.md](oauth-auth.md)), device pairing
([device-pairing.md](device-pairing.md)), the `/api/ws/playback` socket
([remote-playback.md](remote-playback.md)). No monorepo coupling; its own CI, its own release
cadence. Scope is a **listening** client — library, search, radio, queue, remote output, offline.
Admin, curation, acquisition and settings stay in the web/desktop app.

## Estimated performance gains

**These are estimates, not measurements.** They come from typical WebView-vs-native behaviour on
comparable apps, anchored where possible to numbers this repo already records. The first task of
any go decision is to **measure the baseline on the real devices** (Android Macrobenchmark for cold
start / frame timing, `dumpsys meminfo` for RSS, Xcode Instruments on iOS).

| Metric | Today (Capacitor) | Native estimate | Where the gain comes from |
| --- | --- | --- | --- |
| Cold start to interactive, mid-range Android TV | ~1.5–3 s | ~0.4–0.8 s | no WebView process spin-up, no parse/eval of ~2.1 MB of JS chunks (largest 351 KB) before first paint |
| Resident memory while playing | WebView renderer + JS heap on top of the app, ~150–250 MB | ~60–120 MB | one process, no DOM; matters on 1.5–2 GB TV boxes where the low-memory killer ends playback |
| List/grid scrolling (large library, TV) | DOM + CSS, frame drops on weak TV SoCs | steady 60 fps | lazy native lists (`LazyVerticalGrid`, `List`) recycle views |
| Background playback reliability | Android WebView suspends audio when backgrounded; fixed by a plugin + foreground service ([mobile-app.md](mobile-app.md)) | reliable by construction | Media3 `MediaSessionService` / `AVAudioSession` own playback outside any view |
| Lock-screen metadata freshness | a backgrounded WebView held fetches → stale art | immediate | metadata set natively from the shared queue |
| D-pad navigation | 594-line `tv-nav-group` directive fighting WebView spatial-nav traps ([tv-ux.md](tv-ux.md)) | platform focus engine | Compose for TV / tvOS focus system |
| Gapless / crossfade | two `<audio>` elements juggled in JS | native gapless queue | ExoPlayer playlist / `AVQueuePlayer` |
| Download size | ~3–4 MB APK (TV release 4.0 MB) | ~5–9 MB APK | **no gain** — Compose + Kotlin stdlib cost more than a WebView shell; stated so it is not promised |
| Battery during long playback | JS timers + WebView compositing | lower | no renderer process awake for UI updates |

## Consolidation opportunities

Moving phones and TVs out lets the web app **shrink back to browser + desktop**. Candidates to
retire once the native client reaches parity (numbers from a 2026-09-30 inventory):

| Retire | Size today |
| --- | --- |
| The TV route fork (`isTvBuild()` in `app.routes.ts`, `pages/tv/*`, TV directives) | 27 TV files, ~2,870 LOC; 23 files branch on `isTvBuild`/`isTvUi` |
| The `tv` configuration in `angular.json`, its e2e `tv` project and `e2e:tv` emulator lane | 1 build config, 2 test lanes |
| `packages/mobile` + three Capacitor plugins (`capacitor-now-playing`, `capacitor-tv-channels`, `capacitor-apk-update`) | 755 native LOC plus the wrapper, the `android`/`ios` deploy jobs |
| `services/native/*` and `isNativePlatform` branches in web | 339 LOC; 25 branch sites in 11 files |
| `nativeAppCors()` on `/api/*` and `allowMixedContent` | native HTTP clients do not send CORS preflights at all |
| Runtime API-base URL for a *native* host (`ServerConfigService`) | 126 LOC service + setup page; reduce to what desktop needs |

Consolidations that pay off **even if we never build the client** — do these first, they are
also the preconditions:

1. **Finish the OpenAPI spec.** `OpenAPIHono` serves `/openapi.json`, but only 3 route files
   (auth, search, downloads) use `createRoute()`. Covering the ~15 listening routes lets the KMP
   core **generate** its Kotlin client instead of hand-copying DTOs, and gives the web one typed
   contract too.
2. **Pin the iOS stream container.** `AVPlayer` cannot play Opus in an Ogg container; streaming
   already falls back to mp3 when a client cannot open Ogg (`routes/streaming.ts`). Decide
   explicitly: serve Opus in MP4/CAF, or AAC, for iOS/tvOS — and measure the transcode cost
   ([opus-library-conversion-plan.md](opus-library-conversion-plan.md)).
3. **Make i18n portable.** `public/i18n/<lang>.json` is already runtime JSON; keep keys flat and
   ICU-free so the native apps can consume the same files at build time
   ([i18n.md](i18n.md)). Same for server error `code`s.
4. **Record the baselines** (cold start, RSS, frame timing on the TV box, background-kill rate) in
   `docs/measurements/`, so "native is faster" is later a comparison, not a belief.

**Further out:** if desktop ever moves off Electron (Compose Multiplatform desktop can reuse the
same KMP core), the Angular SPA becomes browser-only — the largest consolidation available, and the
one that removes the blocker above.

## Risks

- **Three UI stacks during migration.** Web/desktop keep Angular; phone/TV features must be built
  twice until retirement. Mitigation: native client is listening-only; no admin parity.
- **Feature drift.** New listening features land in web first. Mitigation: shared OpenAPI contract
  + a parity checklist in the codename repo.
- **Distribution.** A new `applicationId` breaks upgrades from `ar.kevinroberts.nicotind` and
  resets the pending F-Droid submission ([fdroid.md](fdroid.md)); reusing the id means a signed
  in-place replacement with the same key. Decide before the first release.
- **tvOS on KMP.** Kotlin/Native has tvOS targets, but every shared dependency must publish them —
  verify each library (Ktor, SQLDelight, serialization) at spike time.
- **Kotlin + Swift skills** replace TypeScript for this surface.

## When to revisit

- Desktop moves off Electron, or desktop is deprioritized — the blocker disappears.
- Measured TV cold start, memory kills or scroll jank become the top real-use complaint in the
  feedback log.
- Apple TV becomes a goal (Capacitor has no tvOS path at all).
- The WebView-workaround code (TV fork + native services + plugins) keeps growing release over
  release.

First step on a go: a two-week **spike** in the codename repo — KMP core with login + library list
+ stream one track on Android TV and tvOS — measured against the recorded baselines.
