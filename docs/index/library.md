# Library & metadata

One section of [the index](../index.md). Entry shape and caps are unchanged and
`bun run check:claude-md` still enforces them here.

- **Native library scanner**: `LibraryScanner` walks the music dir, reads tags → `library_*` tables
  with deterministic SHA1 ids; `resolveTags` applies overrides before minting the artist/album ids.
  Incremental `scan_cache` + `mapPool`, `applyPerformancePragmas`, `albumIdsByGroupKey`.
  → [library-scanner.md](../library-scanner.md)
- **A canonical tracklist ranks duplicates, it never deletes the only copy**: it keys an album's
  files to canonical tracks so duplicates collapse, and a file it does not name keys by its own
  title and survives. `selectAlbumTracks`, `selectAlbumTracksDetailed`,
  `LibraryScanner.knownRelPaths`, `chooseFolderKeepers`. → [library-scanner.md](../library-scanner.md)
- **Title cleanup runs over the existing library too**: `cleanDisplayTitle` covers reissue labels,
  and `normalize-titles.ts` applies it to stored rows through the verified retag path.
  `planTitleNormalization`. → [library-scanner.md](../library-scanner.md)
- **VA / compilation handling — the credit is not the owner**: `resolveTags` returns
  `albumArtist`, the displayed `trackArtist` and the id-minting `trackArtistOwner`, so a
  per-track collaboration credit is storable without fragmenting the artist grid;
  `classifyFolder` detects compilations; Compilations tab, VA hidden from artists.
  → [library-scanner.md](../library-scanner.md)
- **Multi-artist support (confirmation-gated)**: `splitArtists` splits a compound only when every part
  is a confirmed artist; `segmentConcatenatedArtist` handles delimiter-less mashes;
  `library_artist_identity` + `library_artist_aliases` survive rescans; `corroboratesLidarrHit` and
  `boundedEditDistance` guard provisioning. → [library-scanner.md](../library-scanner.md)
- **Artist MBID resolution + homonyms**: one `library_mbids` row per normalized name feeds every
  non-tag artist surface. `pickMbidHit`, `pickByDiscographyOverlap`, `isMbidReResolvable`,
  `mutateArtistMbid` (+ MCP `set_artist_mbid`), `isMbidTombstoned`, `usableMbid`.
  → [library-scanner.md](../library-scanner.md)
- **Artist bios (auto + override)**: MBID-first Discogs lookup into `library_artist_meta` with
  tombstones; auto-fetch on first artist-page visit; `formatArtistBio` strips Discogs BBCode;
  `resolveMbidViaLidarr` is two-stage. A bio needs `BIO_MIN_MBID_CONFIDENCE` and records the
  `mbid` it came from, so an identity correction invalidates it.
  → [library-scanner.md](../library-scanner.md)
- **Artist images (auto + override)**: priority-ordered provider chain
  (`buildArtistImageProviders` → lidarr/spotify/discogs) walked by `resolveArtistImageUrl`; one shared
  `fillArtistImages` behind the task, the one-shot route and the backfill script;
  `ArtistImageMenuComponent`, `NEEDS_PORTRAIT_SQL`, `artistImageCoverage`.
  → [library-scanner.md](../library-scanner.md)
- **Artist curation survives an identity fix**: `carryArtistCuration` moves artwork, uploads, bio and
  the name-keyed genre override at the fix site when a rename/merge re-mints the artist id.
  → [library-scanner.md](../library-scanner.md)
- **Canonical artwork**: `library_artwork` stores canonical URLs keyed on deterministic ids, so they
  survive rescans. → [library-scanner.md](../library-scanner.md)
- **Artwork is three tiers, and the metric names which one**: `missingAlbumArtSql` measures a
  canonical *row*, while `extractCover` serves folder image → embedded picture, so the report splits
  `missing` / `noEmbeddedArt` / `unrenderable` off `library_songs.has_embedded_art`.
  → [library-audit.md](../library-audit.md)
- **Folder art needs the folder to be the album's**: `folderArtBelongsToAlbum` rejects a shared
  bucket by name (`isSinglesBucketDir`) and by contents before `extractCover` trusts a `cover.jpg`
  beside a track. → [library-audit.md](../library-audit.md)
- **A cover survives the transcode as a folder image**: `preserveFolderCover` writes `cover.jpg`
  before `-vn` discards the attached picture and as the organizer lands any format — ffmpeg's Ogg
  muxer cannot carry one. `findFolderCoverName`. → [library-audit.md](../library-audit.md)
