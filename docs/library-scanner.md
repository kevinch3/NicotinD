# Library Scanner, Streaming & Cover Art

## Native library scanner

`LibraryScanner` (`packages/api/src/services/library-scanner.ts`) replaces the old `NavidromeSyncer`. `scanFull()` walks the music dir and reads tags via `music-metadata` (loaded through the optional-dep `music-metadata-loader.ts`, degrading to path inference if absent); `scanPaths()` does an incremental scan of a just-organized batch. It writes `library_albums`/`library_songs`/`library_artists`/`library_genres` directly.

**Deterministic IDs**: `songId = sha1(relPath)`, `albumId = sha1(albumGroupKey(artist, album))`, `artistId = sha1(normalizeArtistForGrouping(artist))`. Artist IDs use `normalizeArtistForGrouping` (diacritics + case + whitespace only — punctuation preserved) so "Miranda!" and "Miranda" remain distinct; album IDs use `normalizeForGrouping` on the title (also strips punctuation so `¡Bang!…` variants collapse to one card). Edition and punctuation-variant folders collapse to one album at scan time — the duplicate-card merge is inherent to grouping, not a post-hoc reconciliation.

Curation columns (`hidden`/`classification`/`manual_override`/`starred`) are keyed on the stable id and preserved across rescans; a full scan prunes rows whose paths no longer exist on disk. The whole flow is synchronous from the caller's view, so the former async-scan races are gone. `classification` is the **release type** (`album`/`ep`/`single`/`compilation`/`unknown`) — set by `LibraryCurator` metadata-first (Lidarr `albumType` from the `library_release_meta` side table, keyed on `albumId` like `library_artwork`) with a track-count heuristic fallback. See [download-pipeline.md](download-pipeline.md#release-type-model--albums-eps--singles-spotify-style).

**Loose singles**: `resolveTags` calls the exported pure `isLooseSinglesBucket(dir, album)` — a track with no usable album (`Unknown Album`) or one in the synthetic `<Artist>/Singles/` bucket gets `album = title`, so each loose track mints its own single album (`albumIdFor(artist, title)`) and surfaces as its own card rather than collapsing into a hidden per-artist bucket. Format-dups of the same single still merge via the shared title group key.

**Metadata overrides (user-confirmed corrections)**: `resolveTags` also consults a `library_metadata_overrides` map (loaded by `scanFull`/`scanPaths`, threaded through `buildLibrary`/`selectLibraryTracks` as a pure `overrides` parameter). After deriving the raw artist/album from tags, it computes the raw `albumIdFor(artist, album)`, looks up an override, and substitutes the corrected `artist`/`album`/`year` **before** the artistId/albumId are minted — so a fix re-buckets the album under the correct artist. The key is the *raw* (tag-derived) id, which the scanner reproduces every scan (tags never change), so corrections survive full rescans without moving files. See [metadata-optimize.md](metadata-optimize.md) "User-driven fix".

**Clean tracklist (one best file per track)**: before building rows, `buildLibrary` runs every album's files through `selectAlbumTracks` (`library-track-select.ts`) so the *consumed* library is always one best-quality file per track regardless of on-disk mess — Soulseek folders routinely accumulate flac + mp3 + m4a + wav copies of the same songs, plus foreign/mislabeled rips.

