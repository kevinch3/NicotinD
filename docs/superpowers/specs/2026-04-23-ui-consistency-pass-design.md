# UI Consistency Pass — Design Spec

**Date:** 2026-04-23  
**Status:** Approved

## Context

Several areas of the NicotinD web UI have accumulated inconsistencies:
- A per-page search toolbar is hidden behind a magnifying-glass icon toggle instead of being always visible
- Playlist titles use hardcoded zinc colors that wash out on light themes (Daylight, Warm Paper, E-Ink)
- Track names in `track-row` and the filter toolbar use hardcoded zinc colors, causing low contrast on light themes
- "Saved Offline" and "Recently Added" are logically the same concept to the user but look and behave completely differently
- "Add to playlist" action only exists in Downloads > Recently Added, not in Library album/genre track lists

---

## Bug 1 — Search Toolbar Always Visible

### Problem
`app-list-toolbar` (search input + sort controls) is guarded by `@if (isToolbarVisible())` and revealed only by clicking a small magnifying-glass icon. Affects: Library > Albums grid, Library > Artists, Library > Album detail, Downloads > Recently Added.

### Fix
Remove the `@if` guard and the icon-button trigger in every location. Always render the toolbar inline. Remove the dismiss (X) button from the toolbar since it has no purpose when the toolbar is permanent. Clean up now-dead state from `ListControlsService`.

### Files
| File | Change |
|------|--------|
| `packages/web/src/app/pages/library/library.component.html` | Remove lupe buttons + `@if (isToolbarVisible())` for Albums grid, Artists, and Album detail |
| `packages/web/src/app/pages/downloads/downloads.component.html` | Remove lupe button + `@if (recentControls.isToolbarVisible())` for Recently Added |
| `packages/web/src/app/components/list-toolbar/list-toolbar.component.html` | Remove X/dismiss button and `dismiss` output binding |
| `packages/web/src/app/components/list-toolbar/list-toolbar.component.ts` | Remove `dismiss` output |
| `packages/web/src/app/services/list-controls.service.ts` | Remove `isToolbarVisible`, `showToolbar()`, `hideToolbar()` from interface + implementation |

---

## Bug 2 — Playlist Title Invisible on Light Themes

### Problem
`playlists.component.html` uses hardcoded `text-zinc-100` for the selected playlist title (line 23) and `text-zinc-200` for playlist grid card names (line 189). These are near-invisible on light themes.

### Fix
Replace with `text-theme-primary` throughout the playlists component.

### Files
| File | Change |
|------|--------|
| `packages/web/src/app/pages/playlists/playlists.component.html` | `text-zinc-100` → `text-theme-primary`, `text-zinc-200` → `text-theme-primary` (all playlist name text) |

---

## Bug 3 — Track Name Low Contrast on Light Themes

### Problem
- `track-row.component.html` line 15: track title uses `text-zinc-200` (hardcoded light gray — invisible on light themes)
- `list-toolbar.component.html`: filter input text (`text-zinc-200`), background (`bg-zinc-900/50`), border (`border-zinc-800/50`), sort select (`bg-zinc-800 text-zinc-300`) all hardcoded — toolbar looks broken on light themes

### Fix
Replace all hardcoded zinc colors with theme CSS custom properties.

| Element | Old | New |
|---------|-----|-----|
| Track title in `track-row` | `text-zinc-200` | `text-theme-primary` |
| Toolbar background | `bg-zinc-900/50` | `bg-theme-surface` |
| Toolbar border | `border-zinc-800/50` | `border-theme` |
| Filter input text | `text-zinc-200` | `text-theme-primary` |
| Filter input placeholder | `placeholder-zinc-600` | `placeholder:text-theme-muted` |
| Sort select background | `bg-zinc-800` | `bg-theme-surface-2` |
| Sort select border | `border-zinc-700/50` | `border-theme` |
| Sort select text | `text-zinc-300` | `text-theme-secondary` |
| Icon/button color | `text-zinc-500` | `text-theme-muted` |
| Icon/button hover | `hover:text-zinc-300` | `hover:text-theme-secondary` |
| Result count | `text-zinc-600` | `text-theme-muted` |

### Files
| File | Change |
|------|--------|
| `packages/web/src/app/components/track-row/track-row.component.html` | Track title class: `text-zinc-200` → `text-theme-primary` |
| `packages/web/src/app/components/list-toolbar/list-toolbar.component.html` | All zinc colors → theme variables (see table above) |

---

## Enhancement 1 — "Saved Offline" Visual Parity with "Recently Added"

### Problem
The two tabs represent the same concept (my music) but look completely different:
- Recently Added: multiselect checkboxes, bulk action bar, bitrate · duration · date columns, per-track context menu
- Saved Offline: plain list, single delete icon, only title + artist/album + file size

### Schema Change (Option B — full parity)

Add `bitRate?: number` to the preserve data pipeline:

1. **`Track` interface** (`player.service.ts`) — add `bitRate?: number`
2. **`BaseSong`** (`track-utils.ts`) — add `bitRate?: number`; propagate through `toTrack()`
3. **`PreservedTrackMeta`** (`preserve-store.ts`) — add `bitRate?: number`; bump `DB_VERSION` to `2`
   - Migration note: `onupgradeneeded` is a no-op for version 2 (adding an optional field to a schemaless object store requires no structural changes; existing records simply lack the field and will read back as `bitRate: undefined`)
