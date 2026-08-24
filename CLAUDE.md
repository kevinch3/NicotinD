# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

**This file is an index, not a detail store.** It loads into *every* request, so every byte here is
paid on every task. It answers one question — *"where does this live, and what is it called?"* — and
hands off. The reasoning, the incident history and the measurements live in `docs/`, which is loaded
only when relevant.

**The shape of an entry** is fixed: **name**, one sentence of *what it is*, the symbols you would
grep for, and a link to the doc that explains *why*. No rationale, no issue narratives, no prod
numbers, no trade-off discussion — those go in the linked doc. `bun run check:claude-md` enforces
this: it fails on an entry that outgrows the cap, on a total file over budget, on a named symbol
that exists nowhere in code, and on a link to a doc that does not exist.

**When you change behavior**, update the linked `docs/` page in the same commit, and touch the index
line here only if the *name* or the *location* changed. → [quality-gates.md](docs/quality-gates.md)

## Quality Gates

Three gates, all mandatory before a task is done.

1. **Every change is tested.** Features get tests, fixes get regression tests, refactors keep
   coverage. If it cannot be unit-tested, add an integration or e2e test.
2. **Every test runs in CI.** `bun run verify` runs every gate job (`ci` + `web-test` + `storybook`)
   in one command — use it before pushing. `check:ci-parity` keeps it honest. `bun run e2e` is
   deliberately outside `verify` (own CI job, minutes long) — run it before declaring a feature done,
   especially after any `data-testid`, popover or route-DOM change.
3. **Docs are updated in the same commit as the code.** A doc statement made wrong by a change is a
   bug. Detail goes in `docs/<feature>.md` or [design-patterns.md](docs/design-patterns.md); the
   index line here just points at it; a short `// why` comment carries local rationale.

→ [quality-gates.md](docs/quality-gates.md) for what each gate measures and why gates assert their
own denominator.

## What is NicotinD?

A unified music acquisition + streaming platform. Acquisition sources are external, Torrentio-style
**addons** (core carries zero source-specific code and talks to them over the acquisition addon
protocol); NicotinD **natively scans and streams** the music library itself. Downloads land in a
shared folder, get organized, and are incrementally scanned into the canonical SQLite library the API
streams from. Navidrome, the `/rest/*` Subsonic proxy and the original playlist feature were removed
in the native migration.

## Commands

```bash
bun install              # Install all workspace dependencies
bun run verify           # Every gate the CI gate jobs run — run this before pushing
bun run typecheck        # tsc --build + Angular templates + e2e specs + web specs (all four surfaces)
bun run lint             # ESLint over packages/*/src + src (quote the globs). NOT packages/web (#612)
bun run test             # Vitest across packages/ + src/
bun run test:web         # Angular component tests (vitest, never `ng test`)
bun run e2e              # Playwright suite — always run before declaring a feature done
bun run e2e:tv           # Android TV emulator lane (real APK on an AVD)
bun run format           # Prettier — .ts only, never Markdown/YAML
bun run format:check     # CI gate
bun run release          # Bump version, generate CHANGELOG, tag (:minor / :major to force)
bun run src/main.ts      # Start NicotinD (requires .env or config/default.yml)
```

**Check gates** (all CI-blocking unless noted): `check:claude-md` (this file's symbols, links and
size) · `check:ci-parity` (a gate job step `verify` misses, or a gate that stopped blocking
`release`) · `check:route-auth` (an `/api` group mounted with no auth decision) · `check:audit` (an
advisory that both ships and matches the resolved version) · `check:shared-helpers` (a shared helper
re-implemented locally) · `check:json` (duplicate keys) · `check:shipped-issues` (report, not a gate)
· `check:isolated-specs` (slow, not a gate). → [quality-gates.md](docs/quality-gates.md)

**Diagnostics**: `bun run packages/api/src/scripts/prod-probe.ts --orphans --jobs` (read-only prod/dev
DB probe) → [prod-inspection.md](docs/prod-inspection.md)

## Commit Conventions

