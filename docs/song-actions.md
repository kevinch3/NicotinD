# Unified song listings

Every song listing renders one `TrackRowComponent` and draws its `⋯` menu from
one root `SongMenuService.build(song, ctx)` — the single source of truth for a
song's actions. This prevents the per-page menu drift that previously left
"Go to album", "Start radio", "Add to queue", "Play next" and "Song info"
missing everywhere and "Go to artist" on only some pages.

## Common actions (always present when the data supports them)

Order: Add to queue → Play next → Start radio → Go to artist* → Go to album* →
Add to playlist → Save offline → Song info.
(*artist/album links appear only when the song carries `artistId`/`albumId` and
the context doesn't hide them.)

- **Play** is not a menu item — the row title/play button already plays.
- **Start radio** = `PlayerService.startRadio(track)` (play the seed + enable radio).
- **Add to queue** appends; **Play next** = `PlayerService.queueNext(track)` (insert after current).
- **Song info** opens the global track-info sheet via `TrackInfoService.open()`
  (sheet mounted once in the layout as `TrackInfoHost`).

## Contextual actions (`SongContext`)

- `hideGoToArtist` / `hideGoToAlbum` — suppress the redundant link on the
  artist / album page.
- `removable` — admin-only **Remove from library**: `ConfirmService.ask` →
  `api.deleteSongs` → `transferService.addDeletedIds`. **No per-page prune** —
  every listing filters rendered rows through `transferService.deletedSongIds()`.
- `onRemoveFromPlaylist` — **Remove from playlist** (playlist page).
- `extraActions` — page-unique items, appended last.

## Selection

Multi-select is one `createSelection()` per list (see `lib/selection.ts`) +
`SelectionBarComponent`. The bar's bulk set mirrors the row's common actions
(Play, Queue, Add to playlist, Save offline, Download, Delete via capability
flags). Downloads uses `createSelection()` too (one instance per list it shows).
