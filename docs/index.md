# The index

Every mechanism in NicotinD: what it is, the symbols you would grep for, and the doc that explains
why. Split out of `CLAUDE.md` so it is read when needed rather than paid for on every request
(issue #934); the entry shape and its caps are unchanged, and `bun run check:claude-md` still
enforces them here.

The index proper. Each line: what it is, what to grep for, where the detail lives.

- **Proposed, NOT built** — read each as the pitch it is; no route, no table, no dependency ships for
  any of them: peer share, serving a library over `/addon/v1` to another instance
  → [peer-share.md](peer-share.md); hardware cast, Chromecast + DLNA
  → [cast-integration.md](cast-integration.md); OAuth as an `auth` plugin kind
  → [oauth-auth.md](oauth-auth.md); WebMCP host exposure, client-side WebGPU/WebNN a NO-GO
  → [webmcp-alignment.md](webmcp-alignment.md),
  [client-side-ml-feasibility.md](client-side-ml-feasibility.md)

### Acquisition & downloads

- **Source-agnostic acquisition (the north star)**: every acquirable result from any source maps to
  one `AcquisitionCandidate` in one blended ranked list; a new source is one adapter + a pure mapper.
  → [source-agnostic-acquisition.md](source-agnostic-acquisition.md)
- **Acquisition addon protocol**: open HTTP protocol (`validateAddonManifest`, `AddonClient`,
  `RemoteAddonPlugin`, `addon_registrations`, `loadRegisteredAddons`); `AddonSearchProvider` and
  `AddonJobPoller` light up every lane with no route changes.
  → [acquisition-addon-protocol.md](acquisition-addon-protocol.md)
- **Plugin architecture + addon marketplace**: kind-agnostic kernel + `PluginRegistry`, acquisition
  default-off; in-process plugins are spotify/lrclib/discogs/acoustid, built in
  `registerBuiltinPlugins`. `ADDON_CATALOG` + `promotePendingAddons` back one-click install.
  → [plugins.md](plugins.md)
- **Album hunt** — *addon-owned*: `AlbumHunterService`, `huntBase`, `searchAndScore`,
  `isBloatedFolder`, `FallbackHost`, `isStalled`, `stallThresholdMs` and `TransferPoller` live in the
  `kevinch3/nicotind-slskd-addon` repo, not here. Core keeps `buildSkewedQueries`/`buildTrackQueries`.
  `matchPct` is recall-only by design. → [album-hunt.md](album-hunt.md)
- **Idempotent hunt — one album = one download**: 409 guards + only-missing-tracks enqueue;
  "already have it" surfaces as a notice, not an error. → [album-hunt.md](album-hunt.md)
- **Watchlist auto-hunt**: star a catalog album; a poller auto-hunts and downloads on a confident
  match. → [album-hunt.md](album-hunt.md)
- **Auto-acquisition loop (opt-in)**: default-off poller over Lidarr `wanted/missing`, routed through
  the shared `acquireAlbum` core so it is idempotent and re-entrant.
  → [auto-acquisition-plan.md](auto-acquisition-plan.md)
- **Catalog (metadata-driven) search**: `CatalogService` returns artist/album cards from
  Lidarr/MusicBrainz scoped to the matched artist; a catalog miss opens the folder-first network lane,
  with full-discography load opt-in. → [album-hunt.md](album-hunt.md)
- **URL acquisition (yt-dlp / spotdl / archive)**: `POST /api/acquire` routes a URL via
  `resolveAddonForUrl` to a `resolve`-capable addon, bundled (`LocalAddonTransport`) or external,
  matched by `urlPatterns`; `resolveAcquireAs`, `findInFlightAddonUrlJob`, `applyAddonOutcome`,
  `sanitizeAddonError`.
  → [download-pipeline.md](download-pipeline.md),
  [acquisition-addon-protocol.md](acquisition-addon-protocol.md)
- **Spotify metadata fallback**: metadata-only lane handing a `spotify.com/album` URL to
  `/api/acquire`; the external spotdl addon resolves the download.
  → [spotify-fallback.md](spotify-fallback.md)
- **Playlist-from-acquisition**: a URL job classified as a playlist auto-generates a native playlist
  from landed tracks in download order — addon-native (the live path, issue #587):
  `materializeAddonPlaylist`; legacy in-process fallback: `classifyAcquireUrl`,
  `recordAcquireJobTrack`. → [playlist-from-acquisition.md](playlist-from-acquisition.md)
- **Guided acquire UX**: catalog cards are the primary path, the raw peer lane sits behind Advanced;
  `pickNetworkView` defaults to Folders for album intent, `AutoHuntService` self-heals one-click Get.
  → [album-hunt.md](album-hunt.md)
- **Merged `/get` workspace**: Acquire + Downloads are one route with a `?tab=find|downloads` shell
  (`GetComponent`); the `@if` is load-bearing (destroying the inactive tab unregisters its handlers).
  → [web-ui.md](web-ui.md)
- **Acquisition kill-switch**: one `config.acquisitionEnabled` (env `NICOTIND_ACQUISITION=off`) hard-404s
  every acquisition route group via `requireAcquisitionEnabledMiddleware`, skips the search fan-out and
  the pollers, and cascades to the web through `canAcquire`. Env is a floor an admin cannot lift.
  → [deployment.md](deployment.md)
- **Unified acquisition jobs**: every download is wrapped in an `acquisition_jobs` row whose
  transfer↔job linkage is stored at enqueue time, never re-derived. `markItemsScanned`,
  `reconcileOrganizedItems`, `filesForCanonicalTracks`, `backfillDirectJobAlbum`.
  → [acquisition-jobs.md](acquisition-jobs.md)
- **The job state vocabulary says what is happening**: `resolving` and item-state `queued` are real
  members, the row is reserved before the source is called, a stalled item cannot pin the stage, and
  an Error card always has a reason. `attachAddonRef`, `failReservedJob`, `reapIdleItems`,
  `stalledItemStillRules`, `allItemsFailedReason`. → [download-pipeline.md](download-pipeline.md)
- **Unified downloads feed — one job = one card**: addon and URL jobs adapt into one `DownloadItem`;
  card identity is the job id recorded at enqueue. `listJobFeed`, `mergeAcquisitionJobs`,
  `mapAddonJob`, `cancelUnownedJob`, `methodForBackend`, `downloadTitleFor`.
  → [download-pipeline.md](download-pipeline.md)
- **A partial download says why, and can be retried**: per-track failures grouped by class on the
  card; Retry reaches partial addon URL jobs, not just failed ones. `parseJobFailureSummary`,
  `classifyTrackFailure`, `summarizeFailures`, `failureClassLabel`, `allItemsFailedMessage`.
  → [download-pipeline.md](download-pipeline.md)
- **Inline download lifecycle**: result cards go idle → progress % → "Open in Library", driven by
  `TransferService` + a `libraryDirty` signal. → [design-patterns.md](design-patterns.md),
  [download-pipeline.md](download-pipeline.md)
- **Download list metadata**: `GET /api/downloads` annotates in-flight folders from `album_jobs`;
  `destinationAlbums` disambiguates where a completed job landed.
  → [download-pipeline.md](download-pipeline.md)
- **Acquisition provenance**: the `acquisitions` side-table records method/source/time at download
  time, surfaced per track. → [download-pipeline.md](download-pipeline.md)
- **Quality chip on download cards**: `bitrateKbps` + `audioFormat` per item, rendered by the pure
  `formatQuality`; `enrichWithBitrate` upgrades it post-scan.
  → [download-pipeline.md](download-pipeline.md)
- **Duplicate prevention**: FLAC>MP3, auto-dedupe, edition-collapsing album IDs, cross-edition folder
  consolidation at ingest; the cross-peer fallback splits `missing` from `recoverable` so a wave
  cannot duplicate one in flight. → [download-pipeline.md](download-pipeline.md),
  [album-hunt.md](album-hunt.md)
- **Lossless → Opus standardization**: lossless downloads transcoded in place (default-on 192 kbps),
  codec-aware via `isLosslessFile`, gated on ffmpeg, surfaced read-only at
  `GET /api/settings/downloads`. → [download-pipeline.md](download-pipeline.md)
- **Reserved paths — staging lives inside `musicDir`, invisibly**: one `library-paths.ts`
  (`reservedDirsFor`, `isReservedTopLevel`, `isHiddenFile`, `isReservedPath`) is the only answer to
  "is this library content?"; the rule is depth-scoped (root dot-dirs skipped, album titles never
  judged) and `check:library-walkers` keeps all 14 walkers honest.
  → [library-path-conventions.md](library-path-conventions.md)
- **Import music — two lanes into one pipeline**: an admin server path and a browser upload
  (`ImportUploadService`, chunked + resumable, `submitStaged`) both run through organize → scan →
  quarantine; drop a folder on `/get`, gated by `canImport`. → [import.md](import.md)
- **Untracked downloads**: `relative_path IS NULL` rows backfilled by script, listed at
  `GET /api/library/untracked`. → [download-pipeline.md](download-pipeline.md)
- **Downloading albums suppressed from listing**: listings exclude albums with active `album_jobs` or
  in-flight transfers via an SQL `WHERE` exclusion.
  → [design-patterns.md](design-patterns.md)
- **Album deletion**: folder-first `rmSync` + synchronous canonical-row delete + orphan-aggregate
  prune; every delete route debounce-schedules a `ShareRescanScheduler` pass. A single-song delete
  refreshes its album through the shared `refreshAlbumAggregate` / `pruneOrphanAlbum`.
  → [download-pipeline.md](download-pipeline.md)
- **Download inbox triage (hold-for-review)**: opt-in `holdForReview` holds quarantined downloads for
  curator approval; `download_reviews` decisions, multi-source candidates, AcoustID identify with
  typed failures. → [download-review.md](download-review.md)
- **Release-type model (singles & EPs)**: every album carries a `classification`, set metadata-first
  with a track-count heuristic fallback. → [download-pipeline.md](download-pipeline.md)

### Library & metadata

- **Native library scanner**: `LibraryScanner` walks the music dir, reads tags → `library_*` tables
  with deterministic SHA1 ids; `resolveTags` applies overrides before minting the artist/album ids.
  Incremental `scan_cache` + `mapPool`, `applyPerformancePragmas`, `albumIdsByGroupKey`.
  → [library-scanner.md](library-scanner.md)
- **A canonical tracklist governs admission, not retention**: the pinned `album_jobs` tracklist
  filters which *new* files an album admits; a file in `knownRelPaths` is never dropped as foreign.
  `selectAlbumTracks`, `LibraryScanner.knownRelPaths`.
  → [library-scanner.md](library-scanner.md)
- **Title cleanup runs over the existing library too**: `cleanDisplayTitle` covers reissue labels,
  and `normalize-titles.ts` applies it to stored rows through the verified retag path.
  `planTitleNormalization`. → [library-scanner.md](library-scanner.md)
- **VA / compilation handling — the credit is not the owner**: `resolveTags` returns
  `albumArtist`, the displayed `trackArtist` and the id-minting `trackArtistOwner`, so a
  per-track collaboration credit is storable without fragmenting the artist grid;
  `classifyFolder` detects compilations; Compilations tab, VA hidden from artists.
  → [library-scanner.md](library-scanner.md)
- **Multi-artist support (confirmation-gated)**: `splitArtists` splits a compound only when every part
  is a confirmed artist; `segmentConcatenatedArtist` handles delimiter-less mashes;
  `library_artist_identity` + `library_artist_aliases` survive rescans; `corroboratesLidarrHit` and
  `boundedEditDistance` guard provisioning. → [library-scanner.md](library-scanner.md)
- **Artist MBID resolution + homonyms**: one `library_mbids` row per normalized name feeds every
  non-tag artist surface; `pickMbidHit` returns null on ambiguity and
  `pickByDiscographyOverlap` breaks the tie. Curator repair is `PUT /api/library/artists/:id/mbid`.
  → [library-scanner.md](library-scanner.md)
- **Artist bios (auto + override)**: MBID-first Discogs lookup into `library_artist_meta` with
  tombstones; auto-fetch on first artist-page visit; `formatArtistBio` strips Discogs BBCode;
  `resolveMbidViaLidarr` is two-stage. → [library-scanner.md](library-scanner.md)
- **Artist images (auto + override)**: priority-ordered provider chain
  (`buildArtistImageProviders` → lidarr/spotify/discogs) walked by `resolveArtistImageUrl`; one shared
  `fillArtistImages` behind the task, the one-shot route and the backfill script;
  `ArtistImageMenuComponent`, `NEEDS_PORTRAIT_SQL`, `artistImageCoverage`.
  → [library-scanner.md](library-scanner.md)
- **Artist curation survives an identity fix**: `carryArtistCuration` moves artwork, uploads, bio and
  the name-keyed genre override at the fix site when a rename/merge re-mints the artist id.
  → [library-scanner.md](library-scanner.md)
- **Canonical artwork**: `library_artwork` stores canonical URLs keyed on deterministic ids, so they
  survive rescans. → [library-scanner.md](library-scanner.md)
- **Multi-genre support (primary + extras)**: `splitGenres` parses full tag frames into
  `library_song_genres` (position 0 = primary); human-gated `library_genre_aliases` and
  `segmentConcatenatedGenre` fix concatenations at scan time; `backfillGenresFromAliases`.
  → [library-scanner.md](library-scanner.md)
- **Genre is stored twice — the set and the mirror**: `library_song_genres` is authoritative,
  `library_songs.genre` mirrors position 0; the two drift unless both preserve what a rescan cannot
  resolve (`repairGenreMirrorDrift`). `primaryGenreOnly` is the sanctioned narrow read; the facet
  `song_count` is a stored snapshot refreshed by `refreshGenreCounts`.
  → [genre-model.md](genre-model.md)
- **Curator-correctable genres**: `library_genre_overrides` (scope artist/album/song) is the one genre
  write that can *replace* a primary, carrying an explicit `mode`; `status` is the review queue;
  `backfillGenreOverrides`, `appendSongGenres`, `ArtistGenreModalComponent`. Both modes write the
  row, so a curation outlives the next scan (`mutateSongGenre`).
  → [library-scanner.md](library-scanner.md)
- **Genre radar**: `artistGenreDistribution` + `albumGenreDistribution` feed an inline-SVG radar and a
  read-only `GenreDistributionStripComponent`; pure `radar-geometry.ts` + `genre-projection.ts`;
  album aggregate is `mostCommonGenre`. Weights deliberately do not sum to 1.
  → [genre-radar.md](genre-radar.md)
- **Artist origin / nationality**: `library_artist_origins` (MB-first, TTL tombstones, permanent user
  rows); core `origin.ts` vocab + `originCloseness`; a radio axis, a filter, and an artist-page flag
  line with curator edit. → [artist-origin.md](artist-origin.md)
- **Popularity / hotness per song**: normalized 0–1 `library_songs.popularity` from ListenBrainz via
  `ListenBrainzClient` + `normalizePopularity`, MBID-native and tags-first. Not tag-mirrored, so it
  survives rescans untouched. → [popularity.md](popularity.md)
- **Search matching (tokenized + accent-insensitive)**: shared `search-tokens.ts`
  (`tokenize`/`matchesAllTokens`) folds and ANDs per token over a name+artist haystack; the catalog
  lane reuses it through `filterAlbumsByRelevance`. → [library-scanner.md](library-scanner.md)
- **Fragmentation diagnostic**: `checkFragments` surfaces same-release spelling variants and
  mis-classified albums via `contradictsTrackCount`, each row carrying its remediation
  (`fragment-remediation.ts`). → [library-scanner.md](library-scanner.md)
- **Library health report**: one `libraryHealth` module — every curation dimension as metric +
  bounded worst-first worklist + remediation hint — rendered by `GET /api/library/health` (curator),
  the `library-health.ts` CLI and MCP `get_library_health`. `missingAlbumArtSql` and
  `losslessSuffixSql` are the shared predicates; on-demand only, never polled.
  → [library-audit.md](library-audit.md)
- **Metadata optimization**: conservative all-or-nothing bulk Lidarr re-fetch (`optimizeAllAlbums`),
  run as a cancellable background job on `MaintenanceService`, bounded by limit + cursor.
  → [metadata-optimize.md](metadata-optimize.md)
- **User-driven metadata fix**: interactive Lidarr candidate search + free-text + multi-source cover
  picker, persisted in `library_metadata_overrides` with immediate canonical re-point.
  → [metadata-optimize.md](metadata-optimize.md)
- **On-demand track analysis (BPM + genre)**: per-track analyze/verify in the track-info drawer plus
  bulk backfill scripts, writing DB *and* file tag; BPM is sidecar-first; curator-gated AcoustID
  identify via `buildIdentifyApplyTags`. → [library-processing.md](library-processing.md),
  [download-review.md](download-review.md)
- **A failed tag mirror is surfaced, not silent**: `chooseBpm`/`writeGenres` in the track-info sheet
  check the route's own `tagWritten` and toast a warning on `false` — the DB write (or, for a genre
  `mode: 'replace'`, the override) is durable either way, but the file's own copy is not, so it may
  not survive a future file replacement. `warnIfTagMirrorFailed`.
  → [web-ui.md](web-ui.md)
- **Standardized library metadata filters**: one shared `LibraryFilter` filters the library tabs and
  artist Songs tab server-side, with song properties matching via any-track `EXISTS` and state in URL
  query params. → [library-filters.md](library-filters.md)
- **Library quality auditor**: assert (audit) + clean (repair/retag) + prevent (ingest sanitize) for
  DJ-pool/VA-source pollution across DB and disk; structural DJ-set tags recover their real
  artist via `djSetArtistName`. → [library-audit.md](library-audit.md)
- **A wrong artist *name* is relational, not lexical**: `fragmented_artist` clusters
  `"<base>, …"` rows against a base that is itself an artist row
  (`findArtistFragmentClusters`), because no predicate over a single name separates a
  composer credit from a real duo. → [library-audit.md](library-audit.md)
- **Discogs metadata plugin**: default-off consent-gated `metadata` plugin resolving release
  genres/styles, MBID-first via `parseDiscogsRef` then corroborated `selectBestRelease`; the
  album-scoped `genre-discogs` task writes gated `library_genre_overrides`.
  → [discogs-plugin.md](discogs-plugin.md)

### Audio analysis & enrichment

- **Library processing**: resumable background enrichment via an extensible task registry, run
  continuously while enabled; failures are diagnosed and tallied into `ProcessingStatus`, and broken
  or undetectable files are excluded via a `library_song_analysis_failures` ledger.
  `NoConfidentResultError`, `AudioFileRejectedError`. → [library-processing.md](library-processing.md)
- **A retired task leaves nothing behind**: `PROCESSING_TASK_IDS` is the one runtime list of live
  tasks (the `ProcessingTaskId` union derives from it); `applySchema` sweeps ledger rows for anything
  absent from it and the settings blob is filtered the same way.
  → [library-processing.md](library-processing.md)
- **Processing pause**: a `paused` flag is the runtime halt distinct from `enabled: false` (still
  clears quarantine), and the manual way to stand down for another GPU tenant. The failure tally's
  session boundary is one continuous drain (`drained`), not a time window.
  → [library-processing.md](library-processing.md)
- **Analysis sidecar GPU behaviour**: `RegistryHolder` + `IdleReleaseGuard` drop the warm registry
  after an idle timeout and reload lazily; `peek()` reads without touching the guard and `can_serve()`
  backs `/health`; `musicnn_batch_size` bounds the one predictor that dominated VRAM.
  → [audio-ml-enrichment.md](audio-ml-enrichment.md)
- **Process-before-landing (quarantine gate)**: a fresh download is scanned but held
  (`landed_at IS NULL`, hidden from listings) until its required steps finish; a per-task `gates` flag
  intersected with availability is the required set. `graduatePending`, `scanIncremental`,
  `kickEager`, `albumLoadFailureFor`. → [library-processing.md](library-processing.md)
- **A pool that cannot advance**: an un-ledgered failure plus a fixed pool order livelocks a
  `LIMIT`-bounded task on its own head: every un-ledgered path stamps `noteAnalysisAttempt`,
  every song pool orders on `leastRecentlyAttemptedOrderSql`, and tag-sourced ids pass core
  `isMbidShape` before any batch call.
  → [library-processing.md](library-processing.md), [popularity.md](popularity.md)
- **Perceptual audio features (no LLM)**: energy/loudness via ffmpeg ebur128; danceability, valence,
  mood, vocals, acousticness and cached embeddings from the Essentia sidecar; all written to file tags
  and COALESCE-preserved columns. `library_embeddings`, `embedding-store.ts`.
  → [audio-ml-enrichment.md](audio-ml-enrichment.md), [radio.md](radio.md)
- **Vocal-separation sidecar (GPU-only)**: `packages/separator/` mirrors the analysis sidecar;
  `SeparationWorker`, `chunk_windows`, `arch_supported`, `ensure_sdp_kernel_shim`.
  → [vocal-separation.md](vocal-separation.md)
- **Audio descriptors — timbre / groove / spectral balance**: sidecar `/descriptors` + store, phase 1
  of the radio-axis work. → [audio-descriptors.md](audio-descriptors.md)

### Playback, radio & streaming

- **Native streaming + cover art**: `GET /api/stream/:id` (Range/206 + seekable transcode cache) and
  `GET /api/cover/:id`; `GET /api/cover/remote` proxies catalog covers through the same downscale
  path, host-allowlisted and content-addressed. `nativeAppCors` is hand-rolled so its Vary append
  cannot strip `Content-Length`. → [library-scanner.md](library-scanner.md),
  [album-hunt.md](album-hunt.md)
- **RFC 9110-complete range handling**: `serveFileWithRange` serves suffix ranges (`bytes=-N` = the
  *last* N bytes) correctly — returning the head under a mismatched Content-Range stalls iOS Safari's
  tail-probing media loader forever. → [library-scanner.md](library-scanner.md)
- **Transcode cache integrity**: size-in-key, size floor, ffprobe post-check, an in-use pin released
  by `schedulePinRelease` (a body wrapper made Bun emit a chunked 206 that Firefox and iOS stall on),
  and a negative cache for the deterministic `TranscodeOutputRejectedError` only.
  → [library-scanner.md](library-scanner.md)
- **Frontend false-ended recovery**: `browserDurationIsAcceptable`, `isFalseEnded`, `startRecovery`,
  `loadGeneration`, bounded by `MAX_RECOVERY_ATTEMPTS` with both gates falling back to
  `FALSE_ENDED_ABSOLUTE_FLOOR_SEC` when the known duration is missing; the valve resumes where the
  listener was, never at 0. → [web-ui.md](web-ui.md)
- **A dead stream is reloaded, not abandoned**: a media `error` — or a stall that raises nothing at
  all — reloads the track and resumes where it stopped, bounded by `MAX_RECOVERY_ATTEMPTS`, while an
  outage holds the intent until the network returns. `recoverFromDeadStream`, `armStallWatchdog`,
  `STREAM_STALL_TIMEOUT_MS`, `holdPausedState`, `parkedGeneration`. → [web-ui.md](web-ui.md)
- **A seek is an intent, not a poke**: a forward seek past the loaded region is held and applied once
  `audio.seekable` covers it, never assigned and silently clamped into a false `ended`.
  `pendingSeek`, `requestSeek`, `applyPendingSeek`, `seekTargetIsAvailable`,
  `PENDING_SEEK_TIMEOUT_MS`. → [web-ui.md](web-ui.md)
- **A skip burst costs one load**: navigation stays instant while the byte-level load settles on the
  trailing edge, and every `src` change bumps the load generation rather than only element swaps.
  `LOAD_SETTLE_MS`, `assignSource`, `playIfIntended`. → [web-ui.md](web-ui.md)
- **Playback loading feedback (HDD-aware)**: one `buffering` signal (delayed `bufferingVisible`)
  drives spinners, row indicators and the buffered band; every stream URL goes through `streamUrl()`,
  which appends `ngsw-bypass`. Restore-on-load never autoplays — `wasPlaying` is written, not read.
  → [web-ui.md](web-ui.md)
- **Queue management**: `PlayerService` exposes `queueNext`, `addToQueue`, `clearQueue`,
  `removeFromQueue`, `moveInQueue`, `toggleShuffle`, `jumpToQueueIndex`; the Now Playing queue adds a
  header toolbar, per-row remove, drag-reorder, a persisted drag-resize handle and history peek.
  → [song-actions.md](song-actions.md), [web-ui.md](web-ui.md)
- **Queue semantics — what a click replaces**: `play()` is the queue-untouched primitive,
  `playSingle()` replaces the queue for a context-less click, `playWithContext()` makes that list the
  queue, `jumpToQueueIndex()` consumes up to the tapped row, `startRadio()` clears it.
  → [web-ui.md](web-ui.md)
- **Now Playing component split + tabbed Queue/Lyrics panel**: the shell composes seven extracted
  sub-components with a `NowPlayingPanelTabsComponent` switcher; the resize handle is shell-owned
  above the tabs, and `lg:` is two columns. → [web-ui.md](web-ui.md)
- **Lyrics + karaoke**: `metadata` plugin kind + `lyrics` capability (LRCLIB) in `library_lyrics`
  + file tag; karaoke panel with synced highlighting, fullscreen auto-follow, and a `?vocals=off`
  mute that is basic center-cancel or the opt-in ML stem: `readyStemPath`,
  `VocalSeparationService`, `shouldServeVocalsOff`.
  → [design-patterns.md](design-patterns.md), [vocal-separation.md](vocal-separation.md)
- **Now Playing waveform + karaoke VFX**: rendered from a precomputed artifact.
  → [audio-ml-enrichment.md](audio-ml-enrichment.md)
- **Smart radio (metadata-driven queue)**: `GET /api/radio/next` scores candidates by a
  weight-normalized blend of BPM, Camelot key, genre-set closeness, artist origin, year, duration,
  artist diversity, the perceptual axes and embedding cosine. `buildSeedRadio`, `scoreSimilarity`,
  `explainSimilarity`, `genreSetCloseness`, `MISSING_GENRE_FLOOR`, `recentPlayPenalty`,
  `lastPlayedByRecording`. → [radio.md](radio.md)
- **One recording is one thing**: two files of one track (album + compilation) are two
  `library_songs` rows, so radio served it twice as often; `recordingKey` collapses them in the
  served window, the pool exclusion and the recency demotion. → [radio.md](radio.md)
- **Taste breakers (random, recency-demoted)**: the landing shelf that counterweights "Keep the
  vibe" — `TasteBreakersComponent` over `getRandomSongs`, fetching without seeds so a fresh install
  still fills, and demoting recent plays rather than excluding them. `POOL_SIZE`, `SHELF_SIZE`.
  → [radio.md](radio.md)
- **Mosaic home — one surface, one verb**: the `''` route is an infinite pannable tile field over
  every landing source where every tile starts a radio; pure `mosaic-tiles`/`mosaic-packing`/
  `mosaic-lens` under a pooled rAF shell. `patchSide`, `cellCount`, `visiblePlacements`,
  `SCORE_WEIGHTS`, `LANE_MIX`. The shelf landing lives on at `/classic`. → [web-ui.md](web-ui.md)
- **One tile, two tones**: `VibeTileComponent` renders the classic landing's vibe row and genre row
  so they cannot drift — `tone`/`wide` carry the whole difference, and the vibe gradients are fixed
  pairs, never `--theme-*`. → [web-ui.md](web-ui.md)
- **Filter-seeded radio / stations**: the same `GET /api/radio/next` route starts a vibe with no
  seed song from a `LibraryFilter` via `buildFilterRadio` + `songFilterWheres` + `stationCentroid`;
  a genre station is graded not tag-tested by `stationAffinity` (`genreDepthScore` ×
  `artistGenreShares`), a demotion never an exclusion. → [radio.md](radio.md),
  [radio-stations-2026-08.md](measurements/radio-stations-2026-08.md)
- **Radio calibration + diagnostics**: `RADIO_FORMULA_VERSION` stamps every poll so votes never pool
  across formulas; `dump-radio.ts` reports per-axis breakdowns and the served-window spread;
  `evaluatePollAgreement` replays polls into per-formula AUC. → [radio.md](radio.md)
- **Radio evaluation polls (public, admin-created)**: frozen radio scenarios behind a public
  `/poll/:token` wizard, previewed via short-lived read-only share JWTs, distilled by
  `export-radio-poll.ts`. → [radio-eval-polls.md](radio-eval-polls.md)
- **Remote playback (cast, Spotify-Connect-style)**: per-user `PlaybackStateManager` broadcasts state
  and commands over `GET /api/ws/playback` through `createPlaybackHub` (connections keyed by raw
  socket, `activeGraceMs` on loss); the client's decisions are the pure core `reduceServerMessage` /
  `castTo`, shared with the multi-device simulation. → [remote-playback.md](remote-playback.md)
- **Auto-preserve queue (PWA lock-screen resilience)**: `AutoPreserveCoordinator` keeps the next-N
  queued tracks as IndexedDB blobs so playback survives the locked-screen network throttle;
  `evictAutoLRU` never evicts user-saved tracks. → [web-ui.md](web-ui.md)

### Playlists, listening & privacy

- **Native playlists (per-user)**: `playlists`/`playlist_songs` + `PlaylistService`, private per user,
  with sharing and server-side link previews; the detail page adds `SongPickerComponent` and
  token-overlap proposals. → [playlist-generation.md](playlist-generation.md),
  [web-ui.md](web-ui.md)
- **Curated playlists (system, global)**: gradient-covered shelves shown to all users, read-only by
  `kind` rather than ownership. → [curated-playlists.md](curated-playlists.md)
- **Automated playlists**: code-defined `RECIPES` materialized into curated playlists by
  `refreshAutoPlaylists`, with an admin-configurable cadence guarded per period and a
  `runAutoPlaylistsNow` bypass. → [automated-playlists.md](automated-playlists.md)
- **Playlists page (merged single list)**: one list sorted curated-first with an inline badge and
  per-row actions restricted to user rows. → [playlist-generation.md](playlist-generation.md)
- **Likes → auto-maintained "Liked Songs" playlist**: a new `PlaylistKind` value makes the playlist
  itself the store, so no new table; `likeSong`/`unlikeSong`/`likedSongIds` behind a per-user
  `LikeService`. → [song-actions.md](song-actions.md)
- **Listening history (per-user play log)**: append-only `play_events` per playback session; the
  client reports raw facts through `ListeningTrackerService` + a durable `ListeningQueueService`
  outbox, and the **server** owns the counting rule (`countsAsPlay`) so it stays retunable. Endpoints
  take no user id. → [listening-history.md](listening-history.md)
- **Listening stats**: `listeningStats` + `GET /api/history/stats` back the Library Stats tab
  (`LibraryStatsComponent`) — totals, top songs/artists/albums/genres and an hour clock, all derived
  at read time with no rollup table. → [listening-history.md](listening-history.md)
- **Privacy & data protection**: consent is opt-out and resolved by the pure
  `resolveHistoryCollection` (env floor → instance → user), enforced server-side;
  `exportUserData` reads columns from `PRAGMA table_info` at runtime; `deleteUserHistory` is scoped to
  `play_events` and does not flip consent. No admin route reads a user's history by design.
  → [privacy.md](privacy.md)

### Users, auth & access

- **Multi-user + roles**: shared library, per-user settings; ascending ladder
  `listener < user < refiner < admin` shared via core `roles.ts` (`canAcquire`/`canCurate`/`isAdmin`)
  with `requireAcquirer`/`requireCurator`/`requireAdmin` guards. → [roles.md](roles.md)
- **Auth flow**: NicotinD issues its own JWTs (30-day sliding, silent refresh); share tokens are
  short-lived, read-only and non-refreshable. `authGuard` preserves the attempted URL and
  `sanitizeReturnUrl` validates it; an already-logged-in share link resolves in-app without burning
  the public token. → [design-patterns.md](design-patterns.md), [web-ui.md](web-ui.md)
- **Public-signup kill-switch**: default-closed `registrationEnabled`; `RegistrationToggle` +
  `GET`/`PUT /api/admin/registration` back the Admin → User Management switch. Unlike acquisition,
  `NICOTIND_REGISTRATION` pins by *presence* (`resolveRegistrationEnabled`): set either way, the
  toggle is read-only. `registrationBlocked` exempts the first-user bootstrap.
  → [deployment.md](deployment.md)
- **Device pairing (QR link) + remote access**: a 5-minute single-use token rendered as a QR link plus
  a printed fallback code; `parseApproveCode` and core `pairing-code.ts` `isPairingCodeShape` keep the
  minter and validator from drifting; `paired_devices` rows are revocable at refresh. Tailscale Funnel
  publishes the loopback backend. → [device-pairing.md](device-pairing.md)
- **MCP agent access**: external agents curate via `/api/mcp` with a revocable `agent_tokens`
  bearer capped at refiner (`AGENT_EFFECTIVE_ROLE`); `checkToolAccess` gates scope + destructive
  confirm, `dispatchTool` audits writes; shared mutation modules (`library-deletion.ts` …
  `album-cover-mutate.ts`) back HTTP and MCP alike; `gatherCandidates` + `gatherSongCandidates`
  do online lookup. → [mcp-agent.md](mcp-agent.md)
- **Curator origin + rare-genre tools**: `get_artist` returns origin *and* mbid (a wrong origin is
  usually an inherited wrong MBID); `set_artist_origin` writes the shared `mutateArtistOrigin`, and
  `get_rare_genres` (`rareGenres`) surfaces low-cardinality primary genres as mistag candidates.
  → [mcp-agent.md](mcp-agent.md)
- **A missing MCP argument is an error, not empty data**: `missingRequiredArgs` rejects on each
  tool's own `inputSchema.required`, naming the keys sent — a wrong key used to answer "not in the
  library"; `htmlEntityArgs` refuses a literal HTML entity, which lands in the library rather than
  bouncing. → [mcp-agent.md](mcp-agent.md)
- **`identify_song` — identity from the audio**: `identifySongById` is fpcalc + AcoustID and nothing
  else, batchable where `lookup_song_metadata`'s fan-out is not; typed outcome, suggests only,
  carries no genre. → [mcp-agent.md](mcp-agent.md)
- **Presence tracking + last connection (admin-only)**: in-memory `PresenceService` from 60s
  heartbeats merged into `GET /api/admin/users` and ordered by `compareUsersByActivity`; the derived
  `last_seen_at` is persisted by `touchLastSeen` because an in-memory map reports "never" after every
  deploy. → [presence-tracking.md](presence-tracking.md)
- **Curation review queue**: a durable "needs a human decision" flag a curator or MCP agent raises
  instead of guessing; `curation_flags`, `createCurationFlag`, `flag_for_review`, one open flag per
  target. → [mcp-agent.md](mcp-agent.md)
- **Admin audit log**: `audit_log` + `recordAudit` called explicitly at destructive mutation sites,
  never as blanket middleware; entries carry `targetKind`/`targetId`/`detail`, and ledger failures
  never break the audited action. → [roles.md](roles.md)
- **Onboarding**: setup wizard for self-hosters (music dir, quality, Lidarr) plus a first-login welcome
  banner for admin-provisioned users. → [onboarding.md](onboarding.md)

### Web UI patterns

- **Unified song listings**: one `TrackRowComponent` + one root `SongMenuService.build(song, ctx)`
  builds every `⋯` menu; Remove routes through `ConfirmService` → `deleteSongs` → `deletedSongIds()`;
  multiselect is one `createSelection()` + `SelectionBarComponent` everywhere.
  → [song-actions.md](song-actions.md)
- **Unified search**: `GET /api/search?q=` blends local library and parallel network results into one
  source-agnostic list. → [source-agnostic-acquisition.md](source-agnostic-acquisition.md)
- **Library cross-type find bar**: one box above the Library tabs searching everything you own at once
  (`LibraryFindComponent`); a non-empty query *replaces* the tab content rather than filtering the
  active tab, debounced into `?find=` so it is linkable. → [web-ui.md](web-ui.md)
- **Library "Songs" tab**: `GET /api/library/songs` backs a first-class flat listing with the shared
  filter, `TrackRowComponent` and multi-select; offline it swaps its source to
  `PreserveService.preservedTracks`. → [web-ui.md](web-ui.md)
- **Artist page — tabbed**: Albums | Singles & EPs | Songs, the last lazy and paginated with bulk
  actions including the only view that can remove albumless files.
  → [design-patterns.md](design-patterns.md)
- **Viewport-safe dropdown menus**: `MenuPanelComponent` flips above or clamps into the viewport via
  the pure `computeMenuPosition`, reserving a `bottomInset` from `bottomChromeInset` so it never opens
  under the mini-player. → [design-patterns.md](design-patterns.md)
- **Bottom-chrome stacking + scroll lock**: mini-player and tab bar share one plane;
  `ScrollLockService` pins the document under sheets; `BottomChromeSafeDirective` +
  `measureBottomChromeInset` keep tall modals reachable.
  → [design-patterns.md](design-patterns.md)
- **Page & section idioms**: every routed page inside the shell has a `page-shell` root with a width
  cap, grouped pages share `SettingsGroupComponent`, tables use `section-flush`; `page-shell.spec.ts`
  is the drift guard. → [web-ui.md](web-ui.md)
- **Settings-cards unification**: one bordered collapsible `SettingsGroupComponent` backs every group
  across all five settings-family views, collapsed by default and persisted per device via
  `group-state.ts`; `settings-consistency.spec.ts` is the cross-view gate.
  → [design-patterns.md](design-patterns.md),
  [admin-settings-decoupling.md](admin-settings-decoupling.md)
- **Admin/Settings/Extensions decoupling**: core Settings holds universal prefs only, server-admin
  tools live in Admin, and each addon renders through the generic `PluginCardComponent` +
  `AddonStatusPanelComponent`. → [admin-settings-decoupling.md](admin-settings-decoupling.md),
  [plugins.md](plugins.md)
- **Admin is one panel component per section**: `admin.component.html` is an ordered list of tags
  (reorder = one line); each panel owns its `<app-settings-group>` (`groupId` = localStorage key
  *and* e2e selector) and injects `ServiceReviewService` rather than taking inputs;
  `AcquisitionSettingsService` is the one cross-section signal.
  → [admin-settings-decoupling.md](admin-settings-decoupling.md)
- **ServiceReview (one resource, one polling lifecycle)**: `GET /api/admin/review` replaces the Admin
  page's N loaders; `ServiceReviewService` owns one visibility-paused interval and every sub-section
  is a `computed()` slice. Slices are gathered by name via `allNamed()`, never positionally.
  → [design-patterns.md](design-patterns.md)
- **List loading skeletons**: one shape-matched `SkeletonComponent` replaces the copy-pasted list
  spinner, so a spinner now means only "an action you started is in progress".
  → [web-ui.md](web-ui.md)
- **Pull-to-refresh (touch)**: one layout-hosted gesture on `<main>` (`pull-to-refresh.ts` composing
  `createPointerDrag`) plus a `PullToRefreshService` handler stack pages register into,
  coarse-pointer-gated. → [web-ui.md](web-ui.md)
- **Reactive network / offline detection**: `NetworkStatusService` is one live `online` signal **plus a
  monotonic `reconnects` counter**, because signals coalesce and a fast offline/online pair is
  invisible to a diff of `online`. `isOffline` is a `computed`;
  `reportServerFailure`/`reportServerSuccess` flip it both ways mid-session.
  → [mobile-app.md](mobile-app.md)
- **Manual PWA update check**: a Settings button calling `UpdateService.checkForUpdate()` with
  outcomes surfaced through `ToastService`; `UpdateBannerComponent` remains the install CTA.
  → [web-ui.md](web-ui.md)
- **Changelog modal**: build-time `CHANGELOG.md` → `changelog.json`, capped; the version string in
  header and settings is clickable. → [web-ui.md](web-ui.md)
- **Shared relative time**: one `timeAgo` (`lib/relative-time.ts`) for the Downloads feed and Admin
  users table, with the translator an optional param so the module stays pure.
  → [presence-tracking.md](presence-tracking.md)

### Data integrity, caching & migrations

- **Additive schema migrations**: `applySchema` runs every boot and must be idempotent;
  `addColumnIfMissing` checks `PRAGMA table_info` so "already there" is a condition and a real
  migration bug throws loudly. Additive columns only; no down-migration path by design.
  → [design-patterns.md](design-patterns.md)
- **Schema versioning + atomic migration**: `SCHEMA_VERSION` in SQLite's own `PRAGMA user_version`,
  stamped first inside one `db.transaction()`; `mayCarryLegacyShape` retires the destructive
  legacy-shape steps once stamped. A newer-than-binary stamp warns, never refuses.
  → [design-patterns.md](design-patterns.md)
- **Pre-migration snapshots**: `services/migration-backup.ts` snapshots via `VACUUM INTO` only when
  `user_version` is about to advance, skipping fresh installs via `hasSomethingToLose`, landing
  outside the daily rotation. `migrationBackupHook` is shared because `initDatabase` is not the only
  `applySchema` caller. → [backup-restore.md](backup-restore.md)
- **Daily backups**: `VACUUM INTO` snapshot + secrets into `<dataDir>/backups`, once per day via a
  marker-guarded processor-tick hook, pruned to newest N. Restore is a documented manual swap.
  → [backup-restore.md](backup-restore.md)
- **Config export/import (portable, host migration)**: a JSON bundle of the tables whose rows encode a
  human decision or a credential. Columns *and* primary keys read from `PRAGMA table_info` at runtime;
  secrets redacted by default and skipped on update; import is additive-merge only, dry-run-previewed
  through the apply's own code. → [config-export.md](config-export.md)
- **Orphan side-table pruning**: per-song side tables deliberately have no FK cascade (a rescan
  rebuilds `library_songs` wholesale), so orphans are swept by mark → unmark → sweep on `orphaned_at`
  with a grace period, and only for regenerable tables. `repointOrphanedAcquisitions` runs first.
  → [cache-invalidation.md](cache-invalidation.md)
- **Playlist membership survives a song-id change**: ids are `sha1(path)`, so any move re-mints one;
  `repointPlaylistsBeforePrune` runs *inside* the prune, before the delete, matching on a unique
  (title, artist, duration) and leaving ambiguity to dangle.
  → [cache-invalidation.md](cache-invalidation.md)
- **Cover-cache eviction**: `pruneCoverCache` sweeps entity-keyed files whose row is gone, with the
  same grace period; content-addressed keys have no owning row and are never counted as orphans.
  → [cache-invalidation.md](cache-invalidation.md)
- **Cache-invalidation on library mutations**: every write whose handler mutates artists or genres must
  `invalidateLibraryReads()` on success or the cached grid replays the stale list. The full cross-layer
  sweep and the "adding a cache" checklist are catalogued.
  → [cache-invalidation.md](cache-invalidation.md)
- **Measure prod before building**: `prod-probe.ts` owns read-only prod inspection
  (`--orphans`/`--jobs`/`--transfers`/`--sql`) behind two independent layers — a `{readonly:true}`
  connection and the legible `assertReadOnlySql`, whose ordering is load-bearing. Writes belong on a
  `VACUUM INTO` copy. → [prod-inspection.md](prod-inspection.md)

### Build, CI, deploy & ops

- **Quality gates assert their own denominator**: a gate that computes a smaller candidate set than it
  should still exits 0 truthfully. Gates derive their denominator independently, print what they
  examined, fail on what they cannot classify, and check allowlists both ways.
  → [quality-gates.md](quality-gates.md)
- **`check:route-auth`**: fails when an `/api` group is mounted without `auth` or a reasoned
  `PUBLIC_ROUTES` entry; AST-parsed, not grepped, and it fails when its own count disagrees with the
  file's. → [api-routes.md](api-routes.md)
- **`check:audit` — gated on what *ships***: filters advisories by the production closure (walking
  `bun.lock` from every workspace's `dependencies`) *and* the resolved version, reports the dependency
  path, fails on an unresolvable version, and warns-and-passes on an unreachable registry.
  → [quality-gates.md](quality-gates.md)
- **`check:fetch-timeouts`**: every outbound call is bounded. The gate walks the AST and matches any
  callee that *tokenises* to fetch, catching injected clients a `\bfetch\b` regex misses; signals go
  inline, after any throttle, since a timeout starts counting when constructed.
  → [quality-gates.md](quality-gates.md)
- **Secret + image scanning**: gitleaks runs over every commit (needs full history or the scan
  silently shrinks to one commit) as a pinned binary; Trivy scans the published image scoped to OS
  vulns and unfixed-ignored, as a *step* so blocking the deploy needs no `if:` edit.
  → [quality-gates.md](quality-gates.md)
- **CI boots the shipped artifact**: the docker build is unconditional and loaded, then a smoke step
  waits on the image's own healthcheck and asserts `/api/health` reports the expected version,
  matrixed over both published arches on native runners, never QEMU. The deploy then polls the host
  for that version. → [quality-gates.md](quality-gates.md)
- **Published Docker image**: multi-arch GHCR image published per release tag via native-runner digest
  builds and one manifest merge. The deploy *derives* which images to pull from the resolved compose
  config rather than a hardcoded list. Release tagging is orphan-tag-proof.
  → [deployment.md](deployment.md)
- **The runtime image ships only what it runs**: the production stage installs with `--production`
  from the isolated store; `.dockerignore` excludes tests; `USER bun` needs `/data` pre-created and
  chowned. → [deployment.md](deployment.md)
- **Unsafe shipped defaults, announced before removal**: `findInsecureDefaults`
  (`services/insecure-defaults.ts`) warns at boot, after the ready handshake, never fatally — it checks
  registered addon tokens, not env vars. → [deployment.md](deployment.md)
- **Bounded outbound clients**: `LidarrClient` timeouts come in three tiers (local, lookup, provision)
  because many call sites swallow failures, so one flat budget degrades silently; a timeout is
  re-thrown as "timed out". MusicBrainz uses a discriminated `FetchOutcome` so an outage is never
  cached as a confirmed absence. → [design-patterns.md](design-patterns.md)
- **We build the YouTube PO-token provider**: `ghcr.io/kevinch3/nicotind-pot-provider` built from
  pinned upstream source; the canonical version is published on the artifact as a label, pinned by
  `pot-provider-pin.test.ts`. → [deployment.md](deployment.md)
- **Service modes**: `embedded` (best-effort manage Lidarr) or `external`; the library and streaming
  stack is always in-process. → [design-patterns.md](design-patterns.md)
- **Observability (Sentry, opt-in)**: empty DSN = off; the web SDK loads lazily behind a synchronous
  `error-buffer.ts` + `BufferingErrorHandler` that replays startup errors on connect; the API reports
  only unknown 500s plus aggregated `captureProcessingFailure` events.
  → [observability.md](observability.md)
- **Server update check + version history**: daily cached GitHub-releases poll, marker-guarded and
  scheduled from `main.ts` (never the processor tick, so unit tests cannot hit the network);
  `version_history` records every version booted. → [deployment.md](deployment.md)
- **Dependency management**: `bun outdated --filter '*'` drives manual bumps and CI is the gate; two
  majors are deliberately held by peer constraints. Renovate is configured with majors isolated,
  automerge off, and an unscheduled `vulnerabilityAlerts` block.
  → [dependency-management.md](dependency-management.md)
- **OSS best-practices roadmap**: prioritized adoption plan of Immich/Home-Assistant practices.
  → [oss-best-practices.md](oss-best-practices.md)