- **With a canonical Lidarr tracklist** (from `album_jobs`, mapped by `albumIdFor` in `canonicalByAlbum()`): each file is keyed to the canonical track it matches (diacritic-insensitive `titlesOverlap`), the best format wins (`formatQuality` lossless > lossy, bitrate breaks ties), and files matching **no** canonical track are **dropped** ("as Lidarr proposes" — foreign tracks don't pollute the album).
- **Without one**: files collapse by normalized title (format-dups merge; nothing dropped as foreign).

Non-destructive: unselected files stay on disk but get no `library_songs` row, so a full scan's prune makes them invisible. Physical cleanup is `scripts/repair-album-folders.ts`. Incremental `scanPaths` selects within its batch; the full scan is authoritative.

**Album card de-duplication (inherent to the scanner)**: the pure helpers in `album-grouping.ts` (`normalizeForGrouping` strips diacritics, punctuation, a curated set of edition qualifiers — remaster/deluxe/anniversary/expanded/`(2 CD)`/trailing disc number — and standalone 4-digit years like `(2014)`) feed `albumIdFor(artist, album) = sha1(albumGroupKey(...))`. Every edition/punctuation-variant folder of one release resolves to the **same album id**; songs aggregate onto one `library_albums` row. Display name is the shortest member title (base edition wins over "(Deluxe Edition)"); `song_count`/`duration` are recomputed. Genuinely distinct titles ("Greatest Hits" vs "Greatest Hits II") stay separate — only curated edition keywords are removed, never bare words/numbers.

**VA / compilation handling (album artist vs track artist)**: `resolveTags` returns both `albumArtist` (for album grouping and `library_artists` ownership) and `trackArtist` (for `library_songs.artist`). When `albumArtist` matches VA patterns (`isVariousArtists` from `compilation-tagger.ts` — "Various Artists", "VA", "V.A.", etc.), the per-track `artist` tag is used as `trackArtist` so individual performers are preserved. `library_songs` stores both via `artist`/`artist_id` (track-level) and `album_artist`/`album_artist_id` (album-level) columns. `library_artists` rows are only created from album ownership (the accumulator in `buildLibrary`), so track-only artists on compilations don't pollute the artist list.

**Compilation detection** (`compilation-tagger.ts`): `classifyFolder` uses first-match-wins heuristics — COMPILATION flag or VA `albumArtist` in tags → compilation; coherent album + single artist → leave-alone; single-artist consensus → single-artist; folder name matches VA patterns → compilation; coherent album + ≥3 distinct artists → compilation; ≥5 distinct artists → compilation; large untagged dump → compilation. The "coherent album + multi-artist" rule is the key fix for well-tagged VA compilations (all tracks share one album name but have different artists).

**Compilations in the UI**: The main `/albums` grid excludes compilations (`classification = 'album'` only). Compilations have a dedicated `GET /api/library/compilations` endpoint and a "Compilations" tab in the library view. "Various Artists" is hidden from the `/artists` list. Artist pages show an "Appears On" tab listing compilation albums where the artist has tracks (`GET /api/library/artists/:id/appears-on`).

**Multi-artist support**: Songs and albums can have multiple artist associations via join tables (`library_song_artists`, `library_album_artists`). Each link carries a `role` (`primary` or `featuring`) and a `position` for ordering. The parser (`artist-split.ts`) extracts featuring credits (`feat.`, `ft.`, `featuring`, `with`) and splits primary artists on delimiters (` & `, `, `, ` / `, ` + `, ` and `, ` x `, ` y `, ` con `, ` vs `). A **cross-reference guard** prevents false splits: `buildLibrary` collects all raw artist strings in a first pass; if the full string (e.g., "Earth, Wind & Fire") already exists as-is in the library, it's not split. The existing `artist`/`artist_id` columns on songs/albums remain as the primary artist for backward compat; the join tables provide the full multi-artist picture. Artist-detail and songs queries use `OR id IN (SELECT ... FROM library_song_artists WHERE artist_id = ?)` to include multi-artist associations. The API attaches an `artists` array (`{ id, name, role }[]`) to song and album responses via `attachSongArtists`/`attachAlbumArtists` (batch helpers in `artist-attach.ts`). The frontend renders linked names via `ArtistLinksComponent` — each artist name is a clickable `routerLink`, separated by delimiters (` & ` for primaries, ` feat. ` prefix for featuring). Backfill is a full rescan (`POST /api/library/sync`), which populates the join tables through the normal `buildLibrary → persist` pipeline.

---

## Native streaming + cover art

`streamingRoutes` (`packages/api/src/routes/streaming.ts`) serves `GET /api/stream/:id` straight from disk via `Bun.file` with HTTP `Range`/`206` support (path looked up from `library_songs.path`, traversal-guarded under the music root). Optional **ffmpeg transcoding** is gated by admin streaming settings (`streaming-settings.ts` in the `app_settings` table; `transcode.ts` spawns ffmpeg, probing availability once).

`GET /api/cover/:id` resolves a **manual artist override first** (see "Artist images" below), then **canonical artwork** (see below), then folder art (`cover.jpg`/`folder.jpg`/…), then embedded art, caching extracted/fetched images under `dataDir/cover-cache`. For an **album** id with no canonical art, the disk fallback picks the album's **first track** (`ORDER BY disc, track`) as the representative — *not* an arbitrary `LIMIT 1` row — so the album shows track 1's folder cover (the real album art) rather than a wrong thumbnail from a mislabeled sibling file.

**Artist ids never fall back to a track's album art.** `resolvePath` has *no* `artist_id` branch: an artist id (a distinct sha1 namespace, never matched by `album_id`) with no override and no canonical poster resolves to **404**, so `CoverArtComponent` shows the neutral initial-on-gradient tile. A representative track's cover is a *wrong* face for an artist (often an old/misleading release) — worse than the clean placeholder.

Successful cover responses carry `Cache-Control: public, max-age=86400` so the browser caches them and navigation stops re-requesting every tile — the connection-pool pressure that otherwise stalled album pages. The remote canonical fetch (`fetchRemoteCover`) is bounded by `AbortSignal.timeout` (6 s) so a slow/dead Lidarr URL can't hang a request (and a browser connection slot); on timeout it falls through to on-disk art. Negative (artless) results are still short-circuited by the module-level `noArtCache` (10 min TTL).

`GET /api/cover/:id?embedded=1` is a special mode that serves **only** the file's embedded picture — skipping both canonical and folder art — for a *song* id, cached under a distinct `<id>~emb` key. It backs the Fix-metadata cover picker (so a user can preview/choose the artwork baked into a specific track); extraction is the shared `extractEmbeddedPicture` (`services/cover-sources.ts`), which the normal `extractCover` also delegates to for its embedded fallback. See [metadata-optimize.md](metadata-optimize.md) "Cover picker".

The album/EP **detail track list omits the per-track thumbnail** (every row shares the album cover): `TrackRowComponent`'s `showCover` input is `false` there, cutting ~12–20 identical cover requests per page. Mixed-album lists keep it `true`.

**Sized thumbnails (the "covers load super slow" fix)**: the cover route used to serve the *full-resolution* source image for every slot — a multi-MB album cover shipped to render a 40px player thumbnail — because it ignored the `size=` the web already sends. It now snaps `size=` to a small bucket set via `bucketCoverSize` (`services/cover-thumbnail.ts`, `{40,80,160,320,640}`; absent/over-max ⇒ original) and serves a resized **WebP** (`resizeCover`, lazy `import('sharp')`) cached at `<baseKey>@<size>.<ext>` in the shared `cover-cache` dir — so repeat thumbnail hits are one small file read, and a resize failure transparently falls back to the original. `purgeCanonicalCache` (`artwork-store.ts`) prefix-deletes every `c_<key>@<size>` variant too, so a corrected cover leaves no stale thumbnails. Frontend: `CoverArtComponent`'s `<img>` is `loading="lazy"` (`coverLoadingAttr`, override with the `eager` input) + `decoding="async"`.

**Transcoded streams are seekable**: on-the-fly transcoding used to be a sequential ffmpeg *pipe* (status 200, no `Content-Length`/`Accept-Ranges`), so far seeks did nothing (the iOS/Firefox "seek to the end does nothing" bug — acute because the Opus standardization means iOS *needs* transcoding to play at all). `transcode-cache.ts` (`getTranscodedFile`) now transcodes the whole file **once** to a disk cache (`<dataDir>/transcode-cache`, keyed on source path+**mtime**+format+bitrate so a re-encode invalidates it; concurrent plays de-duped via an in-flight map; oldest-first eviction over a 2 GiB soft budget), and **both** the transcode and passthrough paths serve through the shared `serveFileWithRange()` helper — so every stream advertises ranges and seeks correctly. `transcode.ts` `transcodeToFile()` writes atomically (temp + rename). First play warms the cache; replays are instant and seekable.

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
2. The **`artist-image` windowed enrichment task** auto-fills artist posters in the background — see [library-processing.md](library-processing.md). It's the standing population path; the script below remains for one-shot/manual runs.
3. `scripts/backfill-artwork.ts` (dry-run default, `--apply`) backfills the existing library by matching artists via `artist_discography_links`/name and albums via edition-stripped group key against the monitored Lidarr list (`artwork-backfill.ts`).

Two opt-in passes widen coverage when the artist isn't monitored:
- `--album-lookup`: targeted per-album `album.lookup("<artist> <album>")` for substantial albums (default >3 tracks, `--min-tracks N`) still missing art — skips Singles/Various-Artists junk.
- `--lookup-missing`: slow per-artist lookup for every non-monitored artist (pathological on a large library, hence off by default).

The web renders artist thumbnails via `CoverArtComponent` (gradient+initial fallback preserved) in the artists grid and artist-detail header.

### Artist images (auto + manual override)

Artist photos come from two layers, both keyed on `artistIdFor(name)` so they survive rescans:

- **Auto (canonical)** — `resolveArtistImageUrl` (`services/artist-image.ts`) resolves a real portrait **Lidarr poster first, Spotify portrait as fallback** (see [spotify-fallback.md](spotify-fallback.md)), shared by the manual backfill script and the windowed `artist-image` task. The result is a `library_artwork(kind='artist')` URL the cover route fetches.
- **Manual override** — a user (admin) can **upload** a photo or **copy one of the artist's album covers**, stored as *bytes* in the persistent `<dataDir>/artist-overrides/<artistId>.<ext>` dir (`services/artist-image-override.ts`) — bytes because an upload has no URL and a disk-only album cover has no public one. Routes (`routes/library.ts`): `PUT /api/library/artists/:id/image` (multipart upload, JPEG/PNG/WebP ≤ 8 MB), `POST …/image/from-album` (`{ albumId }` → copies that album's resolved cover bytes), `DELETE …/image` (revert). An override sets `library_artists.manual_override = 1` so the auto task leaves the choice alone, and is served **ahead of** canonical artwork by the cover route. `DELETE` clears the flag → the artist reverts to auto/placeholder. The web edit affordance lives on the artist-detail portrait (`artist-image-*` testids), admin-gated.