[Conventional Commits](https://www.conventionalcommits.org/), enforced by a husky + commitlint
`commit-msg` hook: `<type>(<optional scope>): <description>`.

| Bumps version                 | Does not bump                                                      |
| ----------------------------- | ------------------------------------------------------------------ |
| `feat` minor · `fix` `perf` patch | `chore` `refactor` `style` `docs` `test` `ci` `build`           |

`BREAKING CHANGE:` in the body or `!` after the type triggers a major bump.

**Closing issues**: put **`Closes #N` in the PR body** — that is the action GitHub honours on merge.
`(#N)` in a commit subject only *references*, and the issue stays open forever. Use `Refs #N` for
partial work. → [quality-gates.md](docs/quality-gates.md), [releasing.md](docs/releasing.md)

## Architecture

```
NicotinD (Hono API :8484)  — native library scanner + streaming, all in-process
└── acquisition addons (own repos + images, registered over the addon protocol)
        AddonJobPoller (HTTP) → LibraryOrganizer → LibraryScanner (tags → SQLite)
```

**Bun monorepo.** Entry point `src/main.ts` loads config, starts services, wires clients into the API.

| Package                     | Purpose                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `@nicotind/core`            | Shared Zod types, logger, crypto utils, error classes                        |
| `@nicotind/addon-sdk`       | Published npm SDK: addon protocol v1 DTOs, hunt-query helpers, leaf logger    |
| `@nicotind/service-manager` | Sub-service lifecycle strategies (Lidarr only since the addon split)          |
| `@nicotind/api`             | Hono API — routes, JWT auth, search, download watcher, scanner, streaming, DB |
| `@nicotind/web`             | Angular v22 web UI (standalone components, signals, Tailwind)                 |

## Key Design Patterns

The index proper. Each line: what it is, what to grep for, where the detail lives.

### Acquisition & downloads

- **Source-agnostic acquisition (the north star)**: every acquirable result from any source maps to
  one `AcquisitionCandidate` in one blended ranked list; a new source is one adapter + a pure mapper.
  → [source-agnostic-acquisition.md](docs/source-agnostic-acquisition.md)
- **Acquisition addon protocol**: open HTTP protocol (`validateAddonManifest`, `AddonClient`,
  `RemoteAddonPlugin`, `addon_registrations`, `loadRegisteredAddons`); `AddonSearchProvider` and
  `AddonJobPoller` light up every lane with no route changes.
  → [acquisition-addon-protocol.md](docs/acquisition-addon-protocol.md)
- **Plugin architecture + addon marketplace**: kind-agnostic kernel + `PluginRegistry`, acquisition
  default-off; in-process plugins are spotify/lrclib/discogs/acoustid, built in
  `registerBuiltinPlugins`. `ADDON_CATALOG` + `promotePendingAddons` back one-click install.
  → [plugins.md](docs/plugins.md)
- **Album hunt** — *addon-owned*: `AlbumHunterService`, `huntBase`, `searchAndScore`,
  `isBloatedFolder`, `FallbackHost`, `isStalled`, `stallThresholdMs` and `TransferPoller` live in the
  `kevinch3/nicotind-slskd-addon` repo, not here. Core keeps `buildSkewedQueries`/`buildTrackQueries`.
  `matchPct` is recall-only by design. → [album-hunt.md](docs/album-hunt.md)
- **Idempotent hunt — one album = one download**: 409 guards + only-missing-tracks enqueue;
  "already have it" surfaces as a notice, not an error. → [album-hunt.md](docs/album-hunt.md)
- **Watchlist auto-hunt**: star a catalog album; a poller auto-hunts and downloads on a confident
  match. → [album-hunt.md](docs/album-hunt.md)
- **Auto-acquisition loop (opt-in)**: default-off poller over Lidarr `wanted/missing`, routed through
  the shared `acquireAlbum` core so it is idempotent and re-entrant.
  → [auto-acquisition-plan.md](docs/auto-acquisition-plan.md)
- **Catalog (metadata-driven) search**: `CatalogService` returns artist/album cards from
  Lidarr/MusicBrainz scoped to the matched artist; a catalog miss opens the folder-first network lane,
  with full-discography load opt-in. → [album-hunt.md](docs/album-hunt.md)
- **URL acquisition (yt-dlp / spotdl / archive)**: `POST /api/acquire` routes a URL to a
  `resolve`-capable addon via `resolveAddonForUrl` — bundled (`LocalAddonTransport`) or external,
  matched by `urlPatterns`. `resolveAcquireAs`, `findInFlightAddonUrlJob`, `applyAddonOutcome`,
  `sanitizeAddonError`.
  → [download-pipeline.md](docs/download-pipeline.md),
  [acquisition-addon-protocol.md](docs/acquisition-addon-protocol.md)
- **Spotify metadata fallback**: metadata-only lane handing a `spotify.com/album` URL to
  `/api/acquire`; the external spotdl addon resolves the download.
  → [spotify-fallback.md](docs/spotify-fallback.md)
- **Playlist-from-acquisition**: a URL job classified as a playlist auto-generates a native playlist
  from landed tracks in download order — addon-native (the live path, issue #587):
  `materializeAddonPlaylist`; legacy in-process fallback: `classifyAcquireUrl`,
  `recordAcquireJobTrack`. → [playlist-from-acquisition.md](docs/playlist-from-acquisition.md)
- **Guided acquire UX**: catalog cards are the primary path, the raw peer lane sits behind Advanced;
  `pickNetworkView` defaults to Folders for album intent, `AutoHuntService` self-heals one-click Get.
  → [album-hunt.md](docs/album-hunt.md)
- **Merged `/get` workspace**: Acquire + Downloads are one route with a `?tab=find|downloads` shell
  (`GetComponent`); the `@if` is load-bearing (destroying the inactive tab unregisters its handlers).
  → [web-ui.md](docs/web-ui.md)
- **Acquisition kill-switch**: one `config.acquisitionEnabled` (env `NICOTIND_ACQUISITION=off`) hard-404s
  every acquisition route group via `requireAcquisitionEnabledMiddleware`, skips the search fan-out and
  the pollers, and cascades to the web through `canAcquire`. Env is a floor an admin cannot lift.
  → [deployment.md](docs/deployment.md)
- **Unified acquisition jobs**: every download is wrapped in an `acquisition_jobs` row whose
  transfer↔job linkage is stored at enqueue time, never re-derived. `markItemsScanned`,
  `reconcileOrganizedItems`, `filesForCanonicalTracks`, `backfillDirectJobAlbum`.
  → [acquisition-jobs.md](docs/acquisition-jobs.md)
- **Unified downloads feed — one job = one card**: addon and URL jobs adapt into one `DownloadItem`;
  card identity is the job id recorded at enqueue. `listJobFeed`, `mergeAcquisitionJobs`,
  `mapAddonJob`, `cancelUnownedJob`, `methodForBackend`, `downloadTitleFor`.
  → [download-pipeline.md](docs/download-pipeline.md)
- **A partial download says why, and can be retried**: per-track failures grouped by class on the
  card; Retry reaches partial addon URL jobs, not just failed ones. `parseJobFailureSummary`,
  `classifyTrackFailure`, `summarizeFailures`, `failureClassLabel`, `allItemsFailedMessage`.
  → [download-pipeline.md](docs/download-pipeline.md)
- **Inline download lifecycle**: result cards go idle → progress % → "Open in Library", driven by
  `TransferService` + a `libraryDirty` signal. → [design-patterns.md](docs/design-patterns.md),
  [download-pipeline.md](docs/download-pipeline.md)
- **Download list metadata**: `GET /api/downloads` annotates in-flight folders from `album_jobs`;
  `destinationAlbums` disambiguates where a completed job landed.
  → [download-pipeline.md](docs/download-pipeline.md)
- **Acquisition provenance**: the `acquisitions` side-table records method/source/time at download
  time, surfaced per track. → [download-pipeline.md](docs/download-pipeline.md)
- **Quality chip on download cards**: `bitrateKbps` + `audioFormat` per item, rendered by the pure
  `formatQuality`; `enrichWithBitrate` upgrades it post-scan.
  → [download-pipeline.md](docs/download-pipeline.md)
- **Duplicate prevention**: FLAC>MP3, auto-dedupe, edition-collapsing album IDs, cross-edition folder
  consolidation at ingest; the cross-peer fallback splits `missing` from `recoverable` so a wave
  cannot duplicate one in flight. → [download-pipeline.md](docs/download-pipeline.md),
  [album-hunt.md](docs/album-hunt.md)
- **Lossless → Opus standardization**: lossless downloads transcoded in place (default-on 192 kbps),
  codec-aware via `isLosslessFile`, gated on ffmpeg, surfaced read-only at
  `GET /api/settings/downloads`. → [download-pipeline.md](docs/download-pipeline.md)
- **Import music from a folder or archive (API-only)**: `LibraryImportService` runs a server folder or
  `.zip` through the same organize → scan → quarantine pipeline; `import-archive.ts` is a
  dependency-free central-directory-first reader with `safeArchivePath`. → [import.md](docs/import.md)
- **Untracked downloads**: `relative_path IS NULL` rows backfilled by script, listed at
  `GET /api/library/untracked`. → [download-pipeline.md](docs/download-pipeline.md)
- **Downloading albums suppressed from listing**: listings exclude albums with active `album_jobs` or
  in-flight transfers via an SQL `WHERE` exclusion.
  → [design-patterns.md](docs/design-patterns.md)
- **Album deletion**: folder-first `rmSync` + synchronous canonical-row delete + orphan-aggregate
  prune; every delete route debounce-schedules a `ShareRescanScheduler` pass.
  → [download-pipeline.md](docs/download-pipeline.md)
- **Download inbox triage (hold-for-review)**: opt-in `holdForReview` holds quarantined downloads for
  curator approval; `download_reviews` decisions, multi-source candidates, AcoustID identify with
  typed failures. → [download-review.md](docs/download-review.md)
- **Release-type model (singles & EPs)**: every album carries a `classification`, set metadata-first
  with a track-count heuristic fallback. → [download-pipeline.md](docs/download-pipeline.md)

### Library & metadata

- **Native library scanner**: `LibraryScanner` walks the music dir, reads tags → `library_*` tables
  with deterministic SHA1 ids; `resolveTags` applies overrides before minting ids. Incremental
  `scan_cache` + `mapPool`, `applyPerformancePragmas`, `albumIdsByGroupKey`.
  → [library-scanner.md](docs/library-scanner.md)
- **VA / compilation handling**: `resolveTags` separates `albumArtist` from `trackArtist`;
  `classifyFolder` detects compilations; dedicated Compilations tab, VA hidden from artists.
  → [library-scanner.md](docs/library-scanner.md)
- **Multi-artist support (confirmation-gated)**: `splitArtists` splits a compound only when every part
  is a confirmed artist; `segmentConcatenatedArtist` handles delimiter-less mashes;
  `library_artist_identity` + `library_artist_aliases` survive rescans; `corroboratesLidarrHit` and
  `boundedEditDistance` guard provisioning. → [library-scanner.md](docs/library-scanner.md)
- **Artist MBID resolution + homonyms**: one `library_mbids` row per normalized name feeds every
  non-tag artist surface; `pickMbidHit` returns null on ambiguity and
  `pickByDiscographyOverlap` breaks the tie. Curator repair is `PUT /api/library/artists/:id/mbid`.
  → [library-scanner.md](docs/library-scanner.md)
- **Artist bios (auto + override)**: MBID-first Discogs lookup into `library_artist_meta` with
  tombstones; auto-fetch on first artist-page visit; `formatArtistBio` strips Discogs BBCode;
  `resolveMbidViaLidarr` is two-stage. → [library-scanner.md](docs/library-scanner.md)
- **Artist images (auto + override)**: priority-ordered provider chain
  (`buildArtistImageProviders` → lidarr/spotify/discogs) walked by `resolveArtistImageUrl`; one shared
  `fillArtistImages` behind the task, the one-shot route and the backfill script;
  `ArtistImageMenuComponent`, `NEEDS_PORTRAIT_SQL`, `artistImageCoverage`.
  → [library-scanner.md](docs/library-scanner.md)
- **Artist curation survives an identity fix**: `carryArtistCuration` moves artwork, uploads, bio and
  the name-keyed genre override at the fix site when a rename/merge re-mints the artist id.
  → [library-scanner.md](docs/library-scanner.md)
- **Canonical artwork**: `library_artwork` stores canonical URLs keyed on deterministic ids, so they
  survive rescans. → [library-scanner.md](docs/library-scanner.md)
- **Multi-genre support (primary + extras)**: `splitGenres` parses full tag frames into
  `library_song_genres` (position 0 = primary); human-gated `library_genre_aliases` and
  `segmentConcatenatedGenre` fix concatenations at scan time; `backfillGenresFromAliases`.
  → [library-scanner.md](docs/library-scanner.md)
- **Curator-correctable genres**: `library_genre_overrides` (scope artist/album/song) is the one genre
  write that can *replace* a primary, carrying an explicit `mode`; `status` is the review queue;
  `backfillGenreOverrides`, `appendSongGenres`, `ArtistGenreModalComponent`.
  → [library-scanner.md](docs/library-scanner.md)
- **Genre radar**: `artistGenreDistribution` + `albumGenreDistribution` feed an inline-SVG radar and a
  read-only `GenreDistributionStripComponent`; pure `radar-geometry.ts` + `genre-projection.ts`;
  album aggregate is `mostCommonGenre`. Weights deliberately do not sum to 1.
  → [genre-radar.md](docs/genre-radar.md)
- **Artist origin / nationality**: `library_artist_origins` (MB-first, TTL tombstones, permanent user
  rows); core `origin.ts` vocab + `originCloseness`; a radio axis, a filter, and an artist-page flag
  line with curator edit. → [artist-origin.md](docs/artist-origin.md)
- **Popularity / hotness per song**: normalized 0–1 `library_songs.popularity` from ListenBrainz via
  `ListenBrainzClient` + `normalizePopularity`, MBID-native and tags-first. Not tag-mirrored, so it
  survives rescans untouched. → [popularity.md](docs/popularity.md)
- **Search matching (tokenized + accent-insensitive)**: shared `search-tokens.ts`
  (`tokenize`/`matchesAllTokens`) folds and ANDs per token over a name+artist haystack; the catalog
  lane reuses it through `filterAlbumsByRelevance`. → [library-scanner.md](docs/library-scanner.md)
- **Fragmentation diagnostic**: `checkFragments` surfaces same-release spelling variants and
  mis-classified albums via `contradictsTrackCount`, each row carrying its remediation
  (`fragment-remediation.ts`). → [library-scanner.md](docs/library-scanner.md)
- **Metadata optimization**: conservative all-or-nothing bulk Lidarr re-fetch (`optimizeAllAlbums`),
  run as a cancellable background job on `MaintenanceService`, bounded by limit + cursor.
  → [metadata-optimize.md](docs/metadata-optimize.md)
- **User-driven metadata fix**: interactive Lidarr candidate search + free-text + multi-source cover
  picker, persisted in `library_metadata_overrides` with immediate canonical re-point.
  → [metadata-optimize.md](docs/metadata-optimize.md)
- **On-demand track analysis (BPM + genre)**: per-track analyze/verify in the track-info drawer plus
  bulk backfill scripts, writing DB *and* file tag; BPM is sidecar-first; curator-gated AcoustID
  identify via `buildIdentifyApplyTags`. → [library-processing.md](docs/library-processing.md),
  [download-review.md](docs/download-review.md)
- **Standardized library metadata filters**: one shared `LibraryFilter` filters the library tabs and
  artist Songs tab server-side, with song properties matching via any-track `EXISTS` and state in URL
  query params. → [library-filters.md](docs/library-filters.md)
- **Library quality auditor**: assert (audit) + clean (repair/retag) + prevent (ingest sanitize) for
  DJ-pool/VA-source pollution across DB and disk; structural DJ-set tags recover their real
  artist via `djSetArtistName`. → [library-audit.md](docs/library-audit.md)
- **Discogs metadata plugin**: default-off consent-gated `metadata` plugin resolving release
  genres/styles, MBID-first via `parseDiscogsRef` then corroborated `selectBestRelease`; the
  album-scoped `genre-discogs` task writes gated `library_genre_overrides`.
  → [discogs-plugin.md](docs/discogs-plugin.md)

### Audio analysis & enrichment

- **Library processing**: resumable background enrichment via an extensible task registry, run
  continuously while enabled; failures are diagnosed and tallied into `ProcessingStatus`, and broken
  or undetectable files are excluded via a `library_song_analysis_failures` ledger.
  `NoConfidentResultError`, `AudioFileRejectedError`. → [library-processing.md](docs/library-processing.md)
- **Processing pause**: a `paused` flag is the runtime halt distinct from `enabled: false` (still
  clears quarantine), and the manual way to stand down for another GPU tenant. The failure tally's
  session boundary is one continuous drain (`drained`), not a time window.
  → [library-processing.md](docs/library-processing.md)
- **Analysis sidecar GPU behaviour**: `RegistryHolder` + `IdleReleaseGuard` drop the warm registry
  after an idle timeout and reload lazily; `peek()` reads without touching the guard and `can_serve()`
  backs `/health`; `musicnn_batch_size` bounds the one predictor that dominated VRAM.
  → [audio-ml-enrichment.md](docs/audio-ml-enrichment.md)
- **Process-before-landing (quarantine gate)**: a fresh download is scanned but held
  (`landed_at IS NULL`, hidden from listings) until its required steps finish; a per-task `gates` flag
  intersected with availability is the required set. `graduatePending`, `scanIncremental`,
  `kickEager`, `albumLoadFailureFor`. → [library-processing.md](docs/library-processing.md)
- **Perceptual audio features (no LLM)**: energy/loudness via ffmpeg ebur128; danceability, valence,
  mood, vocals, acousticness and cached embeddings from the Essentia sidecar; all written to file tags
  and COALESCE-preserved columns. `library_embeddings`, `embedding-store.ts`.
  → [audio-ml-enrichment.md](docs/audio-ml-enrichment.md), [radio.md](docs/radio.md)
- **Audio descriptors — timbre / groove / spectral balance**: sidecar `/descriptors` + store, phase 1
  of the radio-axis work. → [audio-descriptors.md](docs/audio-descriptors.md)

### Playback, radio & streaming

- **Native streaming + cover art**: `GET /api/stream/:id` (Range/206 + seekable transcode cache) and
  `GET /api/cover/:id`; `GET /api/cover/remote` proxies catalog covers through the same downscale
  path, host-allowlisted and content-addressed. `nativeAppCors` is hand-rolled so its Vary append
  cannot strip `Content-Length`. → [library-scanner.md](docs/library-scanner.md),
  [album-hunt.md](docs/album-hunt.md)
- **RFC 9110-complete range handling**: `serveFileWithRange` serves suffix ranges (`bytes=-N` = the
  *last* N bytes) correctly — returning the head under a mismatched Content-Range stalls iOS Safari's
  tail-probing media loader forever. → [library-scanner.md](docs/library-scanner.md)
- **Transcode cache integrity**: size-in-key, size floor, ffprobe post-check, an in-use pin released
  by `schedulePinRelease` (a body wrapper made Bun emit a chunked 206 that Firefox and iOS stall on),
  and a negative cache for the deterministic `TranscodeOutputRejectedError` only.
  → [library-scanner.md](docs/library-scanner.md)
- **Frontend false-ended recovery**: `browserDurationIsAcceptable`, `isFalseEnded`, `startRecovery`,
  `loadGeneration`, bounded by `MAX_RECOVERY_ATTEMPTS` with both gates falling back to
  `FALSE_ENDED_ABSOLUTE_FLOOR_SEC` when the known duration is missing. → [web-ui.md](docs/web-ui.md)
- **Playback loading feedback (HDD-aware)**: one `buffering` signal (delayed `bufferingVisible`)
  drives spinners, row indicators and the buffered band; every stream URL goes through `streamUrl()`,
  which appends `ngsw-bypass`. Restore-on-load never autoplays — `wasPlaying` is written, not read.
  → [web-ui.md](docs/web-ui.md)
- **Queue management**: `PlayerService` exposes `queueNext`, `addToQueue`, `clearQueue`,
  `removeFromQueue`, `moveInQueue`, `toggleShuffle`, `jumpToQueueIndex`; the Now Playing queue adds a
  header toolbar, per-row remove, drag-reorder, a persisted drag-resize handle and history peek.
  → [song-actions.md](docs/song-actions.md), [web-ui.md](docs/web-ui.md)
- **Queue semantics — what a click replaces**: `play()` is the queue-untouched primitive,
  `playSingle()` replaces the queue for a context-less click, `playWithContext()` makes that list the
  queue, `jumpToQueueIndex()` consumes up to the tapped row, `startRadio()` clears it.
  → [web-ui.md](docs/web-ui.md)
- **Now Playing component split + tabbed Queue/Lyrics panel**: the shell composes seven extracted
  sub-components with a `NowPlayingPanelTabsComponent` switcher; the resize handle is shell-owned
  above the tabs, and `lg:` is two columns. → [web-ui.md](docs/web-ui.md)
- **Lyrics (on-demand, plugin-sourced, editable)**: `metadata` plugin kind + `lyrics` capability
  (LRCLIB first), stored in `library_lyrics` + file tag; karaoke panel with synced highlighting,
  fullscreen auto-follow and a server-side `?vocals=off` center-cancel mute (a canceller, not a
  separator). → [design-patterns.md](docs/design-patterns.md),
  [vocal-isolation-spike.md](docs/vocal-isolation-spike.md)
- **Now Playing waveform + karaoke VFX**: rendered from a precomputed artifact.
  → [audio-ml-enrichment.md](docs/audio-ml-enrichment.md)
- **Smart radio (metadata-driven queue)**: `GET /api/radio/next` scores candidates by a
  weight-normalized blend of BPM, Camelot key, genre-set closeness, year, duration, artist diversity,
  the perceptual axes and embedding cosine. `buildSeedRadio`, `scoreSimilarity`, `explainSimilarity`,
  `genreSetCloseness`, `MISSING_GENRE_FLOOR`, `recentPlayPenalty`, `lastPlayedByRecording`.
  → [radio.md](docs/radio.md)
- **One recording is one thing**: two files of one track (album + compilation) are two
  `library_songs` rows, so radio served it twice as often; `recordingKey` collapses them in the
  served window, the pool exclusion and the recency demotion. → [radio.md](docs/radio.md)
- **Filter-seeded radio / stations**: the same route starts a vibe with no seed song from a
  `LibraryFilter` via `buildFilterRadio` + `songFilterWheres` + `seedCentroid`; a genre station is
  graded not tag-tested by `stationAffinity` (`genreDepthScore` × `artistGenreShares`), a demotion
  never an exclusion. → [radio.md](docs/radio.md),
  [radio-stations-2026-08.md](docs/measurements/radio-stations-2026-08.md)
- **Radio calibration + diagnostics**: `RADIO_FORMULA_VERSION` stamps every poll so votes never pool
  across formulas; `dump-radio.ts` reports per-axis breakdowns and the served-window spread;
  `evaluatePollAgreement` replays polls into per-formula AUC. → [radio.md](docs/radio.md)
- **Radio evaluation polls (public, admin-created)**: frozen radio scenarios behind a public
  `/poll/:token` wizard, previewed via short-lived read-only share JWTs, distilled by
  `export-radio-poll.ts`. → [radio-eval-polls.md](docs/radio-eval-polls.md)
- **Remote playback (cast, Spotify-Connect-style)**: per-user `PlaybackStateManager` broadcasts state
  and commands over `GET /api/ws/playback`; each tab is a device, and `heartbeat` re-registers a
  pruned device. → [remote-playback.md](docs/remote-playback.md)
- **Hardware cast (Chromecast + DLNA) — designed, NOT built**: no route, no table, no dependency. Read
  the doc as the proposal it is. → [cast-integration.md](docs/cast-integration.md)
- **Auto-preserve queue (PWA lock-screen resilience)**: `AutoPreserveCoordinator` keeps the next-N
  queued tracks as IndexedDB blobs so playback survives the locked-screen network throttle;
  `evictAutoLRU` never evicts user-saved tracks. → [web-ui.md](docs/web-ui.md)

### Playlists, listening & privacy

- **Native playlists (per-user)**: `playlists`/`playlist_songs` + `PlaylistService`, private per user,
  with sharing and server-side link previews; the detail page adds `SongPickerComponent` and
  token-overlap proposals. → [playlist-generation.md](docs/playlist-generation.md),
  [web-ui.md](docs/web-ui.md)
- **Curated playlists (system, global)**: gradient-covered shelves shown to all users, read-only by
  `kind` rather than ownership. → [curated-playlists.md](docs/curated-playlists.md)
- **Automated playlists**: code-defined `RECIPES` materialized into curated playlists by
  `refreshAutoPlaylists`, with an admin-configurable cadence guarded per period and a
  `runAutoPlaylistsNow` bypass. → [automated-playlists.md](docs/automated-playlists.md)
- **Playlists page (merged single list)**: one list sorted curated-first with an inline badge and
  per-row actions restricted to user rows. → [playlist-generation.md](docs/playlist-generation.md)
- **Likes → auto-maintained "Liked Songs" playlist**: a new `PlaylistKind` value makes the playlist
  itself the store, so no new table; `likeSong`/`unlikeSong`/`likedSongIds` behind a per-user
  `LikeService`. → [song-actions.md](docs/song-actions.md)
- **Listening history (per-user play log)**: append-only `play_events` per playback session; the
  client reports raw facts through `ListeningTrackerService` + a durable `ListeningQueueService`
  outbox, and the **server** owns the counting rule (`countsAsPlay`) so it stays retunable. Endpoints
  take no user id. → [listening-history.md](docs/listening-history.md)
- **Listening stats**: `listeningStats` + `GET /api/history/stats` back the Library Stats tab
  (`LibraryStatsComponent`) — totals, top songs/artists/albums/genres and an hour clock, all derived
  at read time with no rollup table. → [listening-history.md](docs/listening-history.md)
- **Privacy & data protection**: consent is opt-out and resolved by the pure
  `resolveHistoryCollection` (env floor → instance → user), enforced server-side;
  `exportUserData` reads columns from `PRAGMA table_info` at runtime; `deleteUserHistory` is scoped to
  `play_events` and does not flip consent. No admin route reads a user's history by design.
  → [privacy.md](docs/privacy.md)

### Users, auth & access

- **Multi-user + roles**: shared library, per-user settings; ascending ladder
  `listener < user < refiner < admin` shared via core `roles.ts` (`canAcquire`/`canCurate`/`isAdmin`)
  with `requireAcquirer`/`requireCurator`/`requireAdmin` guards. → [roles.md](docs/roles.md)
- **Auth flow**: NicotinD issues its own JWTs (30-day sliding, silent refresh); share tokens are
  short-lived, read-only and non-refreshable. `authGuard` preserves the attempted URL and
  `sanitizeReturnUrl` validates it; an already-logged-in share link resolves in-app without burning
  the public token. → [design-patterns.md](docs/design-patterns.md), [web-ui.md](docs/web-ui.md)
- **Device pairing (QR link) + remote access**: a 5-minute single-use token rendered as a QR link plus
  a printed fallback code; `parseApproveCode` and core `pairing-code.ts` `isPairingCodeShape` keep the
  minter and validator from drifting; `paired_devices` rows are revocable at refresh. Tailscale Funnel
  publishes the loopback backend. → [device-pairing.md](docs/device-pairing.md)
- **MCP agent access**: an external agent curates via `/api/mcp`, authorized by a scoped revocable
  `agent_tokens` bearer capped at refiner (`AGENT_EFFECTIVE_ROLE`), only the hash stored.
  `checkToolAccess` gates curate scope and destructive confirm; `dispatchTool` audits every write.
  `library-deletion.ts`, `artist-identity-mutate.ts` and `song-genre-mutate.ts` back HTTP and MCP.
  → [mcp-agent.md](docs/mcp-agent.md)
- **WebMCP alignment (proposed — not yet implemented)**: `MCP_TOOLS` is already the shape Chrome's
  WebMCP registration takes; the plan promotes host exposure to a declared field and adds a flagged
  browser host owning only session tools. Nothing destructive is ever browser-exposed, and client-side WebGPU/WebNN stays NO-GO.
  → [webmcp-alignment.md](docs/webmcp-alignment.md),
  [client-side-ml-feasibility.md](docs/client-side-ml-feasibility.md)
- **Presence tracking + last connection (admin-only)**: in-memory `PresenceService` from 60s
  heartbeats merged into `GET /api/admin/users` and ordered by `compareUsersByActivity`; the derived
  `last_seen_at` is persisted by `touchLastSeen` because an in-memory map reports "never" after every
  deploy. → [presence-tracking.md](docs/presence-tracking.md)
- **Curation review queue**: a durable "needs a human decision" flag a curator or MCP agent raises
  instead of guessing; `curation_flags`, `createCurationFlag`, `flag_for_review`, one open flag per
  target. → [mcp-agent.md](docs/mcp-agent.md)
- **Admin audit log**: `audit_log` + `recordAudit` called explicitly at destructive mutation sites,
  never as blanket middleware; entries carry `targetKind`/`targetId`/`detail`, and ledger failures
  never break the audited action. → [roles.md](docs/roles.md)
- **OAuth authentication (proposed — not yet implemented)**: Google + Microsoft as `auth` kind plugins
  with an `oauth` capability. → [oauth-auth.md](docs/oauth-auth.md)
- **Onboarding**: setup wizard for self-hosters (music dir, quality, Lidarr) plus a first-login welcome
  banner for admin-provisioned users. → [onboarding.md](docs/onboarding.md)

### Web UI patterns

- **Unified song listings**: one `TrackRowComponent` + one root `SongMenuService.build(song, ctx)`
  builds every `⋯` menu; Remove routes through `ConfirmService` → `deleteSongs` → `deletedSongIds()`;
  multiselect is one `createSelection()` + `SelectionBarComponent` everywhere.
  → [song-actions.md](docs/song-actions.md)
- **Unified search**: `GET /api/search?q=` blends local library and parallel network results into one
  source-agnostic list. → [source-agnostic-acquisition.md](docs/source-agnostic-acquisition.md)
- **Library cross-type find bar**: one box above the Library tabs searching everything you own at once
  (`LibraryFindComponent`); a non-empty query *replaces* the tab content rather than filtering the
  active tab, debounced into `?find=` so it is linkable. → [web-ui.md](docs/web-ui.md)
- **Library "Songs" tab**: `GET /api/library/songs` backs a first-class flat listing with the shared
  filter, `TrackRowComponent` and multi-select; offline it swaps its source to
  `PreserveService.preservedTracks`. → [web-ui.md](docs/web-ui.md)
- **Artist page — tabbed**: Albums | Singles & EPs | Songs, the last lazy and paginated with bulk
  actions including the only view that can remove albumless files.
  → [design-patterns.md](docs/design-patterns.md)
- **Viewport-safe dropdown menus**: `MenuPanelComponent` flips above or clamps into the viewport via
  the pure `computeMenuPosition`, reserving a `bottomInset` from `bottomChromeInset` so it never opens
  under the mini-player. → [design-patterns.md](docs/design-patterns.md)
- **Bottom-chrome stacking + scroll lock**: mini-player and tab bar share one plane;
  `ScrollLockService` pins the document under sheets; `BottomChromeSafeDirective` +
  `measureBottomChromeInset` keep tall modals reachable.
  → [design-patterns.md](docs/design-patterns.md)
- **Page & section idioms**: every routed page inside the shell has a `page-shell` root with a width
  cap, grouped pages share `SettingsGroupComponent`, tables use `section-flush`; `page-shell.spec.ts`
  is the drift guard. → [web-ui.md](docs/web-ui.md)
- **Settings-cards unification**: one bordered collapsible `SettingsGroupComponent` backs every group
  across all five settings-family views, collapsed by default and persisted per device via
  `group-state.ts`; `settings-consistency.spec.ts` is the cross-view gate.
  → [design-patterns.md](docs/design-patterns.md),
  [admin-settings-decoupling.md](docs/admin-settings-decoupling.md)
- **Admin/Settings/Extensions decoupling**: core Settings holds universal prefs only, server-admin
  tools live in Admin, and each addon renders through the generic `PluginCardComponent` +
  `AddonStatusPanelComponent`. → [admin-settings-decoupling.md](docs/admin-settings-decoupling.md),
  [plugins.md](docs/plugins.md)
- **Admin is one panel component per section**: `admin.component.html` is an ordered list of tags,
  so reordering is a one-line move; each panel owns its own `<app-settings-group>` (the `groupId`
  is a localStorage key *and* an e2e selector) and injects `ServiceReviewService` rather than
  taking inputs. `AcquisitionSettingsService` carries the one cross-section signal.
  → [admin-settings-decoupling.md](docs/admin-settings-decoupling.md)
- **ServiceReview (one resource, one polling lifecycle)**: `GET /api/admin/review` replaces the Admin
  page's N loaders; `ServiceReviewService` owns one visibility-paused interval and every sub-section
  is a `computed()` slice. Slices are gathered by name via `allNamed()`, never positionally.
  → [design-patterns.md](docs/design-patterns.md)
- **List loading skeletons**: one shape-matched `SkeletonComponent` replaces the copy-pasted list
  spinner, so a spinner now means only "an action you started is in progress".
  → [web-ui.md](docs/web-ui.md)
- **Pull-to-refresh (touch)**: one layout-hosted gesture on `<main>` (`pull-to-refresh.ts` composing
  `createPointerDrag`) plus a `PullToRefreshService` handler stack pages register into,
  coarse-pointer-gated. → [web-ui.md](docs/web-ui.md)
- **Reactive network / offline detection**: `NetworkStatusService` is one live `online` signal **plus a
  monotonic `reconnects` counter**, because signals coalesce and a fast offline/online pair is
  invisible to a diff of `online`. `isOffline` is a `computed`;
  `reportServerFailure`/`reportServerSuccess` flip it both ways mid-session.
  → [mobile-app.md](docs/mobile-app.md)
- **Manual PWA update check**: a Settings button calling `UpdateService.checkForUpdate()` with
  outcomes surfaced through `ToastService`; `UpdateBannerComponent` remains the install CTA.
  → [web-ui.md](docs/web-ui.md)
- **Changelog modal**: build-time `CHANGELOG.md` → `changelog.json`, capped; the version string in
  header and settings is clickable. → [web-ui.md](docs/web-ui.md)
- **Shared relative time**: one `timeAgo` (`lib/relative-time.ts`) for the Downloads feed and Admin
  users table, with the translator an optional param so the module stays pure.
  → [presence-tracking.md](docs/presence-tracking.md)

### Data integrity, caching & migrations

- **Additive schema migrations**: `applySchema` runs every boot and must be idempotent;
  `addColumnIfMissing` checks `PRAGMA table_info` so "already there" is a condition and a real
  migration bug throws loudly. Additive columns only; no down-migration path by design.
  → [design-patterns.md](docs/design-patterns.md)
- **Schema versioning + atomic migration**: `SCHEMA_VERSION` in SQLite's own `PRAGMA user_version`,
  stamped first inside one `db.transaction()`; `mayCarryLegacyShape` retires the destructive
  legacy-shape steps once stamped. A newer-than-binary stamp warns, never refuses.
  → [design-patterns.md](docs/design-patterns.md)
- **Pre-migration snapshots**: `services/migration-backup.ts` snapshots via `VACUUM INTO` only when
  `user_version` is about to advance, skipping fresh installs via `hasSomethingToLose`, landing
  outside the daily rotation. `migrationBackupHook` is shared because `initDatabase` is not the only
  `applySchema` caller. → [backup-restore.md](docs/backup-restore.md)
- **Daily backups**: `VACUUM INTO` snapshot + secrets into `<dataDir>/backups`, once per day via a
  marker-guarded processor-tick hook, pruned to newest N. Restore is a documented manual swap.
  → [backup-restore.md](docs/backup-restore.md)
- **Config export/import (portable, host migration)**: a JSON bundle of the tables whose rows encode a
  human decision or a credential. Columns *and* primary keys read from `PRAGMA table_info` at runtime;
  secrets redacted by default and skipped on update; import is additive-merge only, dry-run-previewed
  through the apply's own code. → [config-export.md](docs/config-export.md)
- **Orphan side-table pruning**: per-song side tables deliberately have no FK cascade (a rescan
  rebuilds `library_songs` wholesale), so orphans are swept by mark → unmark → sweep on `orphaned_at`
  with a grace period, and only for regenerable tables. `repointOrphanedAcquisitions` runs first.
  → [cache-invalidation.md](docs/cache-invalidation.md)
- **Playlist membership survives a song-id change**: ids are `sha1(path)`, so any move re-mints one;
  `repointPlaylistsBeforePrune` runs *inside* the prune, before the delete, matching on a unique
  (title, artist, duration) and leaving ambiguity to dangle.
  → [cache-invalidation.md](docs/cache-invalidation.md)
- **Cover-cache eviction**: `pruneCoverCache` sweeps entity-keyed files whose row is gone, with the
  same grace period; content-addressed keys have no owning row and are never counted as orphans.
  → [cache-invalidation.md](docs/cache-invalidation.md)
- **Cache-invalidation on library mutations**: every write whose handler mutates artists or genres must
  `invalidateLibraryReads()` on success or the cached grid replays the stale list. The full cross-layer
  sweep and the "adding a cache" checklist are catalogued.
  → [cache-invalidation.md](docs/cache-invalidation.md)
- **Measure prod before building**: `prod-probe.ts` owns read-only prod inspection
  (`--orphans`/`--jobs`/`--transfers`/`--sql`) behind two independent layers — a `{readonly:true}`
  connection and the legible `assertReadOnlySql`, whose ordering is load-bearing. Writes belong on a
  `VACUUM INTO` copy. → [prod-inspection.md](docs/prod-inspection.md)

### Build, CI, deploy & ops

- **Quality gates assert their own denominator**: a gate that computes a smaller candidate set than it
  should still exits 0 truthfully. Gates derive their denominator independently, print what they
  examined, fail on what they cannot classify, and check allowlists both ways.
  → [quality-gates.md](docs/quality-gates.md)
- **`check:route-auth`**: fails when an `/api` group is mounted without `auth` or a reasoned
  `PUBLIC_ROUTES` entry; AST-parsed, not grepped, and it fails when its own count disagrees with the
  file's. → [api-routes.md](docs/api-routes.md)
- **`check:audit` — gated on what *ships***: filters advisories by the production closure (walking
  `bun.lock` from every workspace's `dependencies`) *and* the resolved version, reports the dependency
  path, fails on an unresolvable version, and warns-and-passes on an unreachable registry.
  → [quality-gates.md](docs/quality-gates.md)
- **`check:fetch-timeouts`**: every outbound call is bounded. The gate walks the AST and matches any
  callee that *tokenises* to fetch, catching injected clients a `\bfetch\b` regex misses; signals go
  inline, after any throttle, since a timeout starts counting when constructed.
  → [quality-gates.md](docs/quality-gates.md)
- **Secret + image scanning**: gitleaks runs over every commit (needs full history or the scan
  silently shrinks to one commit) as a pinned binary; Trivy scans the published image scoped to OS
  vulns and unfixed-ignored, as a *step* so blocking the deploy needs no `if:` edit.
  → [quality-gates.md](docs/quality-gates.md)
- **CI boots the shipped artifact**: the docker build is unconditional and loaded, then a smoke step
  waits on the image's own healthcheck and asserts `/api/health` reports the expected version,
  matrixed over both published arches on native runners, never QEMU. The deploy then polls the host
  for that version. → [quality-gates.md](docs/quality-gates.md)
- **Published Docker image**: multi-arch GHCR image published per release tag via native-runner digest
  builds and one manifest merge. The deploy *derives* which images to pull from the resolved compose
  config rather than a hardcoded list. Release tagging is orphan-tag-proof.
  → [deployment.md](docs/deployment.md)
- **The runtime image ships only what it runs**: the production stage installs with `--production`
  from the isolated store; `.dockerignore` excludes tests; `USER bun` needs `/data` pre-created and
  chowned. → [deployment.md](docs/deployment.md)
- **Unsafe shipped defaults, announced before removal**: `findInsecureDefaults`
  (`services/insecure-defaults.ts`) warns at boot, after the ready handshake, never fatally — it checks
  registered addon tokens, not env vars. → [deployment.md](docs/deployment.md)
- **Bounded outbound clients**: `LidarrClient` timeouts come in three tiers (local, lookup, provision)
  because many call sites swallow failures, so one flat budget degrades silently; a timeout is
  re-thrown as "timed out". MusicBrainz uses a discriminated `FetchOutcome` so an outage is never
  cached as a confirmed absence. → [design-patterns.md](docs/design-patterns.md)
- **We build the YouTube PO-token provider**: `ghcr.io/kevinch3/nicotind-pot-provider` built from
  pinned upstream source; the canonical version is published on the artifact as a label, pinned by
  `pot-provider-pin.test.ts`. → [deployment.md](docs/deployment.md)
- **Service modes**: `embedded` (best-effort manage Lidarr) or `external`; the library and streaming
  stack is always in-process. → [design-patterns.md](docs/design-patterns.md)
- **Observability (Sentry, opt-in)**: empty DSN = off; the web SDK loads lazily behind a synchronous
  `error-buffer.ts` + `BufferingErrorHandler` that replays startup errors on connect; the API reports
  only unknown 500s plus aggregated `captureProcessingFailure` events.
  → [observability.md](docs/observability.md)
- **Server update check + version history**: daily cached GitHub-releases poll, marker-guarded and
  scheduled from `main.ts` (never the processor tick, so unit tests cannot hit the network);
  `version_history` records every version booted. → [deployment.md](docs/deployment.md)
- **Dependency management**: `bun outdated --filter '*'` drives manual bumps and CI is the gate; two
  majors are deliberately held by peer constraints. Renovate is configured with majors isolated,
  automerge off, and an unscheduled `vulnerabilityAlerts` block.
  → [dependency-management.md](docs/dependency-management.md)
- **OSS best-practices roadmap**: prioritized adoption plan of Immich/Home-Assistant practices.
  → [oss-best-practices.md](docs/oss-best-practices.md)

## Surfaces

### Web (`@nicotind/web`)

Angular v22 standalone SPA with signals, `HttpClient` + interceptors and lazy routes, built via
`ng build`. Tests run on **plain vitest**, never `ng test`. The HTTP surface is split into per-domain
stateless services under `services/api/` — inject the specific one; there is no monolithic
`ApiService`. **Four type-check surfaces**, none covering the others, all folded into
`bun run typecheck`: `tsc --build`, `typecheck:template` (Angular templates), the e2e specs, and
`typecheck:web-spec`. → [web-ui.md](docs/web-ui.md)

- **i18n**: runtime JSON (`public/i18n/<lang>.json`, `en` the base), `TranslateService` + a `t` pipe
  that is **impure by measurement** (a pure pipe never re-invokes on a language switch), falling
  through active → base → key. Language is per-device. Server error `code` fields map through
  `ERROR_CODE_I18N_KEYS`, but only codes whose message is stable across call sites.
  → [i18n.md](docs/i18n.md)
- **Bundle budget**: `angular.json` carries a budget the project stands behind rather than the
  scaffold default, verified to still fire; CJS bailouts are declared via
  `allowedCommonJsDependencies`. → [web-ui.md](docs/web-ui.md)
- **Storybook component catalog**: shared components storied with theme/TV/viewport globals; stories
  run the **real** services behind an HTTP fixture interceptor. `smoke:storybook` and
  `a11y:storybook:strict` are separate gates from `build:storybook` — compiling a story is not running
  one — and share one traversal. → [storybook.md](docs/storybook.md)

### Mobile (Capacitor Android + iOS)

`packages/mobile` is a thin Capacitor shell around the **same** web build, enabled by a
runtime-configurable API base URL (`ServerConfigService` + `nativeAppCors`). Background audio and
lock-screen controls come from a media-session plugin on Android and an iOS-only Swift plugin.
→ [mobile-app.md](docs/mobile-app.md), [ios-app.md](docs/ios-app.md)

- **Android TV**: the same APK is a leanback launcher app; a `tv` build ships a second APK with a
  10-foot player, roving-tabindex D-pad directives, a `BackHandlerStack`, and
  `@nicotind/capacitor-tv-channels`. The UI is a **route-level fork keyed off `isTvBuild()`, never
  `isTvUi()`** — routes evaluate before the DOM class applies. → [tv-ux.md](docs/tv-ux.md),
  [mobile-app.md](docs/mobile-app.md)

### Desktop (Electron)

`packages/desktop` wraps the **same** backend and web build; Electron supervises the backend as a
local Bun child process via handshake- and health-checked spawn, and the renderer loads
`http://127.0.0.1:<port>` (same-origin, no `file://`). Packaging ships the backend as unbundled source
plus a production install and standalone binaries. Per-platform chrome: native traffic lights on
macOS, an in-app drag region + `DesktopWindowControlsComponent` elsewhere, and hide-to-tray via the
pure `shouldHideOnClose`. → [desktop-app.md](docs/desktop-app.md)

### End-to-end tests

`packages/e2e` boots the real server against a throwaway DB and silent-FLAC fixtures and drives the
SPA in Chromium. Selectors are `data-testid` attributes — **adding one is the standard for new
e2e-targeted elements**. **Before writing a spec, read
[e2e.md](docs/e2e.md) "What the e2e environment does NOT give you"** — the Playwright `request`
fixture is unauthenticated, and no resolve plugin is enabled on a fresh server. The web bundle is
built at config-eval time (`E2E_SKIP_BUILD=1` is the fast path), because serving a stale prebuilt
bundle silently tests the previous code. → [e2e.md](docs/e2e.md),
[testing-routines.md](docs/testing-routines.md)

- **Android TV emulator lane** (`bun run e2e:tv`): a local-only lane driving the real APK on an AVD via
  Playwright's `_android` API. It exists for the one thing Chromium structurally cannot model — a
  WebView has spatial navigation and desktop Chrome does not — plus hardware Back and a WebView-only
  smoke pass. → [e2e-tv-emulator.md](docs/e2e-tv-emulator.md)

### Real-use feedback

[feedback-log-2026-08.md](docs/feedback-log-2026-08.md) is a rolling, dated log of friction noticed
while actually *using* the app, one entry per observation with Severity/Status. Rotate monthly.

## Configuration

Loaded from `config/default.yml`, overridden by environment variables. See `.env.example` for all
options and [configuration.md](docs/configuration.md) for the reference table. Key vars:
`NICOTIND_MODE`, `NICOTIND_MUSIC_DIR`, `NICOTIND_DATA_DIR`. Source credentials live on their addon
containers, not here.
