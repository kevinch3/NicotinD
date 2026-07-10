# Unified Song Listings — Design

**Date:** 2026-07-10
**Status:** Approved (design), pending implementation plan
**Scope:** Web UI (`@nicotind/web`) — full menu + selection overhaul

## Problem

Every song listing already renders the **same** `TrackRowComponent`, and shared
primitives exist (`createSelection()`, `SelectionBarComponent`, `track-utils`
helpers). The container is unified; the **per-row action menu** and, in one page,
the **multiselect** are not.

Each page hand-assembles a `TrackAction[]`, which caused drift:

| Action | Album | Artist Songs | Genre | Playlist | Search | Downloads |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Save offline | ✅ | ✅ | ✅ | ✅ | — | — |
| Add to playlist | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Go to artist | ✅ | — | ✅ | ❌ | ❌ | ❌ |
| Go to album | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Start radio from song | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Add to queue | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Play next | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Song info | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Remove from library (admin) | ✅ | ✅ | ✅ | ❌ | — | ✅ |

Specific defects:

1. Actions the product wants as "common" — **Go to album, Start radio from song,
   Add to queue, Play next, Song info** — exist on **zero** listings; **Go to
   artist** on only 2 of 6.
2. The admin **Remove from library** closure (`askConfirm → deleteSongs →
   addDeletedIds → local prune`) is **copy-pasted 4×** (album/artist/genre/downloads).
3. **Downloads** rolls its own `Set<string>` selection (`selected`,
   `toggleSelect`, `selectAll`) instead of `createSelection()`.
4. No single source of truth for "what actions can a song have, and which apply
   in this context" — ad-hoc assembly is why the drift happened.

The fix is **not** "make it one component" (already done). It is **one action
catalog + one selection wiring, driven by context flags**, so the common set is
guaranteed everywhere and optional actions are declared, not re-coded.

## Approach

Chosen: **`SongMenuService` (root)** as the single source of truth, with the
`TrackRowComponent` kept presentational/dumb. Rejected alternatives: a DI-free
builder function (pages keep wiring services), and a smart `<app-song-row>` that
injects services (couples presentation to services, hurts testability).

## Design

### 1. Data model

- Add `albumId?: string` to `Track` (`player.service.ts`) and `BaseSong`
  (`lib/song-results.ts`); `toTrack()` maps it through.
- Song payloads that already carry `albumId` (library list rows) populate it.
  Where absent (some search/network results), **"Go to album" is hidden** — the
  same graceful pattern as "Go to artist" without `artistId`.

### 2. `SongMenuService` (root) — single source of truth

`build(song, ctx): TrackAction[]`. Injects `player`, `playlists`, `preserve`,
`router`, `auth`, `api`, `transferService`, `trackInfo` (§4), `confirm` (§6).

Emits, **in order**, every *common* action whose data exists:

| # | Action | Wiring | Visible when |
|---|--------|--------|--------------|
| 1 | Add to queue | `player.addToQueue(track)` (append) | always |
| 2 | Play next | `player.queueNext(track)` — **new** (insert after current index) | always |
| 3 | Start radio from song | `player.startRadio(track)` — **new** (play track + enable radio; radio seeds from current) | always |
| 4 | Go to artist | `router.navigate(resolveArtistRoute(artistId))` | `artistId` present & `!ctx.hideGoToArtist` |
| 5 | Go to album | `router.navigate(resolveAlbumRoute(albumId))` (helper exists) | `albumId` present & `!ctx.hideGoToAlbum` |
| 6 | Add to playlist | `playlists.openPicker([id])` | always |
| 7 | Save offline | `offlineTrackAction(preserve, track)` (existing helper) | always |
| 8 | Song info | `trackInfo.open(song)` | always |

> "Play" is **not** a menu item — the row title/play-button already plays. Row
> click == Play.

Contextual actions from `SongContext`:

```ts
interface SongContext {
  hideGoToArtist?: boolean;        // set on the artist page (redundant there)
  hideGoToAlbum?: boolean;         // set on the album page (redundant there)
  removable?: boolean;             // admin-gated Remove from library
  onRemoveFromPlaylist?: () => void;
  extraActions?: TrackAction[];    // escape hatch for page-unique items
}
```

- `removable && auth.role() === 'admin'` → **Remove from library** (destructive):
  `confirm.ask(...) → api.deleteSongs([id]) → transferService.addDeletedIds([id])`.
  **No local prune** (see §3).
- `onRemoveFromPlaylist` → **Remove from playlist** (playlist page). The row's
  existing `showRemove` "X" affordance stays; this is the menu equivalent.
