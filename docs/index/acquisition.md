# Acquisition & downloads

One section of [the index](../index.md). Entry shape and caps are unchanged and
`bun run check:claude-md` still enforces them here.

- **Source-agnostic acquisition (the north star)**: every acquirable result from any source maps to
  one `AcquisitionCandidate` in one blended ranked list; a new source is one adapter + a pure mapper.
  → [source-agnostic-acquisition.md](../source-agnostic-acquisition.md)
- **Acquisition addon protocol**: open HTTP protocol (`validateAddonManifest`, `AddonClient`,
  `RemoteAddonPlugin`, `addon_registrations`, `loadRegisteredAddons`); `AddonSearchProvider` and
  `AddonJobPoller` light up every lane with no route changes.
  → [acquisition-addon-protocol.md](../acquisition-addon-protocol.md)
- **Plugin architecture + addon marketplace**: kind-agnostic kernel + `PluginRegistry`, acquisition
  default-off; in-process plugins are spotify/lrclib/discogs/acoustid, built in
  `registerBuiltinPlugins`. `ADDON_CATALOG` + `promotePendingAddons` back one-click install.
  → [plugins.md](../plugins.md)
- **Album hunt** — *addon-owned*: `AlbumHunterService`, `huntBase`, `searchAndScore`,
  `isBloatedFolder`, `FallbackHost`, `isStalled`, `stallThresholdMs` and `TransferPoller` live in the
  `kevinch3/nicotind-slskd-addon` repo, not here. Core keeps `buildSkewedQueries`/`buildTrackQueries`.
  `matchPct` is recall-only by design. → [album-hunt.md](../album-hunt.md)
- **Source-offline gate**: an addon's `ready` answers "can a hunt sent here succeed", so a source
  that is up but logged out of its network is not mistaken for an empty result; `sourceOffline`
  (`addonIsReady`, `sourceOffline`) makes the acquire defer instead of recording a miss; the
  readiness probe + reconnect kick are addon-owned.
  → [acquisition-addon-protocol.md](../acquisition-addon-protocol.md)
- **Search-lane honesty**: a hunt reports how many searches it fired vs answered, so one the
  source cut short (its two search lanes held by other work) is retried, not recorded as a miss
  (`huntCutShort`, `searchesAnswered`, `anyHunting`).
  → [acquisition-addon-protocol.md](../acquisition-addon-protocol.md)
