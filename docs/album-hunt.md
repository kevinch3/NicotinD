# Album Hunt, Catalog Search & Deduplication

## Catalog (metadata-driven) search

`CatalogService` (`packages/api/src/services/catalog-search.service.ts`, routes at `/api/catalog`) looks the query up against Lidarr/MusicBrainz (`artist.lookup`/`album.lookup`) and returns structured artist/album cards. Selecting an album calls `POST /api/catalog/resolve`, which **adds the artist to Lidarr on demand** (via the shared `addArtistFromLookup` helper in `lidarr-provision.ts`, also used by discography) to obtain the canonical tracklist, then reuses the existing album-hunt flow (`/api/discography/albums/:id/hunt`) unchanged.

Raw slskd file search (`/api/search`) remains as an **always-visible fallback** section below the metadata cards, and is the only path when Lidarr is unconfigured (the `/api/catalog` route isn't mounted; the web search view degrades gracefully).

Trade-off accepted: every hunted album becomes a monitored Lidarr artist — consistent with the pre-existing discography behavior.

**Junk suppression + discography-on-demand (§A6).** The global `album.lookup` ranks mashups/tributes/wiki entities above a non-distinctive artist's real discography (e.g. "Zara Larsson" → zero of her studio albums). So `search()` scopes the cards to the matched artist; and when the query **exact-matches an artist but none of *their* albums appear**, it returns **0 cards** + `discographyUnavailable`/`scopedArtist` (never the junk, which all `404` on resolve). The web then suppresses the grid, auto-opens the network lane, and offers a **"Load &lt;artist&gt;'s discography"** button → `POST /api/catalog/discography` → `loadDiscography()` **adds the artist to Lidarr on demand** and lists their real, hunt-able releases (ranked Album > EP > Single). User-initiated only, so plain search stays read-only.

**Raw fallback for compilations not in Lidarr.** A best-of/compilation card from the *global* `album.lookup` (e.g. "The Best of Shaggy", "Grandes éxitos", "Trueno: Bzrp Freestyle Sessions, Vol. 6") often isn't in the artist's Lidarr discography even after the artist is added, so `resolveAlbum` throws the typed `404 ALBUM_NOT_IN_LIDARR`. The resolve route echoes the `code` in its body; the web's `huntCatalogAlbum` reads it via `httpErrorCode()` and **auto-falls back to a raw Soulseek search** for `"<artist> <album>"` (`rawHuntFallback` → `executeSearch({ forceDirectOpen: true })`), opening the network lane with downloadable folder candidates and a `data-testid="raw-fallback-note"` banner explaining the switch — instead of dead-ending on the error. (A true ranked album-hunt needs a canonical tracklist for folder scoring, which a non-Lidarr release lacks, so the raw network search is the right fallback here.)

---

## Album hunt — soft-ban bypass ("skew search")

`AlbumHunterService.hunt` (`packages/api/src/services/album-hunter.service.ts`) normally fires `Artist Album` / `Artist - Album` against slskd. slskd/Soulseek silently returns **zero** responses for some exact phrases (a server-side soft ban) even when the files exist.

When `skewSearch` is set on the `POST .../hunt` body (the album-hunt modal's "Skew search" checkbox, **on by default**) **and** no base candidate is confidently complete (best `matchPct < SKEW_TRIGGER_PCT`, ~67%), `hunt` also runs textually-skewed variants from the exported pure `buildSkewedQueries`:

- Reorder artist/album
- Album-only
- Drop leading "the"
- Artist + first album word
- **Artist-name truncation** — drop the last character (e.g. `"Bahiano"` → `"Bahian"`), bypasses per-name phrase bans common for Spanish/Portuguese artists
- Qualifier-stripped variants (`stripTitleQualifiers` removes `(feat …)`/`(Remix)`/bracketed suffixes) — mainly for singles whose Lidarr title carries a suffix the peer's filename omits

De-duped and never re-running a base query. Results merged via `mergeCandidates` (de-duped by `username::directory`, higher score wins). A confidently-complete base adds zero extra searches.

**Singles (1 canonical track)** aren't scored all-or-nothing: `singleMatchStrength` returns 100 when full normalized titles overlap, `SINGLE_PARTIAL_PCT` (50) when only qualifier-stripped cores overlap — so a peer that drops a `(feat …)` suffix still surfaces. EPs (2–6 tracks) keep the proportional formula.

The `LibraryCurator` won't auto-hide a deliberately-hunted release (its normalized artist+title matches an `album_jobs` row), so a thin hunted single/EP can't vanish from the grid.

**Matching is diacritic-insensitive**: `normalizeTitle` NFD-decomposes then strips combining marks (`"canción"` → `"cancion"`) so accented Latin-American titles match peers' unaccented spellings — used by both hunt scoring and the fallback. `HUNT_TIMEOUT_MS` is 45s.

**Two-phase hunt for live progress**: the hunt modal uses two separate requests — `POST .../hunt/base` (base queries only, returns `{ candidates, skewNeeded }`) followed by `POST .../hunt/skew` (skew queries only, if needed) — so the UI can highlight each query row in real time (idle → searching → done/skipped). The single-shot `POST .../hunt` endpoint is preserved for watchlist/catalog callers.

**Transparency**: the album-hunt modal's loading screen lists the exact query strings it fires via the web helper `lib/hunt-queries.ts`, which **mirrors** `buildSkewedQueries`/`stripTitleQualifiers` (the web bundle can't import the server module — it pulls in pino/node deps). The two are kept in sync by matching unit tests on both sides.

---

## Per-track fallback — when no whole-album folder exists (§C1/§F2)

The hunt works at **folder** granularity and dead-ends ("No candidates") when an album exists only as loose tracks scattered across peers (a real case: a 14-track album whose tracks are all on compilations/singles, no single matching folder). Instead of a pure dead-end, the modal's no-results state offers **"Grab individual tracks instead"** (`data-testid="hunt-tracks"`).

It calls `POST /api/discography/albums/:id/hunt-tracks` (auth + acquisition gated like the album hunt), which resolves the canonical tracklist from Lidarr and runs `TrackHunterService` (`services/track-hunter.service.ts`): one slskd search per title, the **healthiest *cleanest*** file chosen by the shared pure `pickBestTrackFile` (`services/track-pick.ts`) — fewest extra words beyond the title wins, so it grabs "Bohemian Rhapsody" not the "(5.1 mix)" a healthy FLAC peer would otherwise win on; FLAC + peer health only break ties among equally-clean files. Picks are grouped per peer and enqueued; the modal reports "Enqueued N of M tracks individually" (+ misses). `pickBestTrackFile` is the testable core extracted for reuse (the cross-peer `AlbumFallbackService` keeps its own copy to avoid churning battle-tested recovery code).

---

## archive.org — a second source in the hunt + search

Albums missing from Soulseek are often freely available on archive.org, so the `archive` plugin (see [docs/plugins.md](plugins.md)) doubles as a **second searchable source** without touching the slskd-coupled hunt engine. A read-only metadata lane — `ArchiveSearchService` over `advancedsearch.php`, exposed at `GET /api/archive/search` (`?q=` free text, or `?artist=&album=`) — returns `ArchiveCandidate[]` (`{ identifier, title, creator, year, detailsUrl }`). The route is **mounted unconditionally** (no Lidarr/slskd dependency) and gated specifically on `plugins.isEnabled('archive')` (`503` when off), so archive.org works as a fallback even with Soulseek disabled.

The web surfaces it in **two places**, both gated on `PluginService.hasArchive` and both downloading by handing the candidate's `detailsUrl` to `POST /api/acquire` (the `archive` resolve plugin then stages + ingests it — the job tracks in Downloads → Active, _not_ through `album_jobs`/cross-peer fallback):

- **Album-hunt modal** — an "Also on archive.org" section searched in parallel with the Soulseek hunt (`searchArchive` fires from `ngOnInit`, never blocking the slskd lane); each item has a one-click "Get from archive.org".
- **Unified search page** — a "From archive.org" section below the network divider, populated by `executeSearch` firing `searchArchive(query)` alongside the catalog + network lanes.

---

## Album hunt — cross-peer fallback (duplication fix)

`AlbumFallbackService` (`packages/api/src/services/album-fallback.service.ts`) recovers tracks the chosen folder _promised but the peer failed to deliver_. Recovery target is the **primary folder's own file manifest** (`target_files_json`, the files the user selected at `hunt-download` time) — **not** the canonical Lidarr tracklist.

Why: Lidarr often returns a bloated deluxe/special-edition tracklist (e.g. "Circus" = 24 tracks incl. live/acoustic/bonus cuts) that no single Soulseek folder contains, so a canonical-targeted `missing` set is _permanently_ non-empty — the fallback then exhausts all attempts dumping near-complete duplicate rips into one `<Artist>/<Album>` folder. Targeting the manifest means a folder that downloads in full is `done` immediately; genuinely-failed primary tracks are still recovered from alternates. Legacy jobs without a stored manifest fall back to canonical titles (`parseTargets`).

**Fresh per-track recovery**: when recorded alternates (a hunt-time snapshot — often offline by the time the primary fails) can't cover a missing track, `sweep` fires a _live_ slskd search per still-missing track (`"<artist> <track>"`, using the `artist_name` column captured at `hunt-download`) and enqueues the healthiest matching file from any peer. Tracks already in flight from a prior wave are skipped. Each wave counts against `fallbackMaxAttempts` (config `downloads.fallbackMaxAttempts`, default 5).

The incomplete-album surface lists these jobs via `GET /api/discography/jobs?state=exhausted|active|incomplete|all` (joined to `album_title`/`artist_name`).

---

## Auto-retry of exhausted hunts (disk-aware revival)

`AlbumFallbackService.reviveExhausted` (gated by config `downloads.autoRetryExhausted`, default on) periodically flips long-`exhausted` jobs back to `active` so the next `sweep` gives them a fresh `fallbackMaxAttempts` budget — peers offline at hunt time often reappear.

Bounded by `downloads.exhaustedMaxRevives` (default 5) and `downloads.exhaustedRetryCooldownMs` (default 1h, tracked via `album_jobs.revive_count`/`last_revived_at`); legacy jobs without an `artist_name` are skipped.

The sweep is **disk-aware**: a job's `missing` set treats a track as satisfied if it's already in the library on disk (`library_songs` keyed by `albumIdFor(artist_name, album_title)`), not only if slskd's transient `getDownloads` still lists it — without this, a revived old job (whose original transfers are long gone from slskd) would re-download the whole album.

Runs off the existing `DownloadRetryService` tick (`onSweep` hook in `index.ts`), so no new scheduler.

---

## Watchlist auto-hunt

`WatchlistService` (`packages/api/src/services/watchlist.service.ts`, routes `/api/watchlist`, table `watchlist`) lets a user star a catalog album (star overlay on search album cards). A poller (config `watchlist.*` — `enabled`/`intervalMs` default 30 min/`minMatchPct` default 80) hunts each `watching` row and, when a candidate clears the unattended confidence floor, downloads it through the **same primitives the interactive hunt uses** (`AlbumHunterService.hunt` → `slskd.transfers.enqueue` → `AlbumFallbackService.recordJob`), then flips the row to `acquired`.

Idempotent: an album already on disk (`albumAlreadyComplete`, shared in `library-completeness.ts`) or with an active `album_jobs` row resolves without a second download. Resolving a watched album adds its artist to Lidarr as monitored. Only mounted when Lidarr + slskd are configured.

---

## Idempotent hunt — one album = one download = one folder

`POST /api/discography/albums/:id/hunt-download` (`packages/api/src/routes/discography.ts`) guards against duplicate downloads:

1. Returns **409 `already-downloading`** if an `album_jobs` row for that `lidarr_album_id` is still `state='active'`.
2. Returns **409 `already-complete`** if the library already holds the album — `albumAlreadyComplete` matches by `normalizeForGrouping(artist)+title` with `song_count >= canonical track count`.
3. On `?replace=true` (admin re-hunt) marks the prior active job `'superseded'` first, so at most one active job per album.
4. **Complete-only / disk-aware enqueue**: `filesMissingOnDisk` (`library-completeness.ts`) filters the chosen folder's files to only those whose track isn't already in `library_songs` (keyed on `albumIdFor`, matched via `normalizeTitle`/`titlesOverlap`). `hunt-download` enqueues **only the missing tracks**, returning `{ queued: 0, alreadyComplete: true }` when nothing is missing. A fresh hunt still downloads everything. The watchlist auto-hunt applies the same filter.

**Web — "already have it" is a positive notice, not a failure.** `AlbumHuntModalComponent.downloadSelected` classifies the result/error through the pure, DI-free `lib/hunt-download-outcome.ts`: `classifyHuntDownloadResult` maps a `200 {queued:0, alreadyComplete:true}` (and a `queued:0`) to a green **"✓ You already have this album"** panel (`data-testid="hunt-already-complete"`) instead of the old silent `close()` that looked like a download had started; `classifyHuntDownloadError` maps the **409 `already-complete`** to that same panel and the **409 `already-downloading`** to a neutral "already downloading — check Downloads" panel (`data-testid="hunt-already-downloading"`), each with a single **Done** button. Both replace the prior red error state for these codes, which read like the *chosen source* had failed and nudged a needless retry from another source. Only a genuine failure (502 offline peer, hunt error) keeps the red error state.

**Canonical folder placement**: `LibraryOrganizer` takes a `jobLookup(peerDirectory)` (wired in `download-watcher.ts` to query `album_jobs` by `directory`) so hunted album files are placed under the **Lidarr canonical album title**, not the peer's edition tag. The lookup first tries an exact directory match (the primary peer), then a **fuzzy normalized match** against active jobs (last two path segments as artist/album): covers fallback/alternate peer files whose directories differ from the primary but map to the same album via `normalizeForGrouping`.

The fresh-search fallback (`album-fallback.service.ts` `searchBestForTrack`) prefers the **cleanest** title match (fewest extra tokens beyond the canonical title) over health/FLAC, so recovery never pulls a `(5.1 mix)`/`(New Mix)` in place of the studio track.

**Repair script**: `scripts/repair-album-folders.ts` (dry-run default, `--apply`) groups `<Artist>/<Album*>` folders by `albumGroupKey`, merges each group into the fullest folder, and trims to one file per track — keeping the cleanest best file per **canonical** track (from `album_jobs.canonical_tracks_json`) and dropping deluxe/5.1/remix extras.