- `extraActions` appended last.

Order number and the multiselect checkbox stay as `TrackRowComponent` inputs
(`indexLabel`, `selectable`/`selected`), controlled by the page — they are row
chrome, not menu actions.

### 3. Remove unification (kills the 4× copy-paste)

`SongMenuService` owns confirm + delete + `addDeletedIds`. **Every** listing
filters its rendered rows through `transferService.deletedSongIds()` (already
done in album + genre; extended to artist, playlist, downloads, search-local).
Delete the per-page `askConfirm → deleteSongs → prune` closures and the manual
`.update(filter)` prunes.

### 4. Global `TrackInfoService` + `TrackInfoHost`

The track-info sheet is currently mounted only inside `now-playing`
(`trackInfoSongId`). Move the mount into **one** global host component in the app
layout, driven by a root `TrackInfoService.open(song | id)` /
`close()` (a `signal<Song | string | null>`). `now-playing` calls the same
service instead of owning the mount. This lets "Song info" open from any row.

### 5. Selection unification

- **Downloads migrates onto `createSelection()`**, dropping bespoke `selected`
  Set + `toggleSelect`/`selectAll`. It keeps a **second** `createSelection()`
  instance for the preserved-tracks list (two independent lists on one page).
- All list pages render `SelectionBarComponent`. Add a `canPreserve` input +
  `preserve` output so the bar mirrors the row's common set:
  **Play, Queue, Add to playlist, Save offline, Download, Delete**. **No bulk
  radio** (radio-from-a-set is not a meaningful operation).
- Search stays selection-less (network + local mixed results) unless a follow-up
  wants it; out of scope here.

### 6. Root `ConfirmService`

Introduce a minimal global `ConfirmService` + one confirm modal in the layout:
`confirm.ask(message): Promise<boolean>` (or callback form matching existing
usage). `SongMenuService` uses it for Remove. Existing per-page `askConfirm`
modals migrate to it opportunistically (the ones touched by this change:
album/artist/genre/downloads Remove paths). Not a mandate to rip out every
unrelated confirm.

## Testing (Quality Gate 1 — every change tested, in CI)

Unit (vitest, `*.spec.ts` — auto-globbed, runs in `ci`):

- `SongMenuService.build` — action set per `ctx`/data:
  - Go-to-album hidden without `albumId`; present with it.
  - Go-to-artist hidden without `artistId` and when `hideGoToArtist`.
  - Go-to-album hidden when `hideGoToAlbum`.
  - Remove absent for non-admin; present for admin + `removable`.
  - Common 8 present in order; `extraActions` appended.
- `PlayerService.queueNext` (insert-after-current) and `startRadio`
  (plays track + `radio()` true).
- `TrackInfoService` open/close state; `ConfirmService` ask/resolve.
- Downloads selection migration: existing selection specs cover
  `createSelection`; add a spec asserting Downloads bulk delete uses it.

e2e (Playwright, `e2e` job — new `data-testid`s on menu items):

- Open a library row `⋯` menu, assert common items render.
- "Go to album" navigates to `/library/albums/:id`.
- Admin "Remove" makes the row disappear (via `deletedSongIds`).

## Docs (Quality Gate 3 — same change)

- New `docs/song-actions.md`: the catalog, `SongContext`, the Remove/`deletedSongIds`
  contract, `TrackInfoService`/host, selection unification, `ConfirmService`.
- One-line index entry in `CLAUDE.md` (Key Design Patterns) pointing at it.
- Update `docs/web-ui.md` where it references the track-row/selection so it stays
  consistent.

## Out of scope

- Search-results multiselect.
- Any server/API change (all actions use existing endpoints:
  `deleteSongs`, radio seeding, playlist picker).
- Reworking the track-info sheet's internals.

## File touch list (indicative)

- `player.service.ts` — `albumId` on `Track`; `queueNext`, `startRadio`.
- `lib/song-results.ts` — `albumId` on `BaseSong`; `toTrack` mapping.
- `lib/route-utils.ts` — `resolveAlbumRoute` (exists).
- `services/song-menu.service.ts` — **new**.
- `services/track-info.service.ts` + `components/track-info-host/*` — **new**.
- `services/confirm.service.ts` + confirm modal — **new**.
- `components/selection-bar/*` — `canPreserve`/`preserve`.
- `components/now-playing/*` — delegate info-sheet to service.
- Pages: `album-detail`, `artist-detail`, `genre-detail`, `playlist-detail`,
  `search`, `downloads` — route menus through `SongMenuService`, filter through
  `deletedSongIds()`, migrate Downloads selection.
