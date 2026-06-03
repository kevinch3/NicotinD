# Library Scanner, Streaming & Cover Art

## Native library scanner

`LibraryScanner` (`packages/api/src/services/library-scanner.ts`) replaces the old `NavidromeSyncer`. `scanFull()` walks the music dir and reads tags via `music-metadata` (loaded through the optional-dep `music-metadata-loader.ts`, degrading to path inference if absent); `scanPaths()` does an incremental scan of a just-organized batch. It writes `library_albums`/`library_songs`/`library_artists`/`library_genres` directly.

**Deterministic IDs**: `songId = sha1(relPath)`, `albumId = sha1(albumGroupKey(artist, album))`, `artistId = sha1(normalizeArtistForGrouping(artist))`. Artist IDs use `normalizeArtistForGrouping` (diacritics + case + whitespace only — punctuation preserved) so "Miranda!" and "Miranda" remain distinct; album IDs use `normalizeForGrouping` on the title (also strips punctuation so `¡Bang!…` variants collapse to one card). Edition and punctuation-variant folders collapse to one album at scan time — the duplicate-card merge is inherent to grouping, not a post-hoc reconciliation.

Curation columns (`hidden`/`classification`/`manual_override`/`starred`) are keyed on the stable id and preserved across rescans; a full scan prunes rows whose paths no longer exist on disk. The whole flow is synchronous from the caller's view, so the former async-scan races are gone.

**Clean tracklist (one best file per track)**: before building rows, `buildLibrary` runs every album's files through `selectAlbumTracks` (`library-track-select.ts`) so the *consumed* library is always one best-quality file per track regardless of on-disk mess — Soulseek folders routinely accumulate flac + mp3 + m4a + wav copies of the same songs, plus foreign/mislabeled rips.

- **With a canonical Lidarr tracklist** (from `album_jobs`, mapped by `albumIdFor` in `canonicalByAlbum()`): each file is keyed to the canonical track it matches (diacritic-insensitive `titlesOverlap`), the best format wins (`formatQuality` lossless > lossy, bitrate breaks ties), and files matching **no** canonical track are **dropped** ("as Lidarr proposes" — foreign tracks don't pollute the album).
- **Without one**: files collapse by normalized title (format-dups merge; nothing dropped as foreign).

Non-destructive: unselected files stay on disk but get no `library_songs` row, so a full scan's prune makes them invisible. Physical cleanup is `scripts/repair-album-folders.ts`. Incremental `scanPaths` selects within its batch; the full scan is authoritative.

**Album card de-duplication (inherent to the scanner)**: the pure helpers in `album-grouping.ts` (`normalizeForGrouping` strips diacritics, punctuation, a curated set of edition qualifiers — remaster/deluxe/anniversary/expanded/`(2 CD)`/trailing disc number — and standalone 4-digit years like `(2014)`) feed `albumIdFor(artist, album) = sha1(albumGroupKey(...))`. Every edition/punctuation-variant folder of one release resolves to the **same album id**; songs aggregate onto one `library_albums` row. Display name is the shortest member title (base edition wins over "(Deluxe Edition)"); `song_count`/`duration` are recomputed. Genuinely distinct titles ("Greatest Hits" vs "Greatest Hits II") stay separate — only curated edition keywords are removed, never bare words/numbers.

---

## Native streaming + cover art

`streamingRoutes` (`packages/api/src/routes/streaming.ts`) serves `GET /api/stream/:id` straight from disk via `Bun.file` with HTTP `Range`/`206` support (path looked up from `library_songs.path`, traversal-guarded under the music root). Optional **ffmpeg transcoding** is gated by admin streaming settings (`streaming-settings.ts` in the `app_settings` table; `transcode.ts` spawns ffmpeg, probing availability once).

`GET /api/cover/:id` resolves **canonical artwork first** (see below), then folder art (`cover.jpg`/`folder.jpg`/…), then embedded art, caching extracted/fetched images under `dataDir/cover-cache`. For an **album** id with no canonical art, the disk fallback picks the album's **first track** (`ORDER BY disc, track`) as the representative — *not* an arbitrary `LIMIT 1` row — so the album shows track 1's folder cover (the real album art) rather than a wrong thumbnail from a mislabeled sibling file.

---

## Canonical artwork

Soulseek rips often carry missing/low-res/wrong embedded art; audio files carry no artist photo at all. Fix: the `library_artwork(id, kind, cover_url, updated_at)` table stores canonical URLs keyed on the **same deterministic ids the scanner mints** (`albumIdFor`/`artistIdFor`) — kept off the scanner-managed tables on purpose, so it survives full rescans/prunes untouched and can be written at hunt time *before* the album is scanned onto disk.

`artwork-store.ts` exposes:
- `resolveArtwork` — direct album/artist hit, or song→album mapping so a per-track request (e.g. the player) resolves the album cover
- `setArtwork` — upsert + purge stale `c_<key>` cache when the URL changes
- Lidarr image pickers

The cover route prefers `resolveArtwork` → lazily fetches the remote URL into a `c_<key>` cache namespace → serves it; only if no URL exists or the fetch fails does it fall back to on-disk art.

The scanner sets album `coverArt = albumId` and artist `coverArt = artistId` (songs keep their own id) so requests key the store correctly.

**Population**:
1. `hunt-download` writes album + artist artwork from the Lidarr payload.
2. `scripts/backfill-artwork.ts` (dry-run default, `--apply`) backfills the existing library by matching artists via `artist_discography_links`/name and albums via edition-stripped group key against the monitored Lidarr list (`artwork-backfill.ts`).

Two opt-in passes widen coverage when the artist isn't monitored:
- `--album-lookup`: targeted per-album `album.lookup("<artist> <album>")` for substantial albums (default >3 tracks, `--min-tracks N`) still missing art — skips Singles/Various-Artists junk.
- `--lookup-missing`: slow per-artist lookup for every non-monitored artist (pathological on a large library, hence off by default).

The web renders artist thumbnails via `CoverArtComponent` (gradient+initial fallback preserved) in the artists grid and artist-detail header.
