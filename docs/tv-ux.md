# The TV surface

**Status:** shipped 2026-08-08. `isTvBuild()` selects a five-route TV tree; `bun run e2e:tv` covers
it with 18 tests on the emulator, and since #1136 the Chromium suite's `tv` project renders the same
tree with screenshot baselines on every PR (see "The TV tree in Chromium" below). Both assert that
no TV route renders a native form control.

**Supersedes** the conditional-patching approach that produced issues #387, #389, #393, #394, #396,
#399, #432, #436, #438 and #439 — nine rounds of locally-reasonable fixes to touch components that
a remote cannot safely operate.

## The problem, stated once

A remote has a D-pad, an OK and a Back. It has **no Tab key**. Every TV defect found so far reduces
to one of two consequences of that:

1. **A native form control eats the arrow keys.** `<input type="range">`, `<select>` and text fields
   all consume Up/Down/Left/Right themselves, so neither the nav groups nor the WebView's spatial
   navigation ever sees the press. On desktop, Tab is the escape hatch; on a remote there is none.
   Measured on the emulator (issue #438): with the Now Playing seek bar focused, all four directions
   pressed twice moved focus nowhere. Only hardware Back escaped.

   The project rule this follows from — _"forms stay Tab-order-only by design; native inputs are
   never wrapped in `appTvNavItem`"_ — is correct on desktop and meaningless on TV.

2. **A nav group clamps and swallows the press.** `TvNavGroupDirective.onKeydown` used to
   `preventDefault()` unconditionally at a group edge (deliberately, so an edge press can't leak
   into the global ArrowLeft/Right seek shortcut). That also stopped the WebView's spatial
   navigation from carrying focus _out_ of the group. Measured (issue #436): from the last track
   row, `DPAD_DOWN` ×8 never left `rowIndex=6 of 7`.

   **The clamp is now fixed as this document proposed**: a clamped ▲ ▼ is left un-prevented so
   spatial nav can carry focus out, while a clamped ◀ ▶ stays guarded, since only the horizontal
   pair collides with the seek shortcut (`KeyboardShortcutsService` binds ArrowLeft/Right only).
   Home/End stay prevented — spatial nav does not act on them. The grid axis already behaved this
   way (`onGridKeydown` leaves `next === null` when Up/Down has no row to jump to), so this brings
   the linear axis in line with it rather than inventing a new rule.

   **Not measured on the emulator**, per the caution below: the unit tests pin the clamp contract in
   both directions, but the trap itself only bites where spatial navigation exists.

Both are **one bug class each**, not one bug each. Patching individual controls cannot hold, because
nothing stops the next `<select>` being added by someone with no reason to think about remotes.

### What the screens actually show

Captured from the emulator at 1920×1080 (see the audit artifact linked from the PR):

| Screen   | What a remote meets                                                                         |
| -------- | ------------------------------------------------------------------------------------------- |
| Home     | six nav destinations, Sign out, a version string — and the vibe row, which is already right |
| Library  | a search field above the grid; the grid itself is fine                                      |
| Album    | a text filter, a `<select>`, and **Remove album** — destructive, one press away             |
| Player   | big art, clear transport, Next-up chip — and the seek bar sitting directly below the art    |
| Settings | collapsed cards over selects, toggles and text fields                                       |
| Acquire  | search-driven from the first pixel                                                          |

The good parts are already there. They are surrounded by a phone UI.

## Scope

**In:** moods as the front door, browse-by-grid, a full-screen player, minimal settings.

**Out:** search and text entry of any kind, the seek bar, the mini-player, Acquire, Downloads,
Admin, playlists detail, filter panels.

Finding a specific record when browsing isn't enough stays a real gap. The intended answer is **not**
an on-screen keyboard: it is the phone. Search there, and cast to the TV over the existing remote
playback. If that proves insufficient in use, revisit — but build the browse-first version first.

## Structure

A **route-level fork**, not a component-level one. `isTvUi()` is stable at boot, so the shell picks a
route tree from it:

```
/                 → TvHomeComponent       |  RadioLandingComponent
/library          → TvBrowseComponent     |  LibraryComponent
/library/albums/:id → TvAlbumComponent    |  AlbumDetailComponent
/player           → TvPlayerComponent     |  (no equivalent — see below)
/settings         → TvSettingsComponent   |  SettingsComponent
```

Everything else is **absent from the TV tree**, not hidden with CSS. A route that does not exist
cannot be reached by a stray `routerLink`, and cannot accumulate a trap nobody is looking at. The
catch-all `{ path: '**', redirectTo: '' }` already sends anything unmatched to Home.

| Shared unchanged                                                                       | New for TV                                                             |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Every service — `PlayerService`, `LibraryApiService`, `RadioService`, `AuthService`, … | The five components + templates                                        |
| Signals, guards, interceptors, i18n                                                    | `TvShellComponent` (replaces header + `app-bottom-nav` + `app-player`) |
| `TvNavGroupDirective` / `TvNavItemDirective`                                           | —                                                                      |
| `CoverArtComponent`, `ArtistLinksComponent`, other presentational atoms                | —                                                                      |

**A template and navigation fork, not a logic fork.** No API service, no player state, no scoring
code gets a second copy. That is what makes the "two UIs to keep in sync" objection survivable — the
surfaces are deliberately few, which is the point of simplifying.

### The player becomes a route

Today Now Playing is a sheet inside `LayoutComponent`, always mounted and translated off-screen —
which is what caused #439's backdrop bleed. On TV it becomes `/player`, a real route. That deletes
the sheet's translate machinery, the drag-to-open gesture, the grab notch (#432's fix stays relevant
for phone/desktop), and the `html.tv-build` overrides in `styles.css` that reshape the phone sheet
into a 10-foot player — roughly 90 lines that exist only because the phone component was in the way.

## The button contract

One contract; no screen redefines a key.

| Key        | Home / Browse / Album / Settings          | Player                                                   |
| ---------- | ----------------------------------------- | -------------------------------------------------------- |
| ▲ ▼ ◀ ▶    | move focus between tiles/rows             | ◀ back 10 s · ▶ forward 10 s · ▲ ▼ move between controls |
| OK         | open or play the focused thing            | activate the focused control                             |
| BACK       | return to Home (from Home: leave the app) | back one route, falling back to Home                     |
| PLAY/PAUSE | toggle playback                           | toggle playback                                          |

**The one ambiguity, resolved by route.** ◀ ▶ mean _seek_ on the Player and _move focus_ everywhere
else. That collision is what caused #387. It is resolved by the active route only — never by
guessing from focus position — so `KeyboardShortcutsService` binds arrow-seek **only while
`/player` is the active route**, and the nav groups own ◀ ▶ everywhere else.

Because the Player has no nav group spanning its full width, ▲ ▼ there move between the transport
row and the queue affordance via ordinary spatial navigation.

The radio chip below the transport is two direct items of the Player's root group (the toggle,
then the options chevron), so ▼ from play/pause still lands on `now-playing-radio`; its expanded
variety panel is a horizontal group of three radios. See [radio.md](radio.md) "Variety chip".

