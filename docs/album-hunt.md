# Album Hunt, Catalog Search & Deduplication

## Catalog (metadata-driven) search

`CatalogService` (`packages/api/src/services/catalog-search.service.ts`, routes at `/api/catalog`) looks the query up against Lidarr/MusicBrainz (`artist.lookup`/`album.lookup`) and returns structured artist/album cards. Selecting an album calls `POST /api/catalog/resolve`, which **adds the artist to Lidarr on demand** (via the shared `addArtistFromLookup` helper in `lidarr-provision.ts`, also used by discography) to obtain the canonical tracklist, then reuses the existing album-hunt flow (`/api/discography/albums/:id/hunt`) unchanged.

Raw slskd file search (`/api/search`) remains as an **always-visible fallback** section below the metadata cards, and is the only path when Lidarr is unconfigured (the `/api/catalog` route isn't mounted; the web search view degrades gracefully).

Trade-off accepted: every hunted album becomes a monitored Lidarr artist — consistent with the pre-existing discography behavior.

**Junk suppression + discography-on-demand (§A6).** The global `album.lookup` ranks mashups/tributes/wiki entities above a non-distinctive artist's real discography (e.g. "Zara Larsson" → zero of her studio albums). So `search()` scopes the cards to the matched artist; and when the query **exact-matches an artist but none of *their* albums appear**, it returns **0 cards** + `discographyUnavailable`/`scopedArtist` (never the junk, which all `404` on resolve). The web then suppresses the grid, auto-opens the network lane, and offers a **"Load &lt;artist&gt;'s discography"** button → `POST /api/catalog/discography` → `loadDiscography()` **adds the artist to Lidarr on demand** and lists their real, hunt-able releases (ranked Album > EP > Single). User-initiated only, so plain search stays read-only.

**Raw fallback for compilations not in Lidarr.** A best-of/compilation card from the *global* `album.lookup` (e.g. "The Best of Shaggy", "Grandes éxitos", "Trueno: Bzrp Freestyle Sessions, Vol. 6") often isn't in the artist's Lidarr discography even after the artist is added, so `resolveAlbum` throws the typed `404 ALBUM_NOT_IN_LIDARR`. The resolve route echoes the `code` in its body; the web's `huntCatalogAlbum` reads it via `httpErrorCode()` and **falls back to a raw Soulseek search** for `"<artist> <album>"` (`rawHuntFallback` → `executeSearch({ forceDirectOpen: true })`), opening the network lane with downloadable folder candidates and a `data-testid="raw-fallback-note"` banner explaining the switch — instead of dead-ending on the error. (A true ranked album-hunt needs a canonical tracklist for folder scoring, which a non-Lidarr release lacks, so the raw network search is the right fallback here.)

**Catalog-miss flow made intuitive (2026-07).** The fallback used to *also* auto-load the artist's full discography (a silent Lidarr artist-add) and framed the banner as a bare "showing network results and their full discography below" notice with no obvious next action — the user who clicked "Muscle Museum" got a failure message + a giant discography grid instead of the album they wanted. Two changes: (1) the fallback query is **album-intent multi-word**, so `pickNetworkView` **defaults the raw lane to the Folders view** — a folder is a whole-album grab, exactly the "get this album" unit, each with a `downloadFolder` CTA (the flat blended song list, which could run to hundreds of near-duplicate rows, is capped by `visibleBlendedResults`/`RESULTS_CAP` with a "Show all N" escape). (2) Loading the full discography is now **opt-in** — the banner carries a `data-testid="raw-fallback-discography"` "Browse &lt;artist&gt;'s discography" button (`browseFallbackDiscography` → the same `doLoadDiscography` §A6 path) instead of firing automatically, so the surprise Lidarr mutation + noise only happens when the user asks. `rawFallbackAlbum` holds the clicked album so the banner can offer that CTA; it's cleared in `resetResultSurfaces` like the note.

**Compilations demoted in `rankAlbums` (2026-07).** Reproduced live against prod (search "Cyndi Lauper Time After Time" / "Deep Purple"): `album.lookup`'s free-text relevance ranking surfaces "Best Of"/"Very Best Of" reissues *extremely* well (6-7 of the top 8-10 hits for a well-known artist), while Lidarr's own `listByArtist` discography carried **zero** compilations for either artist. Since the raw-fallback path above only triggers on click, and the top-ranked card is the one a user naturally clicks first, this meant the guided card flow dead-ended into the raw-fallback banner on almost every search for a well-known artist/song — not just the genuinely-absent-compilation edge case the fallback was designed for. `rankAlbums()` now sorts non-compilation releases (by `secondaryTypes`) ahead of compilations, before the existing Album > EP > Single > newest-first tiebreakers, so the default, most-clickable cards are the ones that actually resolve. Compilations aren't hidden — they still render, just lower in the grid, and still correctly raw-fallback when chosen. See `catalog-search.service.test.ts` for a fixture mirroring the real Deep Purple lookup order.

---

## Album hunt — soft-ban bypass ("skew search")

`AlbumHunterService.hunt` (`packages/api/src/services/album-hunter.service.ts`) normally fires `Artist Album` / `Artist - Album` against slskd. slskd/Soulseek silently returns **zero** responses for some exact phrases (a server-side soft ban) even when the files exist.

When `skewSearch` is set on the `POST .../hunt` body (the album-hunt modal's "Skew search" checkbox, **on by default**) **and** no base candidate is confidently complete (best `matchPct < SKEW_TRIGGER_PCT`, ~67%), `hunt` also runs textually-skewed variants from `buildSkewedQueries` (now in **`@nicotind/core` `hunt-queries.ts`**, the single source shared with the web). The goal is a *faithful* set: each variant is a different **literal string for the same release**, so it dodges slskd's exact-phrase soft ban / cache **and** stays precise (unlike a fuzzy match). Because slskd matches the search text against peer filenames, literal variation also **improves recall** against peers who share files with unaccented / differently-punctuated names — the outgoing query, not just the scorer, now folds. Variants (ranked most-precise first):

- **Accent-folded** — `fold("<artist> <album>")` (`"Beyoncé Lemonade"` → `"beyonce lemonade"`); reaches unaccented shares + a distinct cache key. Dropped when the input is already plain ASCII.
- **Punctuation-stripped** — `"AC/DC Back in Black"` → `"AC DC Back in Black"`, `&`→"and", apostrophes vanish.
- **Reorder** artist/album.
- **Distinctive tokens** — drop filler words (the/of/and/de/la…), keep the identifying ones (`"Pink Floyd The Dark Side of the Moon"` → `"Pink Floyd Dark Side Moon"`); replaces the old too-generic "first album word".
- Qualifier-stripped (`stripTitleQualifiers` removes `(feat …)`/`(Remix)`/bracketed suffixes — for singles), artist+core / core-only, album-only (broad), drop-leading-"the".

The old **artist-name last-char truncation** (`"Bahiano"` → `"Bahian"`) is **removed** — it was imprecise (a partial-token query returns junk); the fold/punctuation/reorder/distinctive variants already vary the literal phrase enough to bypass the ban while staying faithful. De-duped and never re-running a base query. Results merged via `mergeCandidates` (de-duped by `username::directory`, higher score wins). A confidently-complete base adds zero extra searches. The per-track hunt (`buildTrackQueries`, also in core, used by `TrackHunterService`) applies the same primitives.

**Singles (1 canonical track)** aren't scored all-or-nothing: `singleMatchStrength` returns 100 when full normalized titles overlap, `SINGLE_PARTIAL_PCT` (50) when only qualifier-stripped cores overlap — so a peer that drops a `(feat …)` suffix still surfaces. EPs (2–6 tracks) keep the proportional formula.

The `LibraryCurator` won't auto-hide a deliberately-hunted release (its normalized artist+title matches an `album_jobs` row), so a thin hunted single/EP can't vanish from the grid.

**Matching is diacritic-insensitive**: `normalizeTitle` NFD-decomposes then strips combining marks (`"canción"` → `"cancion"`) so accented Latin-American titles match peers' unaccented spellings — used by both hunt scoring and the fallback. `HUNT_TIMEOUT_MS` is 45s.

**Two-phase hunt for live progress**: the hunt modal uses two separate requests — `POST .../hunt/base` (base queries only, returns `{ candidates, skewNeeded }`) followed by `POST .../hunt/skew` (skew queries only, if needed) — so the UI can highlight each query row in real time (idle → searching → done/skipped). The single-shot `POST .../hunt` endpoint is preserved for watchlist/catalog callers.

**Transparency**: the album-hunt modal's loading screen lists the exact query strings it fires via the web helper `lib/hunt-queries.ts`, which now **re-exports** `baseQueries`/`skewedQueries`/`stripTitleQualifiers` from **`@nicotind/core`** — one shared source, not a hand-synced copy (the pure `hunt-queries.ts` module carries no pino/node deps, so the web bundle can import it; it's surfaced through the browser-safe `web/src/types/core.ts` shim like the roles ladder). The old two-copy sync risk is gone.

---

## Per-track fallback — when no whole-album folder exists (§C1/§F2)

The hunt works at **folder** granularity and dead-ends ("No candidates") when an album exists only as loose tracks scattered across peers (a real case: a 14-track album whose tracks are all on compilations/singles, no single matching folder). Instead of a pure dead-end, the modal's no-results state offers **"Grab individual tracks instead"** (`data-testid="hunt-tracks"`).

It calls `POST /api/discography/albums/:id/hunt-tracks` (auth + acquisition gated like the album hunt), which resolves the canonical tracklist from Lidarr and runs `TrackHunterService` (`services/track-hunter.service.ts`): the **healthiest *cleanest*** file chosen by the shared pure `pickBestTrackFile` (`services/track-pick.ts`) — fewest extra words beyond the title wins, so it grabs "Bohemian Rhapsody" not the "(5.1 mix)" a healthy FLAC peer would otherwise win on; FLAC + peer health only break ties among equally-clean files. Picks are grouped per peer and enqueued; the modal reports "Enqueued N of M tracks individually" and **lists the still-missing titles** (`data-testid="track-hunt-misses"`) so the user can act. `pickBestTrackFile` is the testable core extracted for reuse (the cross-peer `AlbumFallbackService` keeps its own copy to avoid churning battle-tested recovery code).

**Skew + qualifier-aware per track (don't lose 13 of 14).** A lone `"<artist> <title>"` search is silently soft-banned for many phrases — the *same* server-side ban the album-hunt skew-search bypasses — so a single query loses most tracks (a real case: album hunt found no folder, per-track fallback then enqueued only 1 of 14). `huntTrack` therefore runs the pure, ordered `buildTrackQueries(artist, title)` (`track-pick.ts`) — exact phrase, **title-only**, **artist-name truncation** (drop the last char, the documented Spanish/Portuguese per-name ban bypass), and **qualifier-stripped title** (`stripTitleQualifiers`) — stopping at the first variant that yields a pick (a confident first hit fires no extra searches, mirroring the album hunter's budget discipline). Matching is also qualifier-aware: `pickBestTrackFile` falls back from the full normalized title to `stripTitleQualifiers`'s core, so a peer that omits a `(feat …)`/`(Remasterizado)` suffix still matches (the core is `null` for already-bare titles, so matching never loosens spuriously).

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
4. **Complete-only / disk-aware enqueue**: `filesMissingOnDisk` (`library-completeness.ts`) filters the chosen folder's files to only those whose track isn't already in `library_songs` (matched via `normalizeTitle`/`titlesOverlap`). `hunt-download` enqueues **only the missing tracks**, returning `{ queued: 0, alreadyComplete: true }` when nothing is missing. A fresh hunt still downloads everything. The watchlist auto-hunt applies the same filter.

   **why it must not be keyed on an exact `albumIdFor`** (the duplicate-versions root cause): `hunt-download` runs with the **canonical Lidarr** artist/title, but the partial album already on disk is tagged with the **peer's** artist/title (accents, `feat.`, edition words, artist spelling — routine in this Latin-American-heavy library). Keying the on-disk lookup on `albumIdFor(canonicalArtist, canonicalTitle)` then finds **nothing**, so the *whole* folder re-downloads on top of what we have — and any rip whose filename differs slightly escapes the post-organize dedupe and lands as a second copy. So the filter resolves on-disk tracks two ways: the artist page sends the already-resolved **`localAlbumId`** (precise, divergence-proof), and absent that (catalog/watchlist, which only have canonical names) it unions the exact minted id with **every** local album whose `artist_id` + `normalizeForGrouping(title)` match (so an edition/divergent-id row still counts). `albumAlreadyComplete` (guard 2) uses the same `artist_id`-based identity match.

**Web — "already have it" is a positive notice, not a failure.** `AlbumHuntModalComponent.downloadSelected` classifies the result/error through the pure, DI-free `lib/hunt-download-outcome.ts`: `classifyHuntDownloadResult` maps a `200 {queued:0, alreadyComplete:true}` (and a `queued:0`) to a green **"✓ You already have this album"** panel (`data-testid="hunt-already-complete"`) instead of the old silent `close()` that looked like a download had started; `classifyHuntDownloadError` maps the **409 `already-complete`** to that same panel and the **409 `already-downloading`** to a neutral "already downloading — check Downloads" panel (`data-testid="hunt-already-downloading"`), each with a single **Done** button. Both replace the prior red error state for these codes, which read like the *chosen source* had failed and nudged a needless retry from another source. Only a genuine failure (502 offline peer, hunt error) keeps the red error state.

**Canonical identity persisted at download time**: alongside the canonical-artwork write, `hunt-download` and the shared unattended `acquireAlbum` core (watchlist + auto-acquire) call `recordAcquiredArtistIdentity` (`artist-identity-store.ts`) — a `library_artist_identity` `single`/`lidarr` row plus the artist's MBID in `artist_discography_links` — so the scan that lands the download already knows the canonical artist (see [library-scanner.md](library-scanner.md), acquisition→library cohesion). Best-effort, never blocks the download.

**Canonical folder placement**: `LibraryOrganizer` takes a `jobLookup(peerDirectory)` (wired in `download-watcher.ts` to query `album_jobs` by `directory`) so hunted album files are placed under the **Lidarr canonical album title**, not the peer's edition tag. The lookup first tries an exact directory match (the primary peer), then a **fuzzy normalized match** against active jobs (last two path segments as artist/album): covers fallback/alternate peer files whose directories differ from the primary but map to the same album via `normalizeForGrouping`.

The fresh-search fallback (`album-fallback.service.ts` `searchBestForTrack`) prefers the **cleanest** title match (fewest extra tokens beyond the canonical title) over health/FLAC, so recovery never pulls a `(5.1 mix)`/`(New Mix)` in place of the studio track.

**Repair script**: `scripts/repair-album-folders.ts` (dry-run default, `--apply`) groups `<Artist>/<Album*>` folders by `albumGroupKey`, merges each group into the fullest folder, and trims to one file per track — keeping the cleanest best file per **canonical** track (from `album_jobs.canonical_tracks_json`) and dropping deluxe/5.1/remix extras.

---

## Deferred: unify the hunt engines

The fixes above are targeted; the underlying structure still has avoidable duplication worth folding
later (captured here so it's discoverable, not lost):

1. **One track-search primitive.** `TrackHunterService` and `AlbumFallbackService.searchBestForTrack`
   are two divergent per-track searchers. Fold both onto the shared skewed `buildTrackQueries` +
   `pickBestTrackFile` (`track-pick.ts`) so user-facing per-track hunts and cross-peer recovery can
   never drift in quality again.
2. **One album-identity resolver.** The duplicate-versions bug is normalizer drift: the discography
   diff matches a local album with `normalizeTitle`, while the completeness filter matches with
   `normalizeForGrouping`/`albumIdFor`. Extract a single `resolveLocalAlbum(db, artist, title) →
   { albumId, songs }` used by the discography diff, the completeness filter, and the watchlist, so
   "is this the same album we have?" has exactly one answer (the threaded `localAlbumId` is the
   interim bridge).
3. **Auto-retry the per-track misses.** Register still-missing per-track hunts with the existing
   `AlbumFallbackService.reviveExhausted` sweep so offline peers get retried automatically.
4. Longer term: a single source-pluggable acquisition engine (folder + per-track + archive) behind
   one matching/identity layer.
