# Unified song listings

Every song listing draws its `⋯` menu from one root
`SongMenuService.build(song, ctx)` — the single source of truth for a song's
actions. This prevents the per-page menu drift that previously left
"Go to album", "Start radio", "Add to queue", "Play next" and "Song info"
missing everywhere and "Go to artist" on only some pages. Most listings render
the menu on the shared `TrackRowComponent`; the one exception is the Downloads
"Recently added" list, which keeps its own bespoke row markup but still builds
its menu from the same `SongMenuService`.

## Common actions (always present when the data supports them)

Order: Like/Unlike → Add to queue → Play next → Start radio → Go to artist* → Go to album* →
Add to playlist → Save offline → Song info.
(*artist/album links appear only when the song carries `artistId`/`albumId` and
the context doesn't hide them.)

- **Like / Unlike** (issue #225) leads the menu — a primary gesture. The label
  reflects `LikeService.isLiked(song.id)`; the action calls `LikeService.toggle()`.
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

## Likes → the "Liked Songs" playlist (issue #225)

"Like" is a **per-user** gesture, so it can't reuse the global scanner-derived
`library_songs.starred` column (that's set only by the transcode/ingest path and
is the same for every user). Rather than a dedicated `user_liked_songs` table,
**the Liked Songs playlist itself is the store**: a new `PlaylistKind` value
`liked` (one per user, created lazily on first like). Membership = liked. This
maximizes reuse of the native-playlist surface (visibility, the JOIN that drops
vanished songs, the playlists page) — no new table, no new migration (`kind`
already exists).

- **Backend** (`PlaylistService`): `likeSong` / `unlikeSong` / `likedSongIds` /
  the private `ensureLikedPlaylist`. New likes take a strictly-decreasing
  `position` (`min-1`) so `ORDER BY position ASC` yields newest-first without
  same-millisecond ties. The row is `kind='liked'`, so `list()`/`get()` show it
  (it has the owner's `user_id`, pinned first) while `owns()`/`update()`/`remove()`
  keep their `kind='user'` guard — it's read-only through the CRUD API and
  mutated only via the like routes.
- **Routes** (`routes/library.ts`, auth-gated): `POST`/`DELETE /songs/:id/like`
  and `GET /liked-ids` (one-call hydration). POST 404s an unknown song id.
- **Web** (`LikeService`, providedIn root): holds the liked-id set as a signal;
  `refresh()` (called from the app shell `ngOnInit`, reset on logout) hydrates it;
  `toggle()` is optimistic (reverts on error) and refreshes the playlist list so
  the Liked Songs count stays in sync. The heart renders in `TrackRowComponent`
  (`data-testid="track-like"`, always-visible when liked / hover-reveal
  otherwise; hidden via `[showLike]="false"` in the offline preserve list), the
  track-info sheet (`track-info-like`), and the `⋯` menu. The playlists page
  shows a heart badge (`liked-badge-inline`) and hides Rename/Delete for the
  liked row; the detail page treats `liked` as read-only (`readOnly()` computed).

## Selection

Multi-select is one `createSelection()` per list (see `lib/selection.ts`) +
`SelectionBarComponent`. The bar's bulk set mirrors the row's common actions
(Play, Queue, Add to playlist, Save offline, Download, Delete via capability
flags). Downloads uses `createSelection()` too (one instance per list it shows).

## Testing

`TrackRowComponent`'s menu buttons carry `data-testid="track-action-<Label>"`
(the exact action label, e.g. `track-action-Go to artist`), plus
`track-row-menu-toggle` (the `⋯` button) and `track-row-menu` (the open panel),
so e2e specs can target actions without CSS/text-fragile selectors. The
track-info sheet root carries `data-testid="track-info-sheet"`.
`packages/e2e/tests/song-menu.spec.ts` covers, on an album detail page: the
common-action set + "Go to album" suppression, "Song info" opening the sheet,
and the admin "Remove from library" → `ConfirmHost` (`confirm-dialog`) →
`confirm-ok` → row-removal flow. That spec scopes confirm-dialog selectors to
the `[data-testid="confirm-dialog"]` overlay (unique to the global
`ConfirmHost`) since the legacy per-page `app-confirm-dialog` also exposes a
`confirm-ok` testid.