## The screens

### Home (`/`)

The existing radio landing, promoted to the entry point: resume, one-press vibe presets, top-genre
chips. Adds a single **Browse** entry and a **Settings** entry (and **Now playing**, once a track is
loaded — #1128). This is the screen closest to already being right — it needs the surrounding chrome
removed more than it needs redesigning.

**The nav row renders first, above the shelves.** Below them it sat at y≈614 on the 540 px the
WebView has, so the only two ways off the front door were below the fold until the D-pad scrolled to
them (#1135). A 10-foot UI shows its navigation before its content.

### Browse (`/library`)

Tabs (Albums · Artists · Genres) as a horizontal nav group, then a grid. No search field, no filter
panel, no sort `<select>`. Sort is fixed (newest first for albums, alphabetical for artists) —
a remote-shaped sort control is a full-screen chooser, and there is no evidence anyone needs one
on a TV yet.

### Album (`/library/albums/:id`)

Cover, title, artist, year, a **Play** button, and the tracklist. That is the entire screen.

Dropped, with reasons: the track filter (text entry), the sort `<select>`, Select/multi-select
(bulk actions are curation, not listening), Download, Share, Fix metadata, and **Remove album** —
a destructive filesystem operation should not be one press away on a device where focus can land
somewhere unexpected.

### Player (`/player`)

Two columns (#1404): the cover (280 px, on a 960×540 WebView that is a third of the panel's height)
with title · artist · album beside it, then a **rail** of three D-pad rows to the right of the art —
**Lyrics** (the karaoke overlay, below), **Queue** showing the next track (opens the D-pad queue
overlay, #399), and **Play on** showing the current output ("This TV", or the device name in accent
while the audio is elsewhere, #1128). The transport `prev · play/pause · next` sits under both, with
a text-only `1:12 / 3:40` readout and the seek hint beneath it. The rail rows are the Settings rows —
label left, state right — so a feature reads as a thing you can press, not a caption.

The first layout was one centred column with the three features stacked as grey text under the
transport; at 720p the last row sat on the bottom edge while 60% of the width was empty, and the
route never showed a time.

No seek bar — ◀ ▶ seek. The readout is text and never a range input, which a remote cannot escape
(#438). The hint's arrows are `← →`, not `◀ ▶`, because the latter have no glyph in the UI font and
fall through to the colour-emoji face as two orange tiles (#1132).

The three transport buttons centre their icons with `flex items-center justify-center`, like every
other icon button in the app. Without it each glyph sat on the **left edge** of its circle: Tailwind's
preflight makes an `<svg>` `display: block`, and a button centres a block child vertically but never
horizontally. From the couch that read as the whole row shoved to the right (#1132) — and it shipped
through a green suite because no Chromium test had ever rendered this template.

There is **no Radio toggle**, and the original draft above claiming one was aspirational. Radio is
not a toggle on TV at all — see "Radio is always on" below.

### Status line (every screen)

`TvShellComponent` paints the signed-in username and `v<version>` in the top corners, inside the
overscan inset, faint and non-interactive (#1404). Nothing in the TV tree said which account the
box was on or what it ran; the phone puts both on its Settings page, which the TV tree replaced.
Full-bleed overlays (karaoke, queue, output picker) cover it. Settings repeats the two facts under
its heading, where a person goes looking for them.

## Profiles (#1406)

A TV is one box for several people, and before this it held exactly one session: whoever scanned
the QR *was* the TV for everyone in the room — B saw A's Home and history, every play from the
couch landed in A's history and trained A's radio, and B's phone could not even see the TV in its
cast picker, because devices are per user on the server.

Now the TV **remembers people**. `lib/tv-profiles.ts` keeps `{username, role, token}` per person
in `nicotind_tv_profiles::<server URL>` (the same 30-day device JWT the app already keeps, one per
person, keyed per server like the server-registry session stash — "Switch server" never offers one
server's JWT to another). Only the TV build writes it: `TvProfileService` is root-provided and the
login page injects it everywhere, so every side effect checks `isTvBuild()`. The active session keeps living in
`nicotind_token`/`username`/`role`, so nothing else in the app knows about profiles: every API
call, socket, listen and preference read already keys off the active token.

A **switch** (`TvProfileService.switchTo`) is `resetSession()` — which drops the queue, the
preferences mirror, likes, remote playback and every per-person key — then `login()` with the
stored token, then the same `refreshSession` a boot runs, awaited — so an expired token is found
now rather than as a 401 on the first library call, and the person's radio variety, theme and
language follow them. A refused refresh — 401/403 — forgets that person and goes back to `/who`
(or to the QR when nobody is left); any other failure keeps the login and goes Home. A newer switch
supersedes an older one still waiting on its refresh, so two quick presses never cross tokens.
Holding the remote is enough: the owner chose the Netflix model over a PIN.

Surfaces: Home's nav ends with the active name → `/who`, a list of people (active one marked)
and **Add person**, which is the ordinary QR flow after a reset; the login card shows a way back
to the people while any are stored. **Sign out** in Settings forgets *that* person on this TV
and hands the box to the next one, or to the QR when nobody is left. `/who` is server-guarded
only, because picking a person is how the TV signs in, and sits outside the TV shell, so it has no
status line. A fresh boot with stored people but no active session lands on `/login`, whose
back-link leads to `/who`.

A cast switches the profile too (PR 2, #1406): every stored person who is not the active one has
a listener (`TvProfileListenerService`, `ProfileCastListener`) registering the TV's own device id
under their token, so the TV shows up in *their* phone's cast picker even while someone else is on
screen. A cast from one of those pickers switches the TV to that person and lands it on the
player. The `STATE_SYNC` a listener's own registration provokes is never a cast — only a later
change of the active device is; an echo that still names the TV is released (the listener plays
nothing). Five failed opens in a row are checked with a raw `GET /api/auth/me` under that person's
token: a 401/403 (a dead token) marks them "sign in again" on `/who`; anything else (server or Wi-Fi
down) retries with a fresh listener 30 s later. Listeners are keyed by server, person and token, so
a server switch or a new token replaces them. Listeners exist only while signed in, with Remote
control on, and a listener never opens for anyone (including the person who just stopped being
active) until the main socket is acknowledged as the new active person. When the TV was the
outgoing person's output, the switch's `resetSession` releases their session before the socket
closes, and a listener whose echo still names the TV releases it too (a reboot); see
[remote-playback.md](remote-playback.md#one-device-several-people-tv-profiles-1406) for the
hand-over.

### Settings (`/settings`)

"Signed in as ‹user› · v‹version›" under the heading, then a vertical list of D-pad rows covering
only what a TV needs: **sign out** (forgets this person on this TV — see Profiles), **switch server**, **language**, **remote-control toggle**. Each choice opens a full-screen list rather than a native
`<select>`; nothing is a form control. Admin, extensions, agent tokens and devices are absent.

The remote-control screen also **names this TV** — the string other devices' pickers show for it,
special-cased to `"NicotinD TV"` because the UA reads "Chrome on Android" and says nothing a cast
selector needs (#393). Until #1128 that name existed only on the web Settings page, so from the
couch there was no way to tell which entry in the phone's picker was this box, and no way at all
with two TVs.

## Karaoke on TV (#1134)

The phone player's fullscreen lyrics — `NowPlayingKaraokeFullscreenComponent`, synced-line
auto-follow, browse-to-seek — mounted from the TV player's **Lyrics** row. What the report asked for
is the lyrics; the vocal-mute toggle rides along only because the shared overlay already carries it
and `PlayerComponent.streamSrc` already honours `vocalsMuted` on every surface.

It could not simply be mounted before: every piece of lyrics state lived in `NowPlayingComponent`,
the phone sheet, which the TV tree never instantiates. So the state moved up, and the overlay is
driven by three shared pieces rather than a second copy of any of them:

| Piece | Lives in | Used by |
| --- | --- | --- |
| Load / fetch / LRC parse / active line | `LyricsService` (`services/lyrics.service.ts`) | phone sheet, `TvKaraokeComponent` |
| Auto-follow ↔ browse, with the 4 s idle return | `KaraokeBrowseMode` (`lib/karaoke-browse.ts`) | both |
| Cover → gradient palette (the Image/canvas shell) | `loadCoverPalette` (`lib/cover-colors.ts`) | both |

`TvKaraokeComponent` (`pages/tv/tv-karaoke.component.ts`) is the wiring and the three TV
adaptations: **no seek bar** — `app-seek-bar` is a native range input, the #438 trap, so the
overlay's `seekBar` input is off and the ◀ ▶ hint takes its place while the route-scoped shortcut
keeps seeking; **Back closes the overlay first**, through `registerOverlayCloser` on the shared
`BackHandlerStack` (the #398 modal shape), so Escape and hardware Back never leave the route; and
**the overlay takes focus on entry** so ▲ ▼ enter browse mode at once. Closing hands focus back to
the Lyrics row. The overlay's six buttons also gained a visible focus ring — they only ever had hover
styles, which a D-pad never triggers.

## Enforcement — the part that makes it stick

The design is one `<select>` away from re-rotting. So the rule becomes executable:

`packages/e2e/tests-tv/dpad-reachability.tv.spec.ts` currently audits `[appTvNavItem], [tabindex="0"]`
and diffs the reachable set against it. It is extended to **also fail when any native form control is
focusable on a TV route**:

```ts
const NATIVE = 'input, select, textarea, [contenteditable]';
// A remote has no Tab, so any focusable native control is a trap by construction.
expect(await page.locator(NATIVE).count()).toBe(0);
```

This closes the audit's own gap: a native input carries neither `appTvNavItem` nor `tabindex="0"`, so
today it is invisible to the walk — which is exactly why the audit passed while #438 was live.

Coverage: every route in the TV tree, run by `bun run e2e:tv` — and, on every PR, every screen and
overlay the Chromium `tv` project screenshots (`expectNoNativeFormControls`, `tests/tv-build/`).

## Migration

Ordered so each step is independently shippable and the suite stays green.

1. **`TvShellComponent` + the TV route tree.** Home, Browse, Album, Player, Settings as thin
   components; Home reuses the radio landing's content. The Chromium suite is untouched throughout —
   nothing in the phone tree changes.
2. **Player as a route.** Move the TV treatment out of `styles.css` into `TvPlayerComponent`, delete
   the sheet overrides, bind arrow-seek to the route.
3. **Re-point the #436 tests — do not assume a fix is still needed.** The three `test.fail()`
   assertions in `navigation-escape.tv.spec.ts` check that focus can escape a track list _into the
   player chrome below it_. On the TV tree there **is** no chrome below the content: the mini-player
   is gone and the player is a route. So the premise those tests encode disappears, and un-annotating
   them would assert something that no longer exists.

   That means #436 is likely **moot on TV** rather than fixed by this work — worth stating plainly,
   because the tempting move is to claim credit for closing it. The trap only bites where spatial
   navigation exists (an Android WebView), and the surfaces where it bit are being deleted. The
   honest step is: re-point the tests at the new bottom-of-content boundaries, re-measure on the
   emulator, and close #436 only if the measurement supports it. If a real trap survives anywhere in
   the TV tree, fix the clamp then — letting a clamped ▲ ▼ through un-prevented while keeping ◀ ▶
   guarded, since only the horizontal pair collides with the seek shortcut.

4. **The enforcement assertion**, once no TV route renders a form control — added last so it never
   goes in red.

#438 is **not** patched on the way: the seek bar is deleted in step 2 rather than given a scrub
mode that would then be removed. Note the issue is broader than the seek bar — it names every native
control on TV — so it closes when step 4's assertion goes green, not when the seek bar goes.

## Open questions, deliberately unresolved

- **Does browse-without-search hold up on a real library?** The fixture has one album. On a few
  thousand, genre and artist tiles may be enough, or may not. Ship it, use it, revisit — the answer
  is not knowable from here, and the fallback (find on phone, cast to TV) already works.
- **Does the TV need its own Now Playing queue editing**, or is view-plus-jump enough? Currently
  #399's overlay does jump and remove; nothing suggests more is wanted.

## What implementing it changed

Four defects surfaced during the build, all of which **degraded into something that looked
deliberate** rather than throwing. Worth recording, because each one passed typecheck and (except
the last two) the test suite:

1. **The route fork must use `isTvBuild()`, not `isTvUi()`.** `app.routes.ts` is evaluated when
   `main.ts` imports `appConfig`, and ES imports are hoisted — so it runs _before_
   `applyTvBuildClass()` stamps the root class. A DOM-based check there is always false and the TV
   tree silently never registers; the app boots fine, just as the phone UI. Pinned by
   `app.routes.spec.ts`, which asserts the source uses the build-time signal (a source-text check on
   purpose: the bug _is_ evaluation order, so importing the module in a spec proves nothing).
2. **`app-player` is the audio engine, not the bar.** Dropping it from the TV shell to remove the
   mini-player removed `<audio>`, buffering, transcode fallback, false-ended recovery and the media
   session with it. It is now rendered **headless** on TV — its template gates all chrome behind
   `@if (!isTv)`. That also keeps the seek bar (`input[type=range]`) out of the DOM, which the
   enforcement assertion requires.
3. **Cover URLs need `&token=`.** `/api/cover/:id` is auth-gated; without the token every request
   401s and `CoverArtComponent` falls back to its gradient placeholder — which reads as a design
   choice. All 17 tests passed while every cover was broken, because none looked at pixels. The
   smoke spec now asserts `naturalWidth > 0`.
4. **`max-h` on `<app-cover-art>` clips the host, not the image.** With a fixed `[size]` the art
   overflowed and sat on top of the track title. Size it once instead of clipping.

The through-line: none of these threw, and three of four were invisible to a green suite. They were
found by running the real APK on a real device and _looking at it_.

### #436 is moot here, not fixed

The escape tests asserted focus could reach the player chrome _below_ a track list. There is no such
chrome on the TV tree any more, so that premise is gone rather than satisfied. `navigation-escape.tv.spec.ts`
now tests what still matters — no screen is a dead end, Back always exits — and #436 stays **open**
for any surface that still nests a bottom-most nav group under other chrome.

### #438 closes on the assertion, not on the seek bar

The issue names every native control on TV, not just the seek bar. It is satisfied by
`dpad-reachability.tv.spec.ts`'s `input, select, textarea, [contenteditable]` count being zero on
every TV route — which is what makes the guarantee durable rather than a convention.

## Radio is always on (#1127)

Two things were true at once and neither was visible: the TV tree mounts `TvShellComponent`, not
`LayoutComponent` — and `LayoutComponent.ngOnInit` was the **only** call site of
`PlayerService.setRadioProvider`. So on a TV build `replenishRadio` returned on its first line
(`if (!this.radioProvider …) return`) for the life of the app, and every queue ended in silence:

| TV action | Queue it built | What happened at the end |
| --- | --- | --- |
| A vibe tile on Home | 20 tracks (`getFilterRadio(filter, [], 20)`) | silence — radio was *on*, and still could not replenish |
| An artist tile | ≤ 200 | silence |
| A genre tile | ≤ 100 | silence |
| An album, or a track in one | the album | silence |
| A recently-played tile | ≤ 20 | silence |

Two fixes, and the first matters more than the bug:

1. **The radio source is registered where no shell can forget it.** `RadioSourceService`
   (`services/radio-source.service.ts`), installed from the app initializer. "A shell must remember
   to register the radio source" is not a contract a shell can be trusted with: forgetting it throws
   nothing, logs nothing, and stops the music twenty minutes later — pointing at the radio formula,
   the network, the addon, anywhere but a missing call. `scripts/radio-source-registration.test.ts`
   fails if a component takes it back.
2. **`PlayerService.ensureRadioOn()` at TV shell start.** The five TV screens carry no radio control
   (the toggle lives in the phone transport and the radio chip), so a remembered `radio = false`
   could never be undone from the couch. Endless playback is the 10-foot expectation and there is no
   "off" worth preserving when there is no way back. Idempotent, and it leaves an in-flight filter
   vibe alone. Turned on over an album queue it anchors on the album (the whole list, not the
   shrinking queue); over a bare queue, on the playing track (#1277).

**A song press on Home seeds radio from that song, for the whole session.** `playShelfSong` (`lib/shelf-play.ts`) is the
one decision, shared by the three Home shelves: on phone and desktop the shelf decides (a
recommendation tile seeds radio, the history shelf plays itself as a queue), on TV every press seeds
radio and asks for the player. The variety position is the listener's stored strategy — `balanced`
(`DEFAULT_STRATEGY`) unless they changed it elsewhere; the TV offers no chip, so it never diverges
on its own. Routing goes through `nowPlayingOpen`, which the shell already adapts into a route
change, rather than a second navigation call in every shelf.

The queue overlay is reachable at last: `NowPlayingTvQueueComponent` shipped in #399 mounted **only
by the phone sheet**, so on TV it was dead code and the player showed one read-only Next-up line.
The chip is now a focusable button that opens it.

## Remote playback on TV (#1128)

The TV was a full participant in the protocol — it registers, it is castable, it executes commands —
with no surface saying so. `app-playing-elsewhere` and `app-device-switcher` are mounted by the
phone sheet and by `player.component.html`, whose chrome is behind `@if (!isTv)`, so on a TV build
neither was ever instantiated. Three consequences, all of them what "not prepared for remote audio
playback" meant:

- **A cast landed invisibly.** Audio started and the screen stayed on Home. `TvShellComponent` now
  routes to `/player` when this TV becomes the output *and is playing* — `isPlaying`, not
  `currentTrack`, because `restoreState()` re-loads the last track paused on every boot and a cold
  start must not jump to the player for a track nobody asked for.
- **Audio moved away left no sign.** The player's remote row reads "Playing on ‹device› · OK to play
  here" in the accent colour, and is one press from bringing it back.
- **There was no way back.** `TvDevicePickerComponent` is the output chooser in the shape every
  other TV chooser uses — a full-screen list of buttons, never a popover (the phone's closes on an
  outside `mousedown`, which a D-pad cannot perform) and never a `<select>` (#438). It is mounted on
  the shell and keyed off the same `switcherOpen` signal the phone popover uses, so every existing
  caller opens the right shape for its surface.

Only the presentation is forked. The offerable/sibling rules come from the shared `otherDevicesFor`
(`lib/device-list.ts`), used by both pickers — two pickers disagreeing about which devices are
offerable is a bug nobody would see until they were holding both devices.

Home also grows a **Now playing** entry when a track is loaded. Without it `/player` was reachable
only by starting something, so the screen that says "your audio is on the phone" was the one screen
you could not get to.

## The TV tree in Chromium (#1136)

Three "TV" specs in the Chromium suite — `now-playing-tv.spec.ts`, `library-dpad-tv.spec.ts`,
`login-tv-signin.spec.ts` — fake a TV by stamping the `tv-build` class on the **phone bundle** at
960×540. That flips `isTvUi()`. The route tree above is keyed off **`isTvBuild()`**, baked at build
time ("What implementing it changed", item 1), so those specs never mounted `TvShellComponent`,
`TvPlayerComponent` or any other TV template; `now-playing-tv.spec.ts` in particular exercises a
phone sheet the TV build no longer renders at all. The only automated coverage of the real tree was
`bun run e2e:tv`, a local-only lane.

That is how #1132, #1133 and #1135 shipped: every one is a layout fact — icon offsets, a card taller
than the screen, a nav below the fold — that Chromium can measure, on templates no Chromium test had
rendered. The fix is the `tv` Playwright project ([e2e.md](e2e.md) "The TV bundle in Chromium"): a
third managed server serving `ng build --configuration tv` through `NICOTIND_WEB_DIST`, specs in
`packages/e2e/tests/tv-build/` at the TV viewport, and `toHaveScreenshot` baselines for login, Home,
Browse, Album, the player, its queue and output overlays, karaoke and Settings, beside the geometry
assertions each of those issues named.

What stays emulator-only is unchanged: spatial navigation and hardware Back
([e2e-tv-emulator.md](e2e-tv-emulator.md)). Pixels and geometry do not have to be.

### What the pixels showed

Captured from the TV bundle at 960×540 before the fixes (the shots are in the linked issues):

| Screen | Measured | Cause |
| --- | --- | --- |
| Player | prev/next icons at x = button x (−15 px from centre); play/pause −23 px | block-level `<svg>` in a button with no flex centring (#1132) |
| Login | page 606 px tall in 540; `tv-login-use-password` at y=553–569, below the fold | the phone's vertical `max-w-sm` card reused on a 16:9 screen (#1133) |
| Home | page 690 px tall; `tv-home-nav` at y=614 | nav rendered after the shelves (#1135) |
| Player hint | `◀ ▶` drawn as orange emoji tiles | no text glyph in the UI font; fallback to the colour-emoji face (#1132) |

### The login card is 16:9 on TV (#1133)

`LoginComponent` keeps one template; on `isTvUi()` the card widens to `max-w-3xl`, the brand block
becomes one row, and the sign-in panel puts the 180 px QR beside the hint, the code, the status line
and the two links. The typed-password fallback stays phone-width inside the wide card. Everything
fits with no scroll — a TV cuts off what it cannot fit rather than scrolling to it — which the
`tv` project asserts (`scrollHeight <= innerHeight`, every element `toBeInViewport` at ratio 1).
