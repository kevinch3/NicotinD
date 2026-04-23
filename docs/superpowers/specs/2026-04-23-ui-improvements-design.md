# NicotinD UI Improvements — Design Spec

**Date**: 2026-04-23  
**Status**: Approved

---

## Overview

Five improvements across the Angular web UI: two bug fixes with identified root causes, two enhancements to simplify the nav and remote playback, and a routing feature that is 90% complete in the working tree.

---

## Bug 1 — Search folder state resets on tab navigation

### Root cause
`openBrowserKey` is a `signal<string | null>(null)` declared inside `SearchComponent`. Angular's router destroys the component on navigation away and creates a fresh instance on return — resetting the signal to `null` every time.

### Fix
Add `openBrowserKey = signal<string | null>(null)` to `SearchService` (a root-level singleton). `SearchComponent` reads and writes `search.openBrowserKey` directly. No other changes required.

**Files**: `search.service.ts`, `search.component.ts`

---

## Bug 2 — Downloads Active tab always empty

### Root cause
`TransferService.startPolling()` is defined but never called anywhere in the app. The `downloads` signal is permanently `[]`. The Active tab renders nothing because `inProgressGroups()`, `errorGroups()`, and `doneGroups()` are all empty arrays derived from the empty `downloads` signal.

Secondary issue: the Active tab has no empty-state message when there are genuinely no active downloads.

### Fix
1. `LayoutComponent` implements `OnInit` / `OnDestroy` and calls `transferService.startPolling()` / `stopPolling()`. The auth shell is the correct host: it is alive for the entire authenticated session, keeping transfer status populated across all pages (search result progress cards also benefit).
2. Add an empty-state `<p>` to the Active tab for when all three group arrays are empty.

**Files**: `layout.component.ts`, `downloads.component.html`

---

## Enhancement 3 — Remove global search bar from nav

The nav bar carries a duplicate search input (desktop + mobile drawer) that navigates to `/` on submit. The Search page has its own full-featured search bar. The nav bar version adds visual noise without meaningful value.

### Fix
- Remove both `<form>` elements (desktop slot and mobile drawer section) from `layout.component.html`.
- Remove `submitSearch()` method from `LayoutComponent`.
- Remove `SearchService` injection and `FormsModule` from `LayoutComponent` — verify the template has no remaining `search.*` or `[(ngModel)]` references first.

**Files**: `layout.component.html`, `layout.component.ts`

---

## Enhancement 4 — Simplify remote playback

### Goal
Binary on/off. When disabled: zero UI, zero WS activity, zero logic running. When enabled: device switcher visible in player, WS connected. Auto-disable with explanation on persistent connection failure.

### Changes

#### 4a — WS gated by toggle
In `RemotePlaybackService.initialize()`, the existing `effect()` that calls `ws.connect()` currently triggers on any auth token. Change to: connect only when `remoteEnabled() && token`, disconnect when either becomes falsy.

```typescript
effect(() => {
  const token = this.auth.token();
  const enabled = this.remoteEnabled();
  if (token && enabled) {
    this.ws.connect();
  } else {
    this.ws.disconnect();
  }
});
```

#### 4b — UI hidden when disabled
In `player.component.html`, wrap `<app-device-switcher />` in `@if (remote.remoteEnabled())`. No hint of remote playback shown when off.

#### 4c — Auto-disable on persistent failure
`PlaybackWsService` gains:
- `private didOpenSuccessfully = false` — set to `true` in `onopen`, reset to `false` before each `connect()` call
- `private consecutiveFailures = 0` — incremented in `onclose` when `!didOpenSuccessfully`, reset to `0` in `onopen`
- `readonly persistentFailure = signal<string | null>(null)` — set to a human-readable reason after 5 consecutive failures; cleared in `onopen` and via a new `clearPersistentFailure()` method

`RemotePlaybackService` gains:
- `readonly disabledReason = signal<string | null>(null)`
- An `effect()` that watches `ws.persistentFailure()`: if truthy and `remoteEnabled()` is true, calls `setRemoteEnabled(false)` and copies the reason to `disabledReason`
- `setRemoteEnabled(true)` clears `disabledReason` and calls `ws.clearPersistentFailure()` before the WS reconnects

`settings.component.html` (Remote Playback section): show an amber notice below the toggle when `!remote.remoteEnabled() && remote.disabledReason()`:
> *"Remote playback was automatically disabled: [reason]"*

**Files**: `playback-ws.service.ts`, `remote-playback.service.ts`, `player.component.html`, `settings.component.html`

---

## Feature — Granular routing (albums, genres, artists)

### Current state (90% done in working tree)
Already in place:
- `route-utils.ts`: `resolveArtistRoute`, `resolveAlbumRoute`, `resolveGenreRoute` helpers + specs
- `album-detail.component.ts` + `.html`: standalone album page (full track list, play, remove, playlist)
- `genre-detail.component.ts` + `.html`: standalone genre page (track list, play, remove, playlist)
- `app.routes.ts`: routes registered for `/library/albums/:id`, `/library/artists/:id`, `/library/genres/:slug`
- `library.component.html`: already uses `[routerLink]="getAlbumLink(album.id)"` and `[routerLink]="getGenreLink(genre.value)"`
- `artist-detail.component.ts`: already navigates to album via `resolveAlbumRoute`

### What is missing

#### 5a — Library component methods
`library.component.ts` is missing `getAlbumLink(id: string)` and `getGenreLink(slug: string)` methods. Template calls them but they don't exist. Add:

```typescript
getAlbumLink(id: string): string[] { return resolveAlbumRoute(id); }
getGenreLink(slug: string): string[]  { return resolveGenreRoute(slug); }
```

Import `resolveAlbumRoute` and `resolveGenreRoute` from `../../lib/route-utils`.

#### 5b — Remove dead inline state from LibraryComponent
All inline album/genre detail UI has been removed from the template. The following are now dead code in `library.component.ts` and must be removed:

Signals: `selectedAlbum`, `loadingAlbum`, `selectedGenre`, `genreSongs`, `loadingGenreSongs`, `playlistPickerSong`, `addingToPlaylistLib`, `confirmMessage`, `confirmCallback`

Computeds: `detailSongs`, `showConfirm`

Controls: `detailSortOptions`, `detailControls`

Methods: `openAlbum`, `playSong`, `playAlbum`, `toTrackFromSong`, `removeAlbum`, `albumTrackActions`, `openGenre`, `playGenre`, `genreTrackActions`, `addSongToPlaylist`, `createLibraryPlaylistAndAdd`, `askConfirm`, `onConfirm`, `onCancelConfirm`

Remove unused imports: `ActivatedRoute` (route query param logic for `?album=` also removed), `AlbumDetail`, `Song`, `TrackRowComponent`, `ConfirmDialogComponent`, `PlaylistAutocompleteComponent`, `toTrack`.

`ngOnInit` simplifies to just fetch albums + conditionally fetch artists/genres.

**Files**: `library.component.ts`, `route-utils.ts` (already done), `app.routes.ts` (already done)

---

## Route map (final state)

| URL | Component |
|-----|-----------|
| `/` | SearchComponent |
| `/downloads` | DownloadsComponent |
| `/playlists` | PlaylistsComponent |
| `/library` | LibraryComponent (Albums/Artists/Genre grid) |
| `/library/albums/:id` | AlbumDetailComponent |
| `/library/artists/:id` | ArtistDetailComponent |
| `/library/genres/:slug` | GenreDetailComponent |
| `/settings` | SettingsComponent |
| `/admin` | AdminComponent |
