# The TV surface

**Status:** shipped 2026-08-08. `isTvBuild()` selects a five-route TV tree; `bun run e2e:tv` covers
it with 18 tests, including an assertion that no TV route renders a native form control.

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

2. **A nav group clamps and swallows the press.** `TvNavGroupDirective.onKeydown` `preventDefault()`s
   unconditionally at a group edge (deliberately, so an edge press can't leak into the global
   ArrowLeft/Right seek shortcut). That also stops the WebView's spatial navigation from carrying
   focus _out_ of the group. Measured (issue #436): from the last track row, `DPAD_DOWN` ×8 never
   left `rowIndex=6 of 7`.

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

## The screens

### Home (`/`)

The existing radio landing, promoted to the entry point: resume, one-press vibe presets, top-genre
chips. Adds a single **Browse** entry and a **Settings** entry. This is the screen closest to already
being right — it needs the surrounding chrome removed more than it needs redesigning.

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

Full-bleed blurred backdrop, centred art, title/artist, `prev · play/pause · next`, a Radio toggle,
and the Next-up chip that opens the D-pad queue overlay (#399, kept as-is). No seek bar — ◀ ▶ seek.
A one-line hint teaches it on first arrival.

### Settings (`/settings`)

A vertical list of D-pad rows covering only what a TV needs: **sign out**, **switch server**,
**language**, **remote-control toggle**. Each choice opens a full-screen list rather than a native
`<select>`; nothing is a form control. Admin, extensions, agent tokens and devices are absent.

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

Coverage: every route in the TV tree, run by `bun run e2e:tv`.

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