- **Addon download lifecycle**: the addon owns a job's downloaded bytes until core releases the
  job, so a release must be earned — `pendingIngestCount` is zero only when everything wanted is
  durably landed. `judgeStrandedFile` reclaims the pre-existing backlog on proof (title + duration
  + the library's own file), never on a title match alone.
  → [acquisition-addon-protocol.md](../acquisition-addon-protocol.md)
- **Idempotent hunt — one album = one download**: 409 guards + only-missing-tracks enqueue;
  "already have it" surfaces as a notice, not an error. → [album-hunt.md](../album-hunt.md)
- **Watchlist auto-hunt**: star a catalog album; a poller auto-hunts and downloads on a confident
  match. → [album-hunt.md](../album-hunt.md)
- **Auto-acquisition loop (opt-in)**: default-off poller over Lidarr `wanted/missing`, routed through
  the shared `acquireAlbum` core so it is idempotent and re-entrant.
  → [auto-acquisition-plan.md](../auto-acquisition-plan.md)
- **Catalog (metadata-driven) search**: `CatalogService` returns artist/album cards from
  Lidarr/MusicBrainz scoped to the matched artist; a catalog miss opens the folder-first network lane,
  with full-discography load opt-in. → [album-hunt.md](../album-hunt.md)
- **URL acquisition (yt-dlp / spotdl / archive)**: `POST /api/acquire` routes a URL via
  `resolveAddonForUrl` to a `resolve`-capable addon, bundled (`LocalAddonTransport`) or external,
  matched by `urlPatterns`; `resolveAcquireAs`, `findInFlightAddonUrlJob`, `applyAddonOutcome`,
  `sanitizeAddonError`.
  → [download-pipeline.md](../download-pipeline.md),
  [acquisition-addon-protocol.md](../acquisition-addon-protocol.md)
- **Re-source a stuck download from another peer**: a fresh hunt, a peer picker, and a second
  addon job scoped to the still-pending titles and mirrored onto the same card, the stuck job
  released first; `canResourceJob`, `coveredTitles`, `rankAlternates`, `supersedeItems`,
  `OWNED_BY_ADDON_JOB`, `conflictOnActiveAlbum`.
  → [download-pipeline.md](../download-pipeline.md)
- **Spotify metadata fallback**: metadata-only lane handing a `spotify.com/album` URL to
  `/api/acquire`; the external spotdl addon resolves the download.
  → [spotify-fallback.md](../spotify-fallback.md)
- **A link that names one release names its album**: `albumTitleForUrlJob` + the poller's
  `fillAlbumTitleFromLink` promote a display title to filing metadata for a non-playlist album URL;
  `isUnknownLike` rejects placeholders. → [download-pipeline.md](../download-pipeline.md)
- **Identity resolved beside the transfer**: `AcquireMetadataPrefetch` + `lookupRelease` +
  `spotifyResourceFromUrl` name a URL job and fix its size at submit; `hasCommittedTotal` hides an
  uncommitted denominator and `jobDenominator` is the only one the card prints or divides by.
  → [download-pipeline.md](../download-pipeline.md)
- **Playlist-from-acquisition**: a URL job classified as a playlist auto-generates a native playlist
  from landed tracks in download order — addon-native (the live path, issue #587):
  `materializeAddonPlaylist`; legacy in-process fallback: `classifyAcquireUrl`,
  `recordAcquireJobTrack`. → [playlist-from-acquisition.md](../playlist-from-acquisition.md)
- **Guided acquire UX**: catalog cards are the primary path, the raw peer lane sits behind Advanced;
  `pickNetworkView` defaults to Folders for album intent, `AutoHuntService` self-heals one-click Get.
  → [album-hunt.md](../album-hunt.md)
- **Merged `/get` workspace**: Acquire + Downloads are one route with a `?tab=find|downloads` shell
  (`GetComponent`); the `@if` is load-bearing (destroying the inactive tab unregisters its handlers).
  → [web-ui.md](../web-ui.md)
- **Acquisition kill-switch**: one `config.acquisitionEnabled` (env `NICOTIND_ACQUISITION=off`) hard-404s
  every acquisition route group via `requireAcquisitionEnabledMiddleware`, skips the search fan-out and
  the pollers, and cascades to the web through `canAcquire`. Env is a floor an admin cannot lift.
  → [deployment.md](../deployment.md)
- **Unified acquisition jobs**: every download is wrapped in an `acquisition_jobs` row whose
  transfer↔job linkage is stored at enqueue time, never re-derived. `markItemsScanned`,
  `reconcileOrganizedItems`, `filesForCanonicalTracks`, `backfillDirectJobAlbum`.
  → [acquisition-jobs.md](../acquisition-jobs.md)
- **The job state vocabulary says what is happening**: `resolving` and item-state `queued` are real
  members, the row is reserved before the source is called, a stalled item cannot pin the stage, and
  an Error card always has a reason. `attachAddonRef`, `failReservedJob`, `reapIdleItems`,
  `stalledItemStillRules`, `allItemsFailedReason`. → [download-pipeline.md](../download-pipeline.md)
- **Unified downloads feed — one job = one card**: addon and URL jobs adapt into one `DownloadItem`;
  card identity is the job id recorded at enqueue. `listJobFeed`, `mergeAcquisitionJobs`,
  `mapAddonJob`, `cancelUnownedJob`, `methodForBackend`, `downloadTitleFor`.
  → [download-pipeline.md](../download-pipeline.md)
- **A partial download says why, and can be retried**: per-track failures grouped by class on the
  card, a `trackBreakdown` disclosure naming which ones, and a Retry that reaches partial addon URL
  jobs. `parseJobFailureSummary`, `classifyTrackFailure`, `summarizeFailures`, `failureClassLabel`,
  `allItemsFailedMessage`, `canShowNowNext`. → [download-pipeline.md](../download-pipeline.md)
- **Inline download lifecycle**: result cards go idle → progress % → "Open in Library", driven by
  `TransferService` + a `libraryDirty` signal. → [design-patterns.md](../design-patterns.md),
  [download-pipeline.md](../download-pipeline.md)
- **Download list metadata**: `GET /api/downloads` annotates in-flight folders from `album_jobs`;
  `destinationAlbums` disambiguates where a completed job landed.
  → [download-pipeline.md](../download-pipeline.md)
- **Acquisition provenance**: the `acquisitions` side-table records method/source/time at download
  time, surfaced per track. → [download-pipeline.md](../download-pipeline.md)
- **Quality chip on download cards**: `bitrateKbps` + `audioFormat` per item, rendered by the pure
  `formatQuality`; `enrichWithBitrate` upgrades it post-scan.
  → [download-pipeline.md](../download-pipeline.md)
- **Duplicate prevention**: FLAC>MP3, auto-dedupe, edition-collapsing album IDs, cross-edition folder
  consolidation at ingest; the cross-peer fallback splits `missing` from `recoverable` so a wave
  cannot duplicate one in flight. → [download-pipeline.md](../download-pipeline.md),
  [album-hunt.md](../album-hunt.md)
- **Lossless → Opus standardization**: lossless downloads transcoded in place (default-on 192 kbps),
  codec-aware via `isLosslessFile`, gated on ffmpeg, surfaced read-only at
  `GET /api/settings/downloads`. → [download-pipeline.md](../download-pipeline.md)
- **Reserved paths — staging lives inside `musicDir`, invisibly**: one `library-paths.ts`
  (`reservedDirsFor`, `isReservedTopLevel`, `isHiddenFile`, `isReservedPath`) is the only answer to
  "is this library content?"; the rule is depth-scoped (root dot-dirs skipped, album titles never
  judged) and `check:library-walkers` keeps all 14 walkers honest.
  → [library-path-conventions.md](../library-path-conventions.md)
- **slskd's incomplete dir is pruned by slskd, not by us**: `SLSKD_INCOMPLETE_RETENTION_MINUTES`
  reaches `retention.files.incomplete` only through `scripts/slskd-configure.sh`, because slskd
  binds env vars from an `[EnvironmentVariable]` allowlist; `retention.files.complete` stays unset
  (it would prune the addon-owned staging dir).
  → [library-path-conventions.md](../library-path-conventions.md)
- **Import music — two lanes into one pipeline**: an admin server path and a browser upload
  (`ImportUploadService`, chunked + resumable, `submitStaged`) both run through organize → scan;
  drop a folder on `/get`, gated by `canImport`. → [import.md](../import.md)
- **Untracked downloads**: `relative_path IS NULL` rows backfilled by script, listed at
  `GET /api/library/untracked`. → [download-pipeline.md](../download-pipeline.md)
- **Downloading albums suppressed from listing**: listings exclude albums with active `album_jobs` or
  in-flight transfers via an SQL `WHERE` exclusion.
  → [design-patterns.md](../design-patterns.md)
- **Album deletion**: folder-first `rmSync` + synchronous canonical-row delete + orphan-aggregate
  prune; every delete route debounce-schedules a `ShareRescanScheduler` pass. A single-song delete
  refreshes its album through the shared `refreshAlbumAggregate` / `pruneOrphanAlbum`.
  → [download-pipeline.md](../download-pipeline.md)
- **Fingerprint identify + metadata candidates**: `gatherCandidates` merges Lidarr/MusicBrainz/
  Discogs/tag guesses; `identifyTrackDetailed` returns a typed `IdentifyOutcome` (`undecodable`
  carries fpcalc's stderr). → [acoustid-identify.md](../acoustid-identify.md)
- **Release-type model (singles & EPs)**: every album carries a `classification`, set metadata-first
  with a track-count heuristic fallback. → [download-pipeline.md](../download-pipeline.md)