- **The Opus conversion is accountable, re-embeds art and normalizes losslessly**: `transcode_runs`
  opens at start, `reconcileTranscodeRunsOnBoot` sweeps orphans, `embedAlbumArt` writes a cover via
  `attachPictureToOpus`, `normalizeLibraryLoudness` puts loudness in the header via `writeOutputGain`.
  → [download-pipeline.md](../download-pipeline.md)
- **Spaced Vorbis names heal on encode, on rewrite and once library-wide**: `planVorbisKeyFixes`
  maps `UNMODELLED_SPACED_KEYS` to canonical names; `planVorbisKeyHeal` rides every tag write;
  `backfillVorbisKeys` runs it once. → [download-pipeline.md](../download-pipeline.md)
- **A tag write keeps the Ogg cover**: `readOggPicture` reads it before the remux drops it and
  `attachPictureDataToOpus` puts it back. → [download-pipeline.md](../download-pipeline.md)
- **The displayed artist spelling is reduced, not first-seen**: `pickDisplayName` picks one of an
  album's spellings (frequency → diacritics → not-shouted → explicit-locale alphabetical) and
  `refreshAlbumArtistDisplay` re-derives it on every incremental touch, so a one-file scan cannot
  re-elect it. `artistId` is unaffected. → [library-scanner.md](../library-scanner.md)
- **Tag text is NFC at the boundary**: `nfc()` normalises every string `parseTrack` reads, so two
  byte-different spellings that render identically cannot reach an exact comparison.
  → [library-scanner.md](../library-scanner.md)
- **A walk that did not finish must not prune**: `unreadableDirs` makes a swallowed `readdir` failure
  visible, `scanFull` skips the prune when it is non-empty, and
  `recoverPresentOrphanedCacheRows` unstamps cache rows whose file is present — surfaced as the
  health report's `disk` dimension. → [library-scanner.md](../library-scanner.md)
- **Multi-genre support (primary + extras)**: `splitGenres` parses full tag frames into
  `library_song_genres` (position 0 = primary); human-gated `library_genre_aliases` and
  `segmentConcatenatedGenre` fix concatenations at scan time; `backfillGenresFromAliases`.
  → [library-scanner.md](../library-scanner.md)
- **Genre is stored twice — the set and the mirror**: `library_song_genres` is authoritative,
  `library_songs.genre` mirrors position 0; the two drift unless both preserve what a rescan cannot
  resolve (`repairGenreMirrorDrift`). `primaryGenreOnly` is the sanctioned narrow read; the facet
  `song_count` is a stored snapshot refreshed by `refreshGenreCounts`.
  → [genre-model.md](../genre-model.md)
- **Genre matching is bounded, storage is not**: `GENRE_SET_EXPR` reads a song's first
  `GENRE_MATCH_POSITIONS` genres by position, so a 33-genre song stops satisfying every station
  while every genre stays stored and displayed. → [genre-model.md](../genre-model.md)
- **A bad raw genre STRING is one alias row, not N overrides**: `upsertGenreAlias` (MCP
  `set_genre_alias`) writes `library_genre_aliases` and re-splits only the songs carrying that
  value, so future arrivals are clean too. → [genre-model.md](../genre-model.md)
- **Every door onto the genre store canonicalizes**: `mapDiscogsGenres` gates the `genre-audio`
  sidecar label as well as the Discogs plugin, and route input is parsed with `parseGenreList`, never
  the `splitStored` storage decoder. → [genre-model.md](../genre-model.md)
- **A placeholder can never key an artist alias**: `isPlaceholderAliasKey` refuses
  `[traditional]`/`various`/`me`-shaped keys at `upsertArtistAlias`, since such a row silently
  captures unrelated future arrivals and no audit rule can see it.
  → [library-scanner.md](../library-scanner.md)
- **Curator-correctable genres**: `library_genre_overrides` (scope artist/album/song) is the one genre
  write that can *replace* a primary, carrying an explicit `mode`; `status` is the review queue;
  `backfillGenreOverrides`, `appendSongGenres`, `ArtistGenreModalComponent`. Both modes write the
  row, so a curation outlives the next scan (`mutateSongGenre`).
  → [library-scanner.md](../library-scanner.md)
- **Genre radar**: `artistGenreDistribution` + `albumGenreDistribution` feed an inline-SVG radar and a
  read-only `GenreDistributionStripComponent`; pure `radar-geometry.ts` + `genre-projection.ts`;
  album aggregate is `mostCommonGenre`. Weights deliberately do not sum to 1.
  → [genre-radar.md](../genre-radar.md)
- **Artist origin / nationality**: `library_artist_origins` (MB-first, TTL tombstones, permanent user
  rows); core `origin.ts` vocab + `originCloseness`; a radio axis, a filter, and an artist-page flag
  line with curator edit. → [artist-origin.md](../artist-origin.md)
