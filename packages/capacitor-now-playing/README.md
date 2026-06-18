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

## Scope (intentionally narrow)

- **Owns:** the displayed info — title, artist, album, artwork, duration, elapsed
  time, and `playbackState`.
- **Does NOT own:** transport controls. Play/pause/next/prev/seek stay on the
  existing Web Media Session path (which already works on iOS), so this plugin
  registers **no** `MPRemoteCommandCenter` handlers and cannot conflict with
  WebKit's own.

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

## Build / install

Pure native; no JS build step. It is a workspace dependency of
`@nicotind/mobile`, so `cap sync ios` discovers it (via the `capacitor.ios.src`
marker + `NicotindCapacitorNowPlaying.podspec` — the pod name Capacitor derives
from the `@nicotind/capacitor-now-playing` package name) and `pod install` adds it to the
ephemerally-generated `ios/` project. The Swift compiles in the macOS CI `ios`
job (`xcodebuild`). **On-device behavior is a manual validation gate** — see
`docs/ios-app.md`.