## On-demand track analysis (BPM + genre)

The `track-info-sheet` drawer exposes an **Analysis** section that fills in per-track metadata the rip didn't carry.

**Reading stored values.** The sheet renders BPM/genre from its `effectiveSong()` — the caller's `Song` input when given, else one lazily fetched via `getSong(songId)` (`GET /api/library/songs/:id`) on init. This fetch matters because the player opens the sheet with only a `songId` and display strings (no `Song`); without it, already-stored `bpm`/`genre` (e.g. from the windowed enrichment) would render as "Unknown" even though the columns are populated.

**BPM.** `library_songs` has an additive `bpm INTEGER` column. The scanner reads it from tags (`music-metadata` `common.bpm`), and `persist()` updates it via `bpm = COALESCE(excluded.bpm, library_songs.bpm)` so a rescan of a file whose tags lack BPM never wipes an analyzed value. `POST /api/library/songs/:id/analyze`:
1. returns the existing tag value immediately (`source: 'tag'`) when present;
2. otherwise `track-analysis.ts` `analyzeBpm()` decodes a ~90 s mono PCM slice via ffmpeg (`-ar 44100 -ac 1 -f f32le`, the rate `music-tempo`'s onset detection expects) and runs `music-tempo` (lazy-imported, degrades to `null` when absent);
3. on a value it **writes the tag back** (`audio-tags.ts` now emits `TBPM` for ID3 and Vorbis `BPM` for FLAC/Opus/M4A) *and* sets `library_songs.bpm`, so the result is durable across rescans.

**Genre.** `GET …/genre-suggestion` runs `verifyGenre()` — a Lidarr `artist.lookup` (diacritic/punctuation-insensitive name match via `normalizeForGrouping`, reading the artist's `genres`), returning `{ current, suggested, candidates, source }` and degrading to `source: null` when Lidarr is unconfigured or has nothing. Admin-only `POST …/genre` applies a chosen value: writes the file tag and updates `library_songs.genre`. The web gates the **Apply** button on `AuthService.role === 'admin'`.

All ffmpeg-dependent paths are guarded by `ffmpegAvailable()`. Response types (`BpmAnalysisResult`, `GenreSuggestion`) live in `@nicotind/core` (re-exported to the web via `packages/web/src/types/core.ts`).

### Bulk backfill scripts

The per-track buttons only touch one song at a time, so two batch scripts fill the whole library — the same offline-vs-Lidarr split as `backfill-years.ts` (offline) vs `optimize-metadata.ts` (needs Lidarr). Both are **dry-run unless `--apply`**, write to the canonical column **and** the file tag (so a rescan keeps the value), append to `<dataDir>/*.log`, and **resume on re-run** (selection is "still missing", writes are incremental). The thin selection/grouping logic is the pure, unit-tested `services/track-backfill.ts` (`resolveSongAbsPath`, `groupSongsByArtist`, `planGenreBackfill`); the heavy lifting reuses the already-tested `analyzeBpm` / `verifyGenre`.

**`scripts/analyze-bpm.ts` — offline** (ffmpeg + music-tempo, no Lidarr). Walks every `bpm IS NULL` song; per song it prefers a BPM already on the file tag, else runs `analyzeBpm()`. Each `analyzeBpm` is a ~90 s ffmpeg decode, so work runs through a bounded worker pool (`--concurrency`, default 3); `--limit N` takes a test slice. Aborts early if ffmpeg isn't on PATH.

```bash
bun run packages/api/src/scripts/analyze-bpm.ts                 # dry run
bun run packages/api/src/scripts/analyze-bpm.ts --apply         # write DB + tags
bun run packages/api/src/scripts/analyze-bpm.ts --apply --limit 50 --concurrency 4
```

**`scripts/backfill-genre.ts` — needs a live Lidarr** (genre comes from the artist's Lidarr/MusicBrainz metadata). Walks songs with no genre, groups them by artist, and looks each artist up **once** (`verifyGenre`), fanning the suggested genre out to all of that artist's genre-less songs. Lidarr config + `secrets.json` fallback mirror `optimize-metadata.ts`; exits non-zero if no API key. The `library_genres` facet counts are **not** recomputed here — they refresh on the next full scan (matching the per-song genre route).

```bash
bun run packages/api/src/scripts/backfill-genre.ts             # dry run
bun run packages/api/src/scripts/backfill-genre.ts --apply     # write DB + tags
```