- **Popularity / hotness per song**: normalized 0–1 `library_songs.popularity` from ListenBrainz via
  `ListenBrainzClient` + `normalizePopularity`, MBID-native and tags-first. Not tag-mirrored, so it
  survives rescans untouched. → [popularity.md](../popularity.md)
- **Search matching (tokenized + accent-insensitive)**: shared `search-tokens.ts`
  (`tokenize`/`matchesAllTokens`) folds and ANDs per token over a name+artist haystack; the catalog
  lane reuses it through `filterAlbumsByRelevance`. → [library-scanner.md](../library-scanner.md)
- **Fragmentation diagnostic**: `checkFragments` surfaces same-release spelling variants and
  mis-classified albums via `contradictsTrackCount`, each row carrying its remediation
  (`fragment-remediation.ts`). → [library-scanner.md](../library-scanner.md)
- **Library health report**: one `libraryHealth` module — every curation dimension as metric plus
  a worst-first worklist — behind `GET /api/library/health`, the `library-health.ts` CLI and MCP
  `get_library_health`. Shared predicates: `missingAlbumArtSql`, `losslessSuffixSql`,
  `lowInformationOnlyGenreSql`. → [library-audit.md](../library-audit.md)
- **Metadata optimization**: conservative all-or-nothing bulk Lidarr re-fetch (`optimizeAllAlbums`),
  run as a cancellable background job on `MaintenanceService`, bounded by limit + cursor.
  → [metadata-optimize.md](../metadata-optimize.md)
- **User-driven metadata fix**: interactive Lidarr candidate search + free-text + multi-source cover
  picker, persisted in `library_metadata_overrides` with immediate canonical re-point.
  → [metadata-optimize.md](../metadata-optimize.md)
- **On-demand track analysis (BPM + genre)**: per-track analyze/verify in the track-info drawer plus
  bulk backfill scripts, writing DB *and* file tag; BPM is sidecar-first; curator-gated AcoustID
  identify via `buildIdentifyApplyTags`. → [library-processing.md](../library-processing.md),
  [acoustid-identify.md](../acoustid-identify.md)
- **A failed tag mirror is surfaced, not silent**: `chooseBpm`/`writeGenres` in the track-info sheet
  check the route's own `tagWritten` and toast a warning on `false` — the DB write (or, for a genre
  `mode: 'replace'`, the override) is durable either way, but the file's own copy is not, so it may
  not survive a future file replacement. `warnIfTagMirrorFailed`.
  → [web-ui.md](../web-ui.md)
- **Curator retag from the track drawer**: an `@if (canCurate())` Tags section over #722's
  `PATCH /songs/:id/metadata` — prefilled fields, `tagChanges` sends only what moved, one lookup
  offers the cleaned title and candidate releases, and an unverified or diverged write is shown, not
  swallowed. `fixSongMetadata`, `getSongMetadataCandidates`. → [web-ui.md](../web-ui.md)
- **Bounded query integers**: `clampQueryInt` is the one place a `?size`/`?limit`/`?count` becomes a
  SQL bind — a non-numeric value used to reach SQLite as `NaN` (500) and a negative one as "no
  limit". → [api-routes.md](../api-routes.md)
- **Standardized library metadata filters**: one shared `LibraryFilter` filters the library tabs and
  artist Songs tab server-side, with song properties matching via an any-track membership test and
  state in URL query params. `entityFilterWheres`. → [library-filters.md](../library-filters.md)
- **A blocked event loop names the request that blocked it**: `bun:sqlite` is synchronous, so one
  slow query stops the whole process; `startLoopBlockMonitor` reports timer lateness and
  `trackInFlight` says whose. Nothing in-process pre-empts it, so the shape is gated and every list
  route caps its rows (`ARTISTS_PAGE_MAX`). → [library-filters.md](../library-filters.md)
- **Library quality auditor**: assert (audit) + clean (repair/retag) + prevent (ingest sanitize) for
  DJ-pool/VA-source pollution across DB and disk; structural DJ-set tags recover their real
  artist via `djSetArtistName`. → [library-audit.md](../library-audit.md)
- **A wrong artist *name* is relational, not lexical**: `fragmented_artist` clusters
  `"<base>, …"` rows against a base that is itself an artist row
  (`findArtistFragmentClusters`), because no predicate over a single name separates a
  composer credit from a real duo. → [library-audit.md](../library-audit.md)
- **Discogs metadata plugin**: default-off consent-gated `metadata` plugin resolving release
  genres/styles, MBID-first via `parseDiscogsRef` then corroborated `selectBestRelease`; the
  album-scoped `genre-discogs` task writes gated `library_genre_overrides`.
  → [discogs-plugin.md](../discogs-plugin.md)
