# Playback loading feedback (HDD-aware loaders) — Design

**Date:** 2026-07-06
**Branch:** `feature/playback-loading-feedback`
**Status:** Approved

## Problem

NicotinD libraries often live on HDDs. Starting an uncached track can take ~5 seconds
(disk spin-up/seek, optional first-hit transcode), during which the UI gives **zero
feedback**:

- `PlayerComponent` registers no `waiting` / `stalled` / `playing` / `canplay`
  listeners; `PlayerService` has no buffering state. Clicking a track flips the play
  button to "pause" instantly while the seek bar sits at 0:00 doing nothing.
- The same blind spot applies to **seeking** into an unbuffered/untranscoded region
  mid-track and to **manual next/prev skips** (the 30 s standby pre-buffer only helps
  natural track endings).
- Track lists (album detail, playlist detail, genre detail, artist Songs, search) do
  not reference the player at all: no "current track" highlight and no acknowledgment
  that a click registered.
- The seek bar shows no buffered ranges, so users can't tell a safe seek target from
  one that will stall for seconds.

Already covered well (no changes needed): page-level spinners on library grid and
album/artist/genre/playlist detail, cover-art gradient placeholders, track-info sheet
`loading` / `fetchingLyrics`, search.

## Approach

One shared source of truth: a `buffering` signal on `PlayerService`, driven by native
audio-element events, consumed by every surface.

Alternatives rejected:

- **Per-component audio listeners** — duplicated logic across mini-player / Now
  Playing / rows; drifts out of sync; no single truth.
- **HTTP-level progress (fetch + MediaSource/blob)** — would replace native `<audio>`
  streaming and break the existing Range/206 + transcode-cache path; massive scope
  for no user-visible gain over event-driven state.

## Part 1 — Buffering state (core)

`PlayerService` gains:

- `readonly buffering = signal(false)` — raw, exact state.
  - Set `true` synchronously whenever a new track load begins (track click, queue
    skip, auto-advance src assignment) and on `waiting` / `stalled` / `seeking`-then-
    `waiting` events.
  - Set `false` on the `playing` event (and on stop/clear).
- `readonly bufferingVisible` — same as `buffering` but only turns on after a ~250 ms
  delay, so cached/fast tracks never flash a spinner. Turning off is immediate. Delay
  logic lives in the service (a `setBuffering(value)` setter managing one timer),
  unit-testable with fake timers.

`PlayerComponent` wires it:

- `bindAudioListeners` adds `waiting`, `stalled`, `playing`, `canplay`, `seeked`
  listeners calling `player.setBuffering(...)`.
- Effect 1 and `onEnded` call `setBuffering(true)` at the moment they assign a new
  `src` (both the primary-element path and the standby-swap path).
- `onSeek` sets buffering `true` optimistically; the `playing`/`seeked` events clear
  it if the target was already buffered.

**Scope guard:** active device only. When this tab is a remote controller
(`!isActiveDevice()`), `buffering` stays `false` — the playback WS protocol does not
carry buffering state and extending it is out of scope.

## Part 2 — Surfaces

### Play/pause buttons (mini-player + Now Playing sheet)

While `bufferingVisible()`, the play/pause icon is replaced by the standard spinner
(`animate-spin` ring, same idiom as the detail pages). The button stays clickable
(acts as pause/cancel).

### Track rows (`TrackRowComponent`)

`TrackRowComponent` injects `PlayerService` and computes:

- `isCurrent` — `player.currentTrack()?.id === track().id`.
- Row treatment when current: accent-colored title + a trailing indicator slot that
  shows a **spinner** while `bufferingVisible`, **animated equalizer bars** while
  playing, **static bars** while paused.

Because `currentTrack` is set synchronously on click, the accent highlight is the
instant click acknowledgment — it appears before any bytes arrive. This also adds the
previously-missing "which track is playing" highlight to every list that uses
`app-track-row` (album detail, playlist detail, genre detail, artist Songs, search
results) with no per-host changes. The Now Playing queue renders its own rows and
only holds *upcoming* tracks, so it needs no current-track treatment.

`data-testid` hooks: the row exposes a state attribute (e.g.
`data-playback-state="buffering|playing|paused"`) on the current row for e2e.

### Seek bar buffered ranges

- Pure helper `computeBufferedSegments(ranges: {start,end}[], duration: number)` →
  percent segments, clamped/merged; lives in `lib/` and is fully unit-tested.
- `PlayerComponent` listens to the audio `progress` event, snapshots
  `audio.buffered` into a `PlayerService.bufferedRanges` signal (as plain
  `{start,end}[]`).
- `SeekBarComponent` renders the segments as a lighter band between the track
  background and the progress fill (YouTube-style). Hidden when segments are empty or
  when the device is remote.

## Part 3 — Error/edge handling

- **Autoplay rejection**: existing `handlePlayRejection` path also clears buffering
  (the "Tap to resume" banner replaces the spinner, no spinner+banner overlap).
- **Track load error** (`error` event on the audio element): clear buffering so the
  spinner cannot spin forever on a missing/corrupt file.
- **Element swap** (`onEnded` standby flip): listeners re-bind via the existing
  `bindAudioListeners`, which now includes the buffering listeners; the swap path
  sets buffering `true` only when the standby was **not** preloaded.
- **Preserved (IndexedDB) tracks**: object-URL loads are near-instant; the 250 ms
  visibility delay means no spinner flash.

## Testing (quality gates)

- **Unit (web vitest, existing `ng test` job in `ci.yml`):**
  - `PlayerService` buffering setter + visibility delay (fake timers).
  - `computeBufferedSegments` pure function (empty, single, multiple, overlapping,
    zero-duration).
  - `TrackRowComponent` current/buffering/playing rendering via instance + DOM (per
    the JIT-vitest convention: no `input()` driving from tests; use component
    instance + injected service signals).
  - `PlayerComponent` spec: buffering listeners registered and state transitions on
    dispatched audio events.
  - `SeekBarComponent` renders buffered band from segments input.
- **e2e (Playwright, existing `e2e` job):** click a track row → row exposes
  current/`data-playback-state`; play button reachable throughout.
- CI: no new workflow needed — all tests land in files already picked up by
  `ci.yml`'s web-test and e2e jobs.

## Documentation

- New "Playback loading feedback" section in `docs/web-ui.md` (pattern: single
  `buffering` signal, 250 ms visibility delay rationale, surfaces list).
- One-line index entry in `CLAUDE.md` under Key Design Patterns pointing at
  `docs/web-ui.md`.
