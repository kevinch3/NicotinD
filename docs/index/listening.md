# Playlists, listening & privacy

One section of [the index](../index.md). Entry shape and caps are unchanged and
`bun run check:claude-md` still enforces them here.

- **Native playlists (per-user)**: `playlists`/`playlist_songs` + `PlaylistService`, private per user,
  with sharing and server-side link previews; the detail page adds `SongPickerComponent` and
  token-overlap proposals. → [playlist-generation.md](../playlist-generation.md),
  [web-ui.md](../web-ui.md)
- **Curated playlists (system, global)**: gradient-covered shelves shown to all users, read-only by
  `kind` rather than ownership. → [curated-playlists.md](../curated-playlists.md)
- **Automated playlists**: code-defined `RECIPES` materialized into curated playlists by
  `refreshAutoPlaylists`, with an admin-configurable cadence guarded per period and a
  `runAutoPlaylistsNow` bypass. → [automated-playlists.md](../automated-playlists.md)
- **Playlists page (merged single list)**: one list sorted curated-first with an inline badge and
  per-row actions restricted to user rows. → [playlist-generation.md](../playlist-generation.md)
- **Likes → auto-maintained "Liked Songs" playlist**: a new `PlaylistKind` value makes the playlist
  itself the store, so no new table; `likeSong`/`unlikeSong`/`likedSongIds` behind a per-user
  `LikeService`. → [song-actions.md](../song-actions.md)
- **Listening history (per-user play log)**: append-only `play_events` per playback session; the
  client reports raw facts through `ListeningTrackerService` + a durable `ListeningQueueService`
  outbox, and the **server** owns the counting rule (`countsAsPlay`) so it stays retunable. Endpoints
  take no user id. → [listening-history.md](../listening-history.md)
- **Listening stats**: `listeningStats` + `GET /api/history/stats` back the Library Stats tab
  (`LibraryStatsComponent`) — totals, top songs/artists/albums/genres and an hour clock, all derived
  at read time with no rollup table. → [listening-history.md](../listening-history.md)
- **Privacy & data protection**: consent is opt-out and resolved by the pure
  `resolveHistoryCollection` (env floor → instance → user), enforced server-side;
  `exportUserData` reads columns from `PRAGMA table_info` at runtime; `deleteUserHistory` is scoped to
  `play_events` and does not flip consent. No admin route reads a user's history by design.
  → [privacy.md](../privacy.md)
