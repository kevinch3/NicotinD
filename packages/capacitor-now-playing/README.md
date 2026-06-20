# @nicotind/capacitor-now-playing

A minimal, **iOS-only** Capacitor plugin that drives the system "Now Playing"
card (`MPNowPlayingInfoCenter`) directly.

## Why this exists

`@jofr/capacitor-media-session` (used for Android's background-playback foreground
service and the browser Media Session) ships **no iOS native code** — its `dist/`
is a thin wrapper over WKWebView's Web Media Session API. On iOS that API wires
play/pause to the playing `<audio>` element but does **not** reliably surface
JS-set metadata (title / artist / album / artwork) or the position scrubber for
cross-origin web audio. The result: the iOS lock screen shows controls but no
track data, no thumbnail, and no time.

This plugin sets `nowPlayingInfo` natively so the system player shows real data.

## Scope

iOS only *displays* `nowPlayingInfo` for the app that **owns** the system
now-playing session, and ownership requires an **active `AVAudioSession`** plus
at least one **registered `MPRemoteCommandCenter` target**. WKWebView has both
for its `<audio>` element, so merely writing `nowPlayingInfo` (this plugin's
original behavior) lost to WebKit's empty session and the card showed nothing.
So the plugin now takes full ownership:

- **Owns the displayed info** — title, artist, album, artwork, duration, elapsed
  time, `playbackState`.
- **Owns transport** — it activates an `AVAudioSession` (`.playback`) and
  registers the lock-screen commands (play / pause / next / prev / seek),
  forwarding each to JS via a single `remoteCommand` event so the Angular player
  responds. Because the plugin owns the commands, the web layer **must not** also
  wire WKWebView's Web Media Session `setActionHandler` on iOS — that would fire
  every transport action twice (see `MediaControlsService`).

## JS API

There is no JS package to import — the web app calls it through the injected
`Capacitor.Plugins.NicotindNowPlaying` global (see
`packages/web/src/app/services/media-controls.service.ts`, which routes to this
plugin only when `isIosNative()`):

| Method | Args |
| --- | --- |
| `setMetadata` | `{ title, artist, album, artworkUrl? }` |
| `setPlaybackState` | `{ state: 'playing' \| 'paused' \| 'none' }` |
| `setPositionState` | `{ duration, position, playbackRate }` |
| `clear` | — |
| `getDiagnostics` | — → `{ pluginRegistered, sessionConfigured, audioCategory, isOtherAudioPlaying, commandsRegistered, nowPlayingInfoKeys, artworkUrl, lastArtworkStatus }` |

Events (via `addListener`):

| Event | Payload |
| --- | --- |
| `remoteCommand` | `{ action: 'play' \| 'pause' \| 'nexttrack' \| 'previoustrack' \| 'seekto', seekTime? }` |
| `artworkError` | `{ url, status?, message? }` |

## Build / install

Pure native; no JS build step. It is a workspace dependency of
`@nicotind/mobile`, so `cap sync ios` discovers it (via the `capacitor.ios.src`
marker + `NicotindCapacitorNowPlaying.podspec` — the pod name Capacitor derives
from the `@nicotind/capacitor-now-playing` package name) and `pod install` adds it to the
ephemerally-generated `ios/` project. The Swift compiles in the macOS CI `ios`
job (`xcodebuild`). **On-device behavior is a manual validation gate** — see
`docs/ios-app.md`.