4. **`preserve.service.ts`** — capture `track.bitRate` into the meta object at save time

`bitRate` is already present on `Song` (`api.service.ts` line 105) so it flows through all existing library/search paths automatically once `Track` and `BaseSong` gain the field.

### UI Changes — Saved Offline section (`downloads.component.html`)

Rewrite the Saved Offline track list to match Recently Added layout exactly:

**New columns (matching Recently Added):**
- Checkbox (multiselect)  
- Title (text-theme-primary)  
- Artist · Album (text-theme-muted)  
- Bitrate (`bitRate + 'k'`, hidden on mobile)  
- Duration (`formatDuration(track.duration)`)  
- Saved date (`timeAgo(track.preservedAt)`, hidden on smaller screens)  
- Per-track hover actions (play if available, remove)  
- Context menu "..." with: "Add to playlist", "Remove from device"

**Bulk action bar (appears when items selected):**
- "N selected" label
- "Add to playlist" → opens `app-playlist-autocomplete`
- "Remove from device" → removes from IndexedDB

**Sort/filter controls:**
- Wire up a new `offlineControls` via `ListControlsService.connect()` using `preservedTracks` as source, search fields: `['title', 'artist', 'album']`, sort options: `[{ field: 'preservedAt', label: 'Saved date' }, { field: 'title', label: 'Title' }, { field: 'artist', label: 'Artist' }]`, default sort: `preservedAt` desc

### New signals/methods in `downloads.component.ts`

```typescript
readonly offlineSelected = signal(new Set<string>());
readonly offlineShowPlaylistPicker = signal(false);
readonly offlineControls = this.listControls.connect({ ... });

selectAllOffline(): void { ... }
removeOfflineTracks(ids: string[]): Promise<void> { ... }   // calls preserve.remove()
addOfflineToPlaylist(playlistId: string): Promise<void> { ... }  // calls api.updatePlaylist()
createOfflinePlaylistAndAdd(name: string): Promise<void> { ... }
offlineTrackActions(track: PreservedTrackMeta): TrackAction[] { ... }
```

### Files
| File | Change |
|------|--------|
| `packages/web/src/app/services/player.service.ts` | Add `bitRate?: number` to `Track` |
| `packages/web/src/app/lib/track-utils.ts` | Add `bitRate?: number` to `BaseSong`; propagate in `toTrack()` |
| `packages/web/src/app/lib/preserve-store.ts` | Add `bitRate?: number` to `PreservedTrackMeta`; bump `DB_VERSION` to 2 |
| `packages/web/src/app/services/preserve.service.ts` | Capture `track.bitRate` in `preserve()` meta |
| `packages/web/src/app/pages/downloads/downloads.component.ts` | Add `offlineControls`, `offlineSelected`, picker signals, and helper methods |
| `packages/web/src/app/pages/downloads/downloads.component.html` | Rewrite Saved Offline section with multiselect, bulk bar, full columns |

---

## Enhancement 2 — "Add to Playlist" on All Track Lists

### Problem
The "Add to playlist" action only exists in Downloads > Recently Added. It should also be available in Library > Albums detail and Library > Genre track lists (both use `app-track-row` with a `TrackAction[]` context menu).

### Fix

**`library.component.ts`:**
- Add `playlistPickerSong = signal<Song | null>(null)` 
- Add `PlaylistAutocompleteComponent` to imports
- Add `addSongToPlaylist(playlistId: string)` → calls `api.updatePlaylist(playlistId, { songIdsToAdd: [this.playlistPickerSong()!.id] })`
- Add `createPlaylistAndAddSong(name: string)` → calls `api.createPlaylist(name, [song.id])`
- Extend `albumTrackActions()` and `genreTrackActions()` with:
  ```typescript
  { label: 'Add to playlist', action: () => this.playlistPickerSong.set(song) }
  ```

**`library.component.html`:**
- Add `app-playlist-autocomplete` overlay (same pattern as downloads) triggered by `playlistPickerSong() !== null`

### Files
| File | Change |
|------|--------|
| `packages/web/src/app/pages/library/library.component.ts` | Add picker signal, imports, `addSongToPlaylist()`, `createPlaylistAndAddSong()`, extend action arrays |
| `packages/web/src/app/pages/library/library.component.html` | Add `app-playlist-autocomplete` overlay |

---

## Verification

1. **Theme check** — switch through all 7 themes in Settings > Appearance; verify playlist titles, track names, and the list toolbar are readable on every theme (especially Daylight, Warm Paper, E-Ink)
2. **Search toolbar** — visit Library > Albums, Library > Artists, Downloads > Recently Added; confirm the filter/sort bar is visible immediately without clicking anything
3. **Saved Offline multiselect** — save a track offline; go to Downloads > Saved Offline tab; verify checkboxes, bulk bar, all columns (bitrate, duration, date), and both bulk actions work
4. **Add to playlist (Library)** — open an album detail or genre track list; right-click / "..." on a track; confirm "Add to playlist" appears and successfully adds the song
5. **DB migration** — open DevTools > Application > IndexedDB; confirm `nicotind-preserve` is now version 2; existing saved tracks show without errors (bitrate will be undefined for pre-migration entries)
