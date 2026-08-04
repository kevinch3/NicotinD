# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

It is an **index**, kept deliberately small because it loads into every request. The full detail
behind each pattern below lives in `docs/` (loaded only when relevant) — primarily
[docs/design-patterns.md](docs/design-patterns.md) plus the per-feature `docs/<feature>.md` files
linked from each entry.

## Quality Gates

Every task on this project must satisfy all three gates before being considered done:

1. **Every change must be tested.** New features get new tests. Bug fixes get regression tests.
   Refactors must not reduce coverage. If a change can't reasonably be unit-tested, add an
   integration or e2e test instead — untested code is not shippable.

2. **Every test must run in CI.** Adding a test locally is not enough. Verify the relevant GitHub
   Actions workflow actually executes the new test on push. If a new test file or package is added,
   confirm it's picked up by `.github/workflows/`. Don't close out a task until CI covers the new
   test. **Before declaring a feature ready, also run `bun run e2e` (or the targeted
   `tests/<surface>.spec.ts`) locally** — any UI change that adds/removes a `data-testid`, changes a
   popover trigger, or alters a route's DOM surface can break e2e selectors, and a green CI run from
   a previous commit isn't proof the new code didn't regress them. Pre-existing flakes are allowed
   (note them), but anything you caused is a blocker.

3. **Documentation must be updated in the same change as the code.** This is not optional and not a
   follow-up task: **every time you add or modify behavior, update the docs in the same commit/PR.**
   Significant decisions — new patterns, new services, why an approach was chosen over alternatives,
   trade-offs accepted — must be captured. If a change makes an existing doc statement wrong, fix
   that statement; stale docs are treated as a bug. **This gate is partly enforced now**: CI runs
   `bun run check:claude-md`, which fails if this file names a code symbol that exists nowhere in
   the repo, or links to a `docs/*.md` that doesn't exist — renames are the main source of drift,
   and this file is read as ground truth on every request (issue #255). **Where docs live (CLAUDE.md
   is an index, not
   the detail store):**
   - **The detail goes in `docs/`** — either the relevant existing `docs/<feature>.md`, or
     [docs/design-patterns.md](docs/design-patterns.md) for patterns without a dedicated file. Write
     the full rationale/implementation notes there, not inline in this file. These files are _not_
     loaded into every request, so detail here is cheap.
   - **Update the one-line index entry in `CLAUDE.md`** (under Key Design Patterns or the relevant
     section) so the new/changed behavior is discoverable, and **point it at the doc** holding the
     detail. A reader should never have to discover a `docs/` file by accident; this file should
     never grow a dense multi-sentence bullet again.
   - **A concise `// why` comment in code** for local rationale that belongs next to the
     implementation.

   A change is not "done" (gate-complete) until its documentation reflects reality.

## What is NicotinD?

NicotinD is a unified music acquisition + streaming platform that orchestrates **slskd** (Soulseek
P2P client) behind a single API, web UI, and CLI, and **natively scans/streams** the music library
itself (Navidrome was removed — see Architecture). Downloads from Soulseek land in a shared folder;
the DownloadWatcher organizes and incrementally scans completed transfers into the canonical SQLite
library that the API streams from. URL-based acquisition (yt-dlp / spotdl) feeds the same pipeline.

## Commands

```bash
bun install              # Install all workspace dependencies
bun run typecheck        # TypeScript type checking (tsc --build + Angular template check)
bun run lint             # ESLint across all packages
bun run check:claude-md  # fail on CLAUDE.md symbols that don't exist / broken docs links (CI gate)
bun run check:shipped-issues # open issues a shipped commit referenced (report, not a gate)
bun run check:json       # duplicate keys in JSON configs (JSON.parse keeps the last silently)
bun run check:shared-helpers # a shared helper re-implemented locally instead of imported (CI gate)
bun run check:isolated-specs # find specs that only pass inside the full suite (slow; not a CI gate)
bun run format           # Prettier — safe to run repo-wide (see docs/design-patterns.md)
bun run format:check     # CI gate: fails on any unformatted file
bun run test             # Vitest across packages/ + src/ (excludes web/, e2e/, desktop/test/)
bun run test:web         # Angular component tests (vitest — see docs/web-ui.md "Web test harness")
bun run typecheck:web-spec # Type-check the web specs (vitest does NOT type-check them)
bun run --filter @nicotind/web typecheck:template # Angular templates alone (folded into typecheck)
bun run e2e              # Playwright e2e suite (packages/e2e) — always run before declaring a feature done
bun run packages/api/src/scripts/prod-probe.ts --orphans --jobs  # read-only prod/dev DB probe → docs/prod-inspection.md
                         # (builds @nicotind/web first; E2E_SKIP_BUILD=1 to reuse the existing dist)
bun run src/main.ts      # Start NicotinD (requires .env or config/default.yml)
bun run release          # Bump version (auto-detected), generate CHANGELOG, tag
bun run release:minor    # Force a minor version bump
bun run release:major    # Force a major version bump
```

## Commit Conventions

This repo uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message
must follow this format:

```
<type>(<optional scope>): <description>
```

**Types that bump the version** (appear in CHANGELOG):

| Type   | When to use             | Version bump |
| ------ | ----------------------- | ------------ |
| `feat` | New user-facing feature | minor        |
| `fix`  | Bug fix                 | patch        |
| `perf` | Performance improvement | patch        |

**Types that don't bump** (hidden from CHANGELOG):

| Type       | When to use                             |
| ---------- | --------------------------------------- |
| `chore`    | Deps, tooling, config, CI tweaks        |
| `refactor` | Code restructuring (no behavior change) |
| `style`    | Formatting, whitespace                  |
| `docs`     | Documentation only                      |
| `test`     | Adding/updating tests                   |
| `ci`       | CI pipeline changes                     |
| `build`    | Build system changes                    |

**Breaking changes**: Add `BREAKING CHANGE:` in the commit body or `!` after the type (e.g.
`feat!: remove legacy auth`) to trigger a major bump.

**Enforcement**: A `commit-msg` hook via husky + commitlint rejects non-conforming messages.

**Closing issues (issue #257)**: put **`Closes #N` in the PR body** — that's an *action* GitHub
honours on merge. `(#N)` in a commit subject is only a *reference*: it links, and the issue stays
open forever. Using the latter where the former was meant is why six issues were once found
already-shipped but still open, and five more after them; the docs gate held while the tracker
silently didn't. For **partial** work use `Refs #N` and comment what's left, so the issue keeps an
accurate scope instead of overstating it. `.github/PULL_REQUEST_TEMPLATE.md` prompts for the line;
`bun run check:shipped-issues` is the safety net that lists open issues a shipped commit referenced
(a **report, not a gate** — a commit can reference an issue without resolving it).

**Releasing**: When ready to release, run `bun run release`. It reads the commit history since the
last tag, determines the version bump, updates `package.json`, generates/updates `CHANGELOG.md`,
commits, and creates a git tag.

## Architecture

```
NicotinD (Hono API :8484)  — native library scanner + streaming, all in-process
└── slskd (Soulseek client :5030)  ──── shared /data/music folder
        DownloadWatcher → LibraryOrganizer → LibraryScanner (tags → SQLite)
```

> **Navidrome was removed.** NicotinD is now fully native: it scans the music dir itself
> (`LibraryScanner`, `music-metadata`), serves audio bytes from disk with HTTP range support
> (optional ffmpeg transcoding), and resolves cover art from folder/embedded images. The canonical
> `library_*` SQLite tables are the single source of truth. The **`/rest/*` Subsonic proxy and the
> playlist feature were dropped** in the same migration (playlists to be re-added natively later).

**Bun monorepo** with workspace packages:

| Package                     | Purpose                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@nicotind/core`            | Shared types (Zod schemas), logger (pino), crypto utils, error classes                                              |
| `@nicotind/slskd-client`    | Typed HTTP client wrapping slskd's REST API (`/api/v0/*`)                                                           |
| `@nicotind/service-manager` | Strategy pattern for managing sub-service lifecycle (child_process or Docker)                                       |
| `@nicotind/api`             | Hono API server — routes, JWT auth, unified search, download watcher, native library scanner + streaming, SQLite DB |
| `@nicotind/web`             | Angular v22 web UI (standalone components, signals, Tailwind)                                                       |
| `@nicotind/cli`             | Commander.js CLI (Phase 3)                                                                                          |

**Entry point**: `src/main.ts` — loads config, starts services, wires clients into the API server.

## Key Design Patterns

One-line index; **full detail for every entry is in
[docs/design-patterns.md](docs/design-patterns.md)** (and the per-feature doc linked on each line).
Add detail there, not here.

- **Source-agnostic acquisition (the north star)**: every acquirable result from any source maps to
  one `AcquisitionCandidate` rendered in one blended, ranked list with a neutral source chip +
  single Get; adding a source = one adapter + a pure mapper, no route/UI change. →
  [docs/source-agnostic-acquisition.md](docs/source-agnostic-acquisition.md)
- **Native library scanner**: `LibraryScanner` walks the music dir, reads tags (`music-metadata`) →
  `library_*` tables with deterministic SHA1 IDs; `resolveTags` applies user metadata overrides
  before minting IDs (survives rescans). An incremental `scan_cache` (raw tags keyed by
  path+size+mtime, `scan-cache.ts`) + bounded-concurrency tag reads (`mapPool`) skip re-parsing
  unchanged files, so an unchanged restart parses ~zero files. DB tuned via
  `applyPerformancePragmas` (synchronous=NORMAL/cache/mmap/busy_timeout) + a composite
  `idx_library_albums_grid`; the download-suppression album scan is memoized per-db
  (`albumIdsByGroupKey`). → [docs/library-scanner.md](docs/library-scanner.md)
- **Music licence / rights per track**: a per-song `licence` code from the closed `LICENCE_VOCAB`
  (`@nicotind/core` `licence.ts`: public-domain/cc0/the six CC licences/all-rights-reserved/unknown;
  `normalizeLicence` maps tag/URL/MB strings → a code, **positive IDs only** — never guesses ARR
  from a bare © notice). Retrieval is layered: file tags first (`LICENSE`/`COPYRIGHT`/`WCOP` via
  `licenceFromTags`, applied at scan time, zero-network), then MusicBrainz `license` url-relations
  (`musicbrainz-client.getLicence`, `inc=url-rels`), then a manual curator set. Stored as
  `library_songs.licence` (+ `licence_source` provenance) — additive column, COALESCE-preserved +
  tag-mirrored like `genre`/`bpm`; NULL = unknown (so the fill retries). The background `licence`
  enrichment task fills `WHERE licence IS NULL` (default-on, **never a gate**; a confident miss is
  ledgered-not-tallied); `backfill-licence.ts` is the bulk tool. Filterable via
  `LibraryFilter.licences` (`unknown` bucket = `licence IS NULL`); track-info sheet has a Detect +
  curator set editor. The album-level aggregate `library_albums.licence` = the **unanimous** track
  code (`unanimousLicence`, else NULL) computed in the scanner reduce, so Albums/Compilations filter
  to "entirely Public Domain" (artists stay any-track) + an album-page badge. →
  [docs/music-licence.md](docs/music-licence.md)
- **Popularity / hotness per song (issue #220)**: the first *extrinsic* signal — a normalized 0–1
  `library_songs.popularity` (+ `popularity_source`) from **ListenBrainz** (`ListenBrainzClient`,
  `POST /1/popularity/recording`, MBID-native + credential-free — chosen over Spotify's 0–100 which
  needs creds + an id hop). `normalizePopularity` log-scales a global listen count
  (`POPULARITY_REFERENCE`=1e6 ≈ 1.0; a documented, tunable constant). The recording MBID comes from
  the file's `mbRecordingId` tag (tags-first, no fuzzy name search) — a song without one is a
  confident miss. The default-on, never-a-gate `popularity` enrichment task (`makePopularityLookup`)
  **batches** all pending MBIDs into one call and distinguishes three misses: no-MBID + LB-confirmed-
  no-data are ledgered-not-tallied, a transient 429/outage is **not** ledgered (retries, like the
  sidecar 404/503 rule). **Not tag-mirrored** (extrinsic + drifts), so the scanner omits it from its
  upsert and it survives rescans untouched. `backfill-popularity.ts` is the bulk tool. Consumers
  (radio scoring axis, album/artist aggregate, local-play-count axis, an MBID-mapper coverage
  fallback) are deliberately **left as follow-ups**. → [docs/popularity.md](docs/popularity.md)
- **Multi-genre support (primary + extras)**: `splitGenres` parses full tag frames (`;`/`,`/`|`
  split; `&` never; `/` only when every side is a known genre) into `library_song_genres` (position
  0 = primary, mirrored into `library_songs.genre`); the human-gated `library_genre_aliases` side
  table (`reclassify-genres.ts` propose→review→apply→**`--backfill`** (`backfillGenresFromAliases`,
  re-mints stored sets without a rescan); one-to-many + junk-drop canonicals) fixes
  concatenations/variants at scan time without retagging — mashes like `"LatinWorld"` are segmented
  by `segmentConcatenatedGenre` (longest-known-segment first, cuts only at an uppercase letter
  preceded by a letter/digit so `Pop Rock`/`Dance-Pop` survive); filters match the set via EXISTS,
  radio scores `genreSetCloseness` (max pairwise over sets), recipe `where`s pass through
  `expandGenreWhere`, track-info shows genre chips. **Curator-correctable genres (issue #187)**:
  `library_genre_overrides` (scope `artist`/`album`/`song`, keyed at the granularity the _source_
  provides, applied by `buildLibrary`) is the one genre write that can **replace** a primary — a
  `genre_source` column can't work because a rescan rebuilds `library_song_genres` wholesale from
  tags; a curator row carries an explicit `mode` (**issue #260**, `append` by default, `replace`
  opt-in, `NULL` = the pre-#260 source rule) because neither answer fits every artist — replace is
  required when the tag genres are broad and wrong (`genreSetCloseness` is a position-blind MAX, so
  a retained broad genre masks the fix), append when they're specific and right (a replace flattened
  34 Ana Tijoux songs onto one list); automated rows prepend-and-keep — `essentia` (issue
  #187 task A2, the confidence-gated audio-inferred fallback below MusicBrainz/Lidarr) is the first
  real writer of that source. `status` is the review queue (a column, not a file — a file has no
  memory of rejection); `backfillGenreOverrides` applies without a scan; artist-page
  `ArtistGenreModalComponent` + `resolve-genres.ts` (MBID-only via `library_mbids`, album-first —
  MB/Lidarr artist genres measured at 3% coverage). Genre detection otherwise **appends** to the
  existing set, never overrides (`appendSongGenres` = read-union-dedup around `setSongGenres`,
  mirrored to the file tag): the track-info "detect genre" apply, the acquisition/window
  `genreTask`, and the on-demand `append-genre-backfill.ts` script all add rather than replace. →
  [docs/library-scanner.md](docs/library-scanner.md)
- **Genre radar (issue #222)**: `artistGenreDistribution` +
  `GET /api/library/artists/:id/genre-distribution` feed an inline-SVG radar (no chart dep) inside
  the artist genre-fix modal — the curation review aid, the half of #222 needing no product
  decision. `weight` = share of the artist's landed tracks carrying that genre, so weights
  **deliberately don't sum to 1** (sets overlap; normalising would under-report every multi-genre
  track) and it's position-blind to match `genreSetCloseness`. Top 8 axes, rest folded into a
  capped "Other". A radar overstates differences (area ~ radius²), so the **paired value table is
  the exact read and always ships with the chart**. Geometry is the pure `lib/radar-geometry.ts`.
  The **before/after view** now ships too: the modal charts the projected spread live beside the
  current one (pure `lib/genre-projection.ts` — no request), because the append-vs-replace choice
  (#260) was invisible until Save; dropped genres get a named line rather than just a vanished axis.
  **Album genre aggregate fixed** (intrinsic bug, not the UX question): `library_albums.genre` was
  `a.genres[0]` (first-processed track's first genre — a scan-order artifact); it is now
  `mostCommonGenre(a.primaryGenres)` in the scanner — the modal primary genre across the album's
  tracks, deterministic ties, unit-tested. **The "settle the multi-genre UX" sub-goal is now
  decided and shipped**: a read-only, listener-facing `GenreDistributionStripComponent` (plain CSS
  bar-fill, not the SVG radar) on both artist and album pages, backed by a new
  `albumGenreDistribution` + `GET /api/library/albums/:id/genre-distribution` mirroring the artist
  one; and an opt-in `LibraryFilter.primaryGenreOnly` (only meaningful alongside `genres`) that
  drops the join-table half of the genre SQL clause, matching `library_songs.genre` (the primary)
  only. → [docs/genre-radar.md](docs/genre-radar.md)
- **VA / compilation handling**: `resolveTags` separates `albumArtist` (grouping) from `trackArtist`
  (performer); `classifyFolder` detects compilations via COMPILATION flag, VA albumArtist, or ≥3
  artists sharing one album; dedicated Compilations tab, VA hidden from artists, "Appears On" on
  artist pages. → [docs/library-scanner.md](docs/library-scanner.md)
- **Multi-artist support (confirmation-gated)**:
  `splitArtists(raw, {confirmedArtists, canonicalWhole})` splits a compound into individual artists
  **only when every part is a confirmed real artist** (atomic library names ∪ cached Lidarr/MB
  decisions), else keeps it whole — never mangling a band/duo; featuring is always extracted. The
  offline authority is `loadSplitAuthority` + the scan-surviving `library_artist_identity` side
  table, populated by the `artist-identity` enrichment task / `resolve-artist-identity.ts` seed
  (works Lidarr-less via library-atomic confirmation) **and at acquisition time**
  (`recordAcquiredArtistIdentity`: hunt-download + `acquireAlbum` persist the Lidarr canonical name
  as one-act + its MBID before the scan lands). Spelling variants collapse via the
  `library_artist_aliases` side table applied in `buildLibrary` before ID minting; alias derivation
  from MBID equality is **human-gated** (`resolve-artist-identity.ts --aliases` proposes, `--apply`
  writes — the MBID cache holds fuzzy top-hit lookups, e.g. the real "Âme"/"ME" false pair). A
  compound that split is flagged scanner-owned `split_compound` and hidden from the artists grid
  (member tiles represent it; row stays navigable). `;` (semicolon) is a recognized split delimiter
  (matches acquisition sources). **Delimiter-less mashes** (issue #212, e.g.
  `2 MinutosTruenoDie Toten Hosen`) are split at scan time by `segmentConcatenatedArtist` — a
  confirmation-gated mirror of the genre segmenter (`segmentConcatenatedGenre`): cut only at an
  uppercase letter preceded by a letter/digit (so `Die Toten Hosen`/`Wu-Tang Clan` are safe),
  all-or-nothing on every segment being a confirmed artist, so a real single act is never carved up;
  the segmenter is gated, so a mash whose members appear in no other tag stays whole and still
  reaches Lidarr — `resolveOrAddArtist` therefore **refuses to provision an uncorroborated hit**
  (direction 2) via `corroboratesLidarrHit` (`services/lidarr-confidence.ts`, the one home for
  Lidarr match confidence). It is **name-only by measurement** — `/artist/lookup` ships no
  `albumCount`/`statistics`, so an `albumCount > 0` signal degenerates to string equality and
  rejects 16 of prod's 365 links incl. the #211 flagship. Instead: exact clean-key → coverage floor
  0.34 (kills `"2"` at 3 % coverage) → containment → Ukkonen-banded `boundedEditDistance` (O(n·k),
  ~1.2 M ops/s) behind an 8-char floor. **Never use Lidarr's `cleanName`** — it strips stopwords and
  rejects identical names. An uncorroborated hit on an artist that **already has a link keeps that
  link** (refresh `checked_at`, no throw), so the guard only blocks _new_ provisioning and **0 prod
  links break**. Direction 3 (mash candidates in the fragmentation diagnostic) was **measured and
  not built** — on prod it yields 2 candidates, both false positives. Admins fix wrong decisions via
  `POST /api/library/artists/identity` (one act / split / merge-variant / **rename** — the last
  reuses `library_artist_aliases` and allows an equal-normalized accent/case fix; runs the rescan
  **synchronously**, returns 200 for immediate feedback; permanent `source='user'` rows the
  background task never overrides) through `ArtistIdentityModalComponent` on the artist page +
  track-info sheet. Credits stored in `library_song_artists`/`library_album_artists`;
  `attachSongArtists`/`attachAlbumArtists` surface them on every listing + search;
  `ArtistLinksComponent` renders clickable inline links. →
  [docs/library-scanner.md](docs/library-scanner.md)
- **Native streaming + cover art**: `GET /api/stream/:id` (Range/206 + seekable disk transcode
  cache) and `GET /api/cover/:id` (override→canonical→folder→embedded, sized WebP thumbnails
  honoring `size=`); **`GET /api/cover/remote?u=` proxies catalog (Lidarr/MB) covers (issue #263)**
  through the same downscale+cache path — cards used to get 1200 px third-party CDN originals
  (878 KB for seven ~150 px tiles, measured on prod) or an unreachable Lidarr-relative
  `/MediaCover/…` path; `u` is host-allowlisted (SSRF) and content-addressed, and the three
  hand-rolled `<img>` call sites moved onto `<app-cover-art>` for placeholder/fade-in/error state; an artist id with no real photo 404s to the placeholder (no album-cover
  fallback). `nativeAppCors()` is hand-rolled (not `hono/cors`) so its Vary-header append can't
  strip `Content-Length` off Blob-bodied stream responses (the Firefox "never plays" bug).
  **Transcode cache integrity** (size-in-key, 1 KiB size floor, ffprobe post-check +
  `-xerror`/`+discardcorrupt`/`-err_detect explode`, in-use pin during pruning, body wrapper that
  releases the pin on response end, plus a **negative cache** for permanently-unusable sources —
  issue #317: the rejection was right but unremembered, so a damaged file re-ran its doomed ffmpeg
  pass on every play; only the typed deterministic `TranscodeOutputRejectedError` is cached, never a
  transient ffmpeg crash/ENOSPC, keyed `path+size+mtime` so a repaired re-download transcodes again
  with no manual eviction) closes the "1 KiB / 240 s track → 1.8 s media resource → seek
  bar at 100 % → false `ended`" failure mode on both the streaming cache and the ingest-time Opus
  transcode (which writes into the library itself). **Frontend false-ended recovery** (70 % + 5 s
  duration gate in `browserDurationIsAcceptable`, `isFalseEnded` / `startRecovery` state machine, 5
  s `recoveryTimeout` safety valve, `loadGeneration` cross-element guard) handles the symptom on the
  client too in case the browser mis-parses lossy duration over a Range response — **both gates fall
  back to an absolute 3 s floor (`FALSE_ENDED_ABSOLUTE_FLOOR_SEC`) when the API-known
  `track.duration` is missing/zero** (issue #234: that condition used to disable the guards
  entirely, an uncovered path distinct from the original bug). The recovery is **bounded**
  (`MAX_RECOVERY_ATTEMPTS` 3 per load, reset only when a new resource takes over): unbounded, a
  genuinely-short resource re-entered recovery on every `ended` and restarted every ~5 s forever
  instead of advancing; the two recovery exits also share one `clearRecoveryTimeout()` so the valve
  is cancelled rather than merely forgotten (a bare `= null` let it seek to 0 mid-playback). →
  [docs/library-scanner.md](docs/library-scanner.md) "Transcode cache integrity" +
  [docs/web-ui.md](docs/web-ui.md) "Plays 1-2 s then advances bug" / "Uncovered path (issue #234)"

- **Playback loading feedback (HDD-aware)**: one `PlayerService.buffering` signal (250 ms-delayed
  `bufferingVisible`) drives play-button spinners, the track-row current/buffering indicator
  (instant click ack), and a seek-bar buffered-ranges band; `setBuffering`'s guard reads
  `bufferingVisible` via `untracked()` so caller effects never subscribe to it (Firefox
  self-aborting load loop, bug #3). Every stream URL goes through `ServerConfigService.streamUrl()`,
  which appends `ngsw-bypass` so the Angular service worker (no `dataGroup` covers `/api/stream`)
  never intercepts it — it does in Firefox, and throws instead of passing through. **Player restore
  on page load is paused by default**: `restoreState()` no longer sets `isPlaying`; the autoplay
  decision is deferred to `maybeResumeAutoplay(autoplayOnLoad)` which runs after `GET /api/auth/me`
  resolves and only resumes when the per-user `user_settings.autoplay_on_load` flag is on (Settings
  → Playback toggle, default off). Effect 1's `audio.play()` calls are gated on
  `untracked(isPlaying())` so a freshly loaded track sits paused without ever hitting the
  gesture-less autoplay policy. → [docs/web-ui.md](docs/web-ui.md)
- **Queue extensions (full management)**: `PlayerService` exposes `queueNext`, `addToQueue`,
  `clearQueue`, `removeFromQueue`, `moveInQueue`, `toggleShuffle`, `jumpToQueueIndex`; Now Playing
  queue UI has header toolbar (shuffle/save-as-playlist/clear), per-track remove, drag-to-reorder
  (native HTML5 drag handlers — `onQueueDragStart`/`onQueueDrop` in the queue panel component, not a
  directive), a **manual drag-resize handle** (shell-owned above the Queue/Lyrics tabs; pull the
  panel taller → cover art shrinks; `createPointerDrag`, persisted per-device, mobile-only — the
  `lg:` side panel is fixed-width), history peek, and mini-player queue badge.
  The Play next / Add to queue entries are built inline by `SongMenuService.build` (calling
  `queueNext`/`addToQueue`), so every track-row menu gets them. →
  [docs/web-ui.md](docs/web-ui.md)
- **Pull-to-refresh (touch)**: one layout-hosted gesture on `<main>` (`lib/pull-to-refresh.ts`
  composing `createPointerDrag`, which now handles `pointercancel`) + a `PullToRefreshService`
  handler stack pages register into; coarse-pointer-gated, `overscroll-behavior-y: contain`
  suppresses Chrome Android's native P2R. → [docs/web-ui.md](docs/web-ui.md) "Pull to refresh"
- **Queue semantics — what a click replaces (issue #233)**: the bare `play(track)` never touched
  `queue`, so a standalone track click left an unrelated queue in place and it resumed the moment
  the clicked track ended. The gesture now decides: `play()` is the queue-untouched **primitive**
  (queue-owning callers + `RemotePlaybackService` sync only), `playSingle()` **replaces** the queue
  for a context-less click, `playWithContext()` makes *that list* the queue for every in-list row
  click (album detail + genre detail were still on the primitive — fixed), and `jumpToQueueIndex()`
  **consumes** the queue up to a tapped "Next up" row instead of leaving it there to replay.
  `startRadio(track)` clears the queue too, so radio starts now rather than after the stale queue
  drains. → [docs/web-ui.md](docs/web-ui.md) "Queue semantics"
- **Canonical artwork**: `library_artwork` stores canonical URLs keyed on deterministic IDs
  (survives rescans). → [docs/library-scanner.md](docs/library-scanner.md)
- **Artist images (auto + override)**: real portraits resolved through a priority-ordered **provider
  chain** (`artist-image-providers.ts` `buildArtistImageProviders` → `lidarr → spotify → …`, each
  provider self-contained so the Lidarr `db` coupling never leaks;
  `resolveArtistImageUrl(providers, artist)` walks it, `source` is an open `string`, adding a source
  = one `CHAIN` entry + the task `available` gate derives from `configuredArtistImageSources`),
  auto-filled by the `artist-image` enrichment task; users (admin) upload or copy-from-album a
  per-artist override (`<dataDir>/artist-overrides`, served first, `manual_override=1`, the
  short-circuit staying at the call-site SQL not the chain). **The window is no longer the only
  path (issue #250)**: that task is default-off in `gates` and window-only, so a fresh library could
  sit placeholder-only — `POST /artists/:id/auto-fetch-image` (silent one-shot, auth- but never
  curator-gated, gated on no-portrait-and-no-override) and `scripts/backfill-artist-images.ts`
  (bulk, dry-run by default) now share **one** implementation with the task via
  `services/artist-image-fill.ts` `fillArtistImages`; copying its resolve→persist sequence would
  have risked dropping the `clearCoverNegativeCache` eviction, which stores the portrait while the
  UI keeps showing the placeholder. **Gap 4**: the upload/from-album control is now the shared
  `ArtistImageMenuComponent`, used by the artist page *and* each Artists-grid tile (curator-gated) —
  one component, not a copy, because a second one drifts on the busy-guard and the cache-bust (the
  portrait URL is byte-identical after a change); `albums` is passed on the page but **lazily
  fetched** on a tile, and a "Fetch automatically" entry finally gives that auto-fetch route a web
  caller. → [docs/library-scanner.md](docs/library-scanner.md)
  short-circuit staying at the call-site SQL not the chain). **Coverage is visible (issue #250 gap
  3)**: `artistImageCoverage` → the `artistImages` slice on `GET /api/admin/review` → an Admin row
  ("N of M artists have a portrait" + bar), hidden at full coverage; `missing` **reuses**
  `NEEDS_PORTRAIT_SQL` so the number an admin reads is by construction the number a fill acts on,
  and `withPortrait` is computed directly rather than by subtraction because a curator upload lives
  on disk with **no `library_artwork` row**. Prod was 980 of 2,472 (60 % placeholder) with no
  in-app way to see it. **An identity fix carries curation
  forward (issue #305)**: a rename/merge re-mints the artist id, silently orphaning the portrait,
  the uploaded file and the bio (prod: 88 dead artwork rows of 1011, 2 dead uploads of 140) —
  `carryArtistCuration` moves them at the fix site (the only place that knows the old→new mapping),
  never clobbering the destination's own, and moves the **genre override by normalized name** since
  that table keys on the name, not the id. →
  [docs/library-scanner.md](docs/library-scanner.md)
- **Artist bios (auto + override)**: biographies + external links resolved via MBID-first lookup to
  Discogs (plugin-sourced; MBID from file tags or `library_mbids` cache), stored in
  `library_artist_meta` with tombstone rows preventing re-queries of confirmed misses. Auto-filled
  by the `artist-info` enrichment task + a silent one-shot **auto-fetch on first artist-page visit**
  (`POST /artists/:id/auto-fetch-info`, auth-gated, never curator-gated, gated on
  `metaExists=false && !manualOverride` so it's a one-shot per artist; reuses the same
  `fetchAndStoreArtistInfo` core as `refresh-info`); admins edit via `ArtistInfoComponent` on artist
  pages (`curator`-gated, never overwrites `manual_override=1` rows). The component runs a pure
  `formatArtistBio` (`packages/web/src/app/lib/artist-bio.ts`) on every render to strip Discogs
  BBCode — **both** ref shapes the API actually returns (named `[a=Name]`/`[l=Jive]` keep the
  embedded name incl. whole member lists; numeric `[a123]`/`[l123]`/`[m123]`/`[r123]` id refs
  dropped with whitespace cleanup; the original #213 version only handled the `=name` shape so
  `[a=Name]` lists + `[b]`/`[i]`/`[u]` tags leaked as literal garbage), `[b]`/`[i]`/`[u]` tags
  dropped keeping inner text, `[url]` label kept, `''`→`'`, bare trailing URLs moved to a "Sources
  (N)" disclosure deduped against the API `urls`), and gates the show-more toggle on
  `scrollHeight`/`clientHeight` (`ResizeObserver`) rather than a char count so it never appears when
  expanding reveals nothing. **Lidarr MBID fallback widens for canonical-name drift (issue #211)** —
  `resolveMbidViaLidarr` is two-stage: exact-normalized-name first (the same discipline that has
  always guarded this flow against the `Âme`/`ME` false pair), then a **whole-token-subsequence** +
  `albumCount > 0` corroboration on miss (e.g. library `Eduardo Miño` → Lidarr
  `Luis Eduardo Miño Naranjo`, real prod case where the canonical name is a _superset_ of the
  library's tag-derived name). The widened path reports `confidence: 0.5` vs the exact `0.8` so
  `library_mbids` carries the provenance forward. →
  [docs/library-scanner.md](docs/library-scanner.md)
- **Search matching (tokenized + accent-insensitive) + fragmentation diagnostic**: searching "C.
  Tangana Ídolo" returned Songs but no album card even though the release is a clean visible row —
  root cause was `LibrarySearchProvider` matching the _whole query as one `LIKE`_ substring with
  `COLLATE NOCASE` (no diacritic fold), so multi-token "artist + title" queries and un-accented
  queries ("Idolo"→"Ídolo") both missed. Fix: JS-side `tokenize`/`matchesAllTokens` (shared
  `services/search-tokens.ts`) — fold (NFD+strip marks+lowercase) + per-token AND over a
  `name+artist` haystack. The **catalog lane reuses the same matcher**: a pure title search (no
  artist matched) runs `filterAlbumsByRelevance` so Lidarr's fuzzy `album.lookup` can't collapse a
  multi-word query to its first token (the "La bifurcada" → "La"-albums bug). Separately (superseded
  by issue #227 — the Search page is now **acquisition-only**, so it no longer renders `local`
  results; that library search moved to the Library tabs/Radio), and a **prod-calibrated**
  `checkFragments` (`services/library-fragments.ts`) surfaces genuine integrity defects —
  same-release artist-spelling variants ("La Konga"/"La K'onga", sub-clustered by an alnum artist
  fold so different artists sharing a title aren't flagged) and full albums mis-classified as
  single/EP (track-count-vs-class via the **curator's own `contradictsTrackCount`** — issue #314:
  keeping a second, stricter opinion here reported prod's real 7-/8-track maxi-singles as defects
  forever while the corrector correctly never fixed them) — via `GET /api/library/fragments`
  (admin), the Admin "Check fragmentation" button, and `scripts/check-fragments.ts` (CLI gate — its `expandHome` copy returned `''` for absolute
  paths, so it had **never** run in Docker; helper now shared + tested in `scripts/lib/expand-home.ts`). →
  [docs/library-scanner.md](docs/library-scanner.md) "Search matching" + "Fragmentation diagnostic"
- **Metadata optimization**: conservative, all-or-nothing bulk Lidarr re-fetch of
  cover/year/release-type (`optimizeAllAlbums`); skips placeholder-artist albums. →
  [docs/metadata-optimize.md](docs/metadata-optimize.md)
- **User-driven metadata fix**: interactive Lidarr candidate search + free-text + multi-source cover
  picker (Lidarr/URL/track-embedded/**upload**), persisted in `library_metadata_overrides` with
  immediate canonical re-point. → [docs/metadata-optimize.md](docs/metadata-optimize.md)
- **On-demand track analysis (BPM + genre)**: per-track analyze/verify in the track-info drawer +
  bulk backfill scripts; writes DB **and** file tag. BPM detection is **sidecar-first** (Essentia
  `POST /rhythm` — the local music-tempo fallback makes frequent half/double-tempo octave errors);
  historical octave errors are repaired by `analyze-bpm.ts --recheck`. →
  [docs/library-scanner.md](docs/library-scanner.md),
  [docs/library-processing.md](docs/library-processing.md)
- **Windowed library processing**: resumable background enrichment
  (bpm/genre/key/energy/audio-features/artist-image/genre-audio) via an extensible task registry,
  run only inside a daily window; ffmpeg/sidecar failures are diagnosed (stderr tail surfaced, not
  swallowed as a bare exit code), tallied into `ProcessingStatus`, toasted in the Settings panel
  (with Run now disabled while running), and reported to Sentry as one aggregated event per failing
  task. Permanently-broken files (corrupt "Invalid data" decodes; sidecar **422** un-decodable files
  via `AudioFileRejectedError`) _and_ persistently-undetectable/unresolvable ones (no confident
  BPM/key — ledgered via `NoConfidentResultError`, not tallied; Lidarr-unknown-artist genre songs —
  ledgered, not tallied; low-confidence `genre-audio` inferences — same ledgered-not-tallied
  treatment, issue #187 A2) are excluded after N attempts via a `library_song_analysis_failures`
  ledger (auto-reset on re-download/size-change, surfaced as `skipped`); a sidecar 404/503 (env
  mount mismatch / models down) stays un-ledgered so a misconfig can't exclude the whole library.
  the panel's failure tally is scoped to one window session (no eternal stale banner), and every
  ffmpeg decode has a kill-timeout so one hung file can't wedge a run. **Compute throttle (issue
  #224)**: `concurrency` (the sidecar inference bound — it feeds `createEnrichmentContext`, so
  lowering it lowers GPU pressure) + `batchSize` are now editable in the Admin panel through the
  pure `clampInt`, and an **analysis-sidecar status** row renders from a new
  `services.analysis {configured,healthy}` slice on `GET /api/admin/review` (unconfigured is the
  default deployment, never an `errors[]` entry). CPU-vs-GPU stays build-time (`GPU=1` arg), so the
  UI governs runtime load only — and **measurement showed `concurrency` is a CPU/queueing knob, not
  a GPU one** (issue #224): throughput is flat within 1 % from concurrency 1→8 because the sidecar
  serialises inference, and peak GPU memory is identical too. The real pressure is that TF **never
  releases** grown memory, so the sidecar ratchets from ~85 MiB to **7,631 MiB of an 8,192 MiB card
  after the first inference and holds it while idle** — `gpuBusyPercent` gates on *utilisation*, so
  it can't protect a co-tenant from that *allocation*. **The Admin GPU pill now surfaces VRAM
  used/total** (`MetricPillComponent` `gpuMemoryLabel`, from `nvidia-smi memory.used/total` already
  collected in `system-metrics.ts`) so that 93 %-held allocation is *visible* even at ~0 %
  utilisation — visible even at ~0 % utilisation. **The reduction itself now ships too**, correcting
  the issue's own premise: Essentia exposes no `ConfigProto`/`memory_limit` surface (it constructs TF
  predictors directly), so `packages/analysis/app/idle_release.py`'s `RegistryHolder` +
  `IdleReleaseGuard` drop the warm-loaded registry after `ANALYSIS_IDLE_RELEASE_SEC` (default 900s, a
  background asyncio task checks every 30s) and reload it lazily on the next `/analyze` call — both
  objects take an injectable clock (mirrors `cuda_device_count`'s injectable-loader style) so
  `test_idle_release.py` drives idle→drop→reload with no real sleeps; `/health` gained a `loaded`
  field. **Verified on `kpc` and it never actually released**: `/health`'s Docker healthcheck polls
  every 30s and read the registry via `get()`, which touches the idle guard on every call — so the
  healthcheck alone kept resetting the idle timer forever. Fixed with `RegistryHolder.peek()` (reads
  without touching the guard or reloading), now used by `/health`; `get()` stays reserved for
  `/analyze`, the one caller that should count as activity. A second, **unverified-on-hardware**
  lever — `TF_GPU_ALLOCATOR=cuda_malloc_async` — ships as a commented-out `docker-compose.gpu.yml`
  override, not baked into the image, pending a `kpc` measurement. →
  [docs/audio-ml-enrichment.md](docs/audio-ml-enrichment.md) "Measured GPU behaviour". A `paused` flag (+ `ProcessingPhase 'paused'`) is the temporary
  runtime halt distinct from `enabled: false`: it skips window/background enrichment but **still
  clears quarantine** (a pause must never leave new music invisible) and `runNow()` overrides it.
  **`gpuBusyPercent` (0 = off) is the *automatic* counterpart**: `tick()` reads the existing cached
  `readGpu` probe and yields the pass (`ProcessingPhase 'gpu-busy'`) while another tenant is using
  the card — the reference host shares one P4000 with Immich ML + Ollama, and enrichment is the
  tenant that can always wait. Unknown/throwing utilisation **never** yields (else a box without
  `nvidia-smi` would stop enriching entirely), quarantine still clears, and the flag is remembered
  because `snapshot()` recomputes phase from settings and would otherwise report `idle`. →
  [docs/library-processing.md](docs/library-processing.md)
- **Process-before-landing (quarantine gate)**: a fresh download is scanned into `library_songs` but
  held **quarantined** (`landed_at IS NULL`, hidden from every listing) until its **required** steps
  finish; a per-task `gates` flag (distinct from `tasks`, defaults bpm/key/energy/genre on,
  sidecar/artist-image off) intersected with availability = the required set, so an off/unavailable
  step never strands a download; `graduatePending` lands a song once each required step is
  satisfied-or-permanently-failed, or after a 24h safety valve; `scanIncremental` fires an eager
  out-of-window `kickEager()` so it lands ASAP; per-download step badges via
  `GET /api/admin/processing/queue`. → [docs/library-processing.md](docs/library-processing.md),
  [docs/download-pipeline.md](docs/download-pipeline.md)
- **Perceptual audio features (no LLM)**: energy/loudness measured bun-side via ffmpeg ebur128;
  danceability/valence/mood/vocals/acousticness + cached embeddings (content-invalidated by
  `library_embeddings.file_size` since issue #258 — a file replaced in place keeps its path-derived
  song id, so without it Radio scored against a vector for audio that was no longer there) from the
  Essentia sidecar
  (`packages/analysis/`, `NICOTIND_ANALYSIS_URL`; CPU by default, `--build-arg GPU=1` swaps in GPU
  libtensorflow with inherent CPU fallback); all written to file tags + COALESCE-preserved columns,
  scored by the Radio engine and sequenced via `energy-arc`. →
  [docs/audio-ml-enrichment.md](docs/audio-ml-enrichment.md)
- **Lyrics (on-demand, plugin-sourced, editable)**: new `metadata` plugin kind + `lyrics` capability
  (LRCLIB first source); stored in `library_lyrics` + file tag, user-editable. Now Playing's
  **Lyrics tab** (alongside Queue — see the Now Playing component-split entry below) opens a
  karaoke-styled panel (synced line highlighting + auto-scroll) with a fullscreen expand button —
  fullscreen defaults to a current+next-line-only auto-follow view (narrow-screen/TV friendly) with
  a wheel/touch-gesture browse mode for tap-to-seek; a centered styled empty state carries an inline
  Fetch button. Fetch is
  **reliable 1-click**: LRCLIB retries transient failures (404 stays no-match) and the route returns
  `502` for a source error vs `null` for a confident miss, so the first click doesn't
  false-negative. **Vocal mute** (`?vocals=off` → server-side ffmpeg center-channel cancellation
  `pan=stereo|c0=c0-c1|c1=c1-c0`) is a mic toggle in the karaoke overlay; it forces the transcode
  path even when transcoding is off and is cached as a separate `novox` transcode entry. →
  [docs/design-patterns.md](docs/design-patterns.md)
- **Unified search**: `GET /api/search?q=` blends local library + parallel slskd network results
  into the one source-agnostic results list. →
  [docs/source-agnostic-acquisition.md](docs/source-agnostic-acquisition.md)
- **Acquire page (acquisition-only, issue #227)**: the page (nav **"Acquire"**, route **`/acquire`**,
  renamed from `/search`) no longer renders local-library results (the "In your library" album
  section + local "Songs" finder were removed) — Acquire = "find/add new music", "find what I own" =
  Library tabs/filters + Radio. The route rename ships a `{ path: 'search', redirectTo: 'acquire' }`
  redirect (query-param-preserving) so every existing `/search?q=…` link/bookmark still resolves; the
  component keeps its `SearchComponent` name because the backend is still `/api/search`. The API still
  returns `local` (unchanged `LibrarySearchProvider`); a non-acquirer (listener, or #235 off) sees a
  "browse your Library instead" empty state (`data-testid="search-acquisition-off"`). **Left open**
  (product): whether a lightweight library-find box belongs on the Library page. →
  [docs/source-agnostic-acquisition.md](docs/source-agnostic-acquisition.md) "Unified search",
  [docs/web-ui.md](docs/web-ui.md)
- **Deployment-wide acquisition kill-switch (issue #235)**: one authoritative
  `config.acquisitionEnabled` (env `NICOTIND_ACQUISITION=off`, default on) turns the **whole**
  acquisition module off for a lighter streaming/library-only install — orthogonal to the per-user
  role gate + per-plugin opt-in. Server: `requireAcquisitionEnabledMiddleware` **hard-404s** every
  acquisition route group
  (`acquire`/`discography`/`watchlist`/`archive`/`spotify`/`sources`/`downloads`);
  `searchRoutes(registry, acquisitionEnabled)` skips the network fan-out for all; the watchlist +
  auto-acquire pollers don't start. Web: `/api/auth/me` returns `acquisitionEnabled` →
  `AuthService.canAcquire()` = `serverAcquisitionEnabled() && role`, cascading to nav/guards/Search.
  Extensions **hides its Acquisition section** when off (a toggle that can't do anything, and the
  "nothing is downloaded until you enable one" framing is wrong), and
  **`docker-compose.streaming-only.yml`** actually runs lighter — it resolves to `nicotind` +
  `analysis` only, dropping slskd/Lidarr/bgutil; it needs *both* `profiles:` on those services and
  `depends_on: !reset null` on nicotind, because compose **merges** `depends_on` rather than
  replacing it (`[]` silently keeps the base entries). **Now runtime-togglable**: `AcquisitionToggle` +
  `GET`/`PUT /api/admin/acquisition` (audit-logged). The "can't tear down live"
  worry was overstated — the pollers already re-check `isAcquisitionEnabled()` per tick, so they
  self-disable; they just needed starting whenever the *env* permits. The real change was three
  capture sites going `boolean` → `() => boolean` (gate middleware, `searchRoutes`, `/me`). The env
  var is a **hard floor an admin cannot lift** (`configurable: false`), so a streaming-only install
  can't be re-enabled by an admin account; the read is un-memoized because a stale cache means the
  routes keep serving after an admin turns it off. The Admin panel exposes it as one switch —
  read-only with an explanation when env-locked, and hidden entirely when the route is absent. →
  [docs/deployment.md](docs/deployment.md) "Streaming-only profile", [docs/roles.md](docs/roles.md)
- **Guided acquire UX**: catalog cards are the primary path; the raw network/folder-browser lane is
  demoted behind an "Advanced" disclosure; the hunt modal leads with the best match. The raw lane's
  Songs/Folders view **defaults to Folders for an album-intent query** (`pickNetworkView`: catalog
  has albums, or the query is multi-word — a folder is the "get this album" unit), and the long
  blended song-first Results list is **capped** (`RESULTS_CAP`, "Show all N" escape) so it can't
  dominate the page. The Advanced Soulseek peer lane is **gated on the network actually being an
  available source** (`networkAvailable() || hasNetwork()`), so a user without the slskd extension
  never sees a nonsensical "No Soulseek results" empty state for a source they don't have. →
  [docs/design-patterns.md](docs/design-patterns.md), [docs/album-hunt.md](docs/album-hunt.md)
- **Inline download lifecycle**: result cards go idle → progress % → "Open in Library", driven by
  `TransferService` (adaptive polling) + a `libraryDirty` signal; completed Downloads-feed rows
  likewise expose an **"Open in Library"** deep-link to the destination album via the deterministic
  `albumId` the API ships (graceful "Album not found" fallback), or, for an acquire job whose files
  landed in more than one album, a **"View N albums"** `MenuPanelComponent` dropdown listing each
  destination. → [docs/design-patterns.md](docs/design-patterns.md),
  [docs/download-pipeline.md](docs/download-pipeline.md)
- **Multi-user + roles**: shared music library, per-user settings in sqlite; first registered user
  becomes admin. Four-role ascending ladder `listener < user < refiner < admin` (strict superset
  each step) shared via `@nicotind/core` `roles.ts` (`canAcquire`/`canCurate`/`isAdmin`):
  **listener** = play/search-library/playlists only, acquisition hidden + server-enforced
  (declutter); **user** adds acquire; **refiner** adds library curation (relaxes
  `requireAdmin`→`requireCurator` on library.ts edit/merge/delete routes); **admin** adds server
  admin. Guards `requireAcquirer`/`requireCurator`/`requireAdmin`; search suppresses only its
  network fan-out for listeners (library results always return). → [docs/roles.md](docs/roles.md)
- **MCP agent access (issue #232)**: an external LLM/agent can curate a user's library via
  `/api/mcp`, authorized by a scoped, revocable `agent_tokens` bearer **capped at `refiner`**
  (`AGENT_EFFECTIVE_ROLE` — an admin who mints one does not get an admin agent). Opaque token
  (`nca_…`), only its **sha256 hash stored** (a table leak leaks nothing live), revoked by stamping
  the row (`verifyAgentToken` checks every call). `services/agent-tokens.ts` = `mintAgentToken`
  (secret returned once) / `verifyAgentToken` / `listAgentTokens` / `revokeAgentToken` (owner-scoped);
  managed by a curator via `/api/agent-tokens` (`agentTokensRoutes`, JWT+`requireCurator`, audit-
  logged) or the **`pages/settings/agent-tokens/` Settings UI** (mint shown-once + copy, list,
  revoke; a new `curatorGuard` route guard mirrors the server's `requireCurator`). The MCP endpoint
  (`mcpRoutes`, hand-rolled JSON-RPC `initialize`/`tools/list`/`tools/call`, no SDK dep) authenticates
  with the **agent token, not the JWT**. `checkToolAccess` (pure, tested) is the guard: a `curate`
  tool needs the `:curate` scope, a `destructive` tool needs `args.confirm === true`; `dispatchTool`
  applies it and every write is `recordAudit`-ed. **Tools = read + safe-curation + destructive
  writes** (`search_library`/`get_artist`/`get_album_tracks`/`set_song_licence`/`delete_song`/
  `delete_album`/`merge_artist`) — deletion was inline `rmSync` in routes; it is now
  `services/library-deletion.ts` (`deleteOne`/`deleteAlbum`, `db`/`musicDir`/`ShareRescanScheduler`
  as explicit params, not closures), the **one** implementation both the HTTP delete routes and the
  two MCP delete tools call, so wiring `rmSync` to an agent never became a second copy. **`merge_artist`
  (issue #339) got the same extraction**: the rename/merge/single/split decision logic inline in
  `POST /artists/identity` is now `services/artist-identity-mutate.ts` `mutateArtistIdentity(db,
  {dataDir}, body)` — mints the alias/identity row + carries curation, but leaves the resync and
  `recordAudit` to the caller (route vs. MCP tool), same split as the deletion service. Only the
  merge mode is exposed as an MCP tool (`mergeInto`, an unambiguous single target name an LLM can
  supply) — rename/single/split stay curator-UI-only for now. `mcpRoutes(musicDir, slskdRef, dataDir,
  runSync)` wires both dependency pairs explicitly. → [docs/mcp-agent.md](docs/mcp-agent.md)
- **Presence tracking (admin-only, ephemeral)**: in-memory `PresenceService` tracks `isConnected` /
  `amountOfDevices` / `amountOfSessions` per user via 60s HTTP heartbeats + stale cleanup; merged
  into `GET /api/admin/users`. → [docs/presence-tracking.md](docs/presence-tracking.md)
- **Onboarding**: expanded setup wizard for self-hosters (music dir + quality + Lidarr); first-login
  welcome banner for admin-provisioned app users. → [docs/onboarding.md](docs/onboarding.md)
- **Now Playing queue — clear + drag-reorder + per-row remove**: "Next up" supports a Clear link,
  HTML5 drag-and-drop row reorder, and per-row remove (X) backed by `PlayerService.clearQueue()` /
  `moveInQueue(from,to)` / `removeFromQueue(index)`. → [docs/web-ui.md](docs/web-ui.md)
- **Now Playing component split + tabbed Queue/Lyrics panel**: the once-monolithic
  `now-playing.component` shell now composes 7 extracted sub-components
  (`NowPlayingHeaderComponent`/`-CoverArtComponent`/`-TransportComponent`/`-PanelTabsComponent`/
  `-QueuePanelComponent`/`-LyricsPanelComponent`/`-KaraokeFullscreenComponent`); a **Queue/Lyrics tab
  switcher** (`NowPlayingPanelTabsComponent`, queue-count badge + lyrics-availability dot) replaces
  the old lyrics-toggle-swaps-the-queue model. The queue drag-resize handle is **shell-owned, above
  the tabs** (works on both panels — inside the queue panel it vanished on the Lyrics tab), and at
  `lg:` the sheet is **two columns**: cover/transport left, the tabbed panel an always-visible fixed
  380px right column (Spotify-like), via `contents lg:flex` group wrappers since every child is
  `display: contents`. The sheet now follows theme tokens like the rest of
  the app — only the fullscreen karaoke overlay's dynamic cover-gradient background stays an
  intentional exception. → [docs/web-ui.md](docs/web-ui.md)
- **Smart radio (metadata-driven queue)**: `GET /api/radio/next` scores candidates by a
  **weight-normalized** blend (comparable-factors-only, so un-analyzed tracks aren't out-biased
  mid-backfill) of BPM, Camelot key (incl. ±2/diagonal moves), multi-genre set closeness
  (`genreSetCloseness`, max pairwise lexical), year, duration, artist diversity, the perceptual
  axes, and cached-embedding cosine (`embedding-store.ts`); a widened pool (+genre-LIKE,
  +un-analyzed seat) feeds it; `PlayerService.radio` auto-appends when the queue drains.
  **Filter-seeded radio**: the same route also starts a mood/genre/bpm "vibe" with **no seed song**
  — a `LibraryFilter` (parsed from the shared serialize grammar) constrains the pool via
  `songFilterWheres`, seeded by its `seedCentroid`; `PlayerService.radioFilter` keeps auto-replenish
  in-vibe. `toOrderable` used to omit `genre`/`genres` entirely, so every filter-radio vibe scored
  genre-blind (issue #187 task B4, fixed); the centroid's modal key ("collapses to C major") was
  investigated and is a measured null result, not a bug — see docs/radio.md. This backs the
  **radio/mood landing** (the post-login home route `''`, `pages/radio-landing/`): a last-track
  resume shortcut (disappears on tap) + one-tap vibe presets + top-genre chips; Search moved to
  `/search`. Shared scoring with `/songs/:id/similar`. A **missing candidate genre is floored, not
  skipped** (`MISSING_GENRE_FLOOR` 0.2, reported in `explainSimilarity().floored`) — skipping
  dropped the genre axis out of the denominator and literally _rewarded_ untagged tracks; the genre
  weight itself was re-measured and raised 10→18 (issue #187 task B3) after `dump-radio.ts` found a
  sparse-pool seed where it still wasn't enough to keep a wrong-genre track down. **Diagnostic
  dump** (`scripts/dump-radio.ts`, dev-only, read-only, `--weights axis=n` to A/B a weight change
  before shipping it): generates a radio via the shared `buildSeedRadio`/`buildFilterRadio`
  (extracted from the route so no drift) and reports every track's per-axis score breakdown via the
  pure `explainSimilarity` (`scoreSimilarity` now delegates to it) + an auto "improvement targets"
  section — distinguishes genre-_skipped_ (data gap, missing-genre is wrongly _rewarded_ by
  present-axis normalization) from genre-_scored-0_ (weight loss), flags un-split concatenated genre
  tags (`looksConcatenatedGenre`) + key-detection instability + filter-radio centroid
  genre-blindness. → [docs/radio.md](docs/radio.md), [docs/web-ui.md](docs/web-ui.md)
- **Remote playback (cast, Spotify-Connect-style)**: per-user `PlaybackStateManager` broadcasts
  state/commands over `GET /api/ws/playback`; each browser tab is a device. →
  [docs/remote-playback.md](docs/remote-playback.md)
- **Hardware cast (Chromecast + DLNA, server-side controller)**: a `CastController` runs protocol
  adapters (`castv2`/`bonjour` for Chromecast, `node-ssdp`/`upnp-mediarenderer-client` for DLNA)
  server-side; any browser controls hardware via REST `/api/cast/*`; short-lived scoped
  `cast_tokens` authenticate the hardware's direct `GET /api/stream` fetches; the controller bridges
  hardware state into the existing WS `PlaybackStateManager` as a proxy device. No browser Cast SDK,
  no native mobile plugin, opt-in discovery with manual-IP fallback for Docker. →
  [docs/cast-integration.md](docs/cast-integration.md)
- **Service modes**: `embedded` (spawn slskd as child process) or `external`; the library/streaming
  stack is in-process. → [docs/design-patterns.md](docs/design-patterns.md)
- **Auth flow**: NicotinD issues its own JWTs (30-day sliding sessions, silent refresh on boot);
  share tokens are short-lived, read-only, non-refreshable. The `authGuard` preserves the attempted
  URL as a `returnUrl` param when bouncing to `/login`; login sanitizes it (pure
  `sanitizeReturnUrl`, in-app paths only) and redirects back after auth (issue #231). A share link
  opened while **already logged in** resolves token→resource via the auth-gated, side-effect-free
  `GET /api/share/:token/resource` and deep-links into the real in-app page under the user's own
  session — never burning the public 5-minute token (issue #230). Shareable resources are
  album/playlist/**artist** (issue #229 added artist: portrait + name + bio + playable songs in-app,
  plus a server-side OG/Twitter `profile` link preview mirroring albums/playlists). →
  [docs/design-patterns.md](docs/design-patterns.md), [docs/web-ui.md](docs/web-ui.md)
- **Device pairing (QR link) + remote access (Tailscale Funnel)**: the server mints a 5-min
  single-use pairing token rendered as a QR (+ 6-char fallback code) on `/settings/devices`; the QR
  encodes a `/pair#t=…` **link** (token in the fragment) so a plain camera app opens the server's
  public `/pair` page and signs the browser in, while the app's in-app scanner (full raw-bridge
  options — iOS rejects sparse calls) probes candidate URLs and claims a device-bound 30-day JWT
  (revocable via `paired_devices` row delete, enforced at refresh); the native app keeps a
  **saved-servers registry with per-server stashed sessions** (switch/remove/remember, no passwords
  stored) reachable from login + Settings; opt-in remote access publishes the loopback-bound backend
  at a public HTTPS URL via `tailscale funnel` behind a guided admin state machine. →
  [docs/device-pairing.md](docs/device-pairing.md)
- **Observability (Sentry, opt-in)**: web `loadSentry` (empty DSN = off, prod-only, versioned + low
  sampling) + API `initServerSentry` (`NICOTIND_SENTRY_DSN` empty = off) reporting only unknown 500s
  from the Hono `errorHandler` (4xx/connectivity skipped), plus `captureProcessingFailure` for
  aggregated, fingerprint-grouped library-enrichment failures. **The web SDK loads lazily (issue
  #285)** — it was 42% of the initial chunk (272 kB, Session Replay 124 kB) and eager to catch
  startup failures; now reached only via `import('@sentry/angular')` (own lazy chunk) while
  startup-error capture is preserved by a synchronous `error-buffer.ts` + `BufferingErrorHandler`
  (replaces `Sentry.createErrorHandler`/`TraceService`) that replays into the SDK on connect. →
  [docs/observability.md](docs/observability.md)
- **OAuth authentication (proposed — not yet implemented)**: Google + Microsoft login as `auth` kind
  plugins with `oauth` capability; auto-creates users by email (no validation); auto-enables when
  env-set creds present; dev bypass provider gated by `OAUTH_DEV_BYPASS` env var;
  `NICOTIND_PUBLIC_URL` for prod redirect base; Capacitor `nicotind://` deep-link for mobile parity.
  → [docs/oauth-auth.md](docs/oauth-auth.md)
- **Release-type model (singles & EPs)**: every album carries a `classification`, set metadata-first
  (Lidarr/MusicBrainz) with a track-count heuristic fallback. →
  [docs/download-pipeline.md](docs/download-pipeline.md)
- **Native playlists (per-user)**: `playlists`/`playlist_songs` + `PlaylistService`, private per
  user, with sharing + server-side OG/Twitter link previews; the detail page adds a reusable
  `SongPickerComponent` (debounced autocomplete) + a token-overlap "suggested for this playlist"
  proposals list, both refreshed after every membership mutation. → [docs/web-ui.md](docs/web-ui.md)
- **Curated playlists (system, global)**: gradient-covered Spotify-style shelves shown to all users;
  read-only by `kind` (not ownership). → [docs/curated-playlists.md](docs/curated-playlists.md)
- **Automated playlists (recipe → refreshed curated shelves)**: code-defined `RECIPES`
  (bpm/key/year/genre `where` + sort) materialized into `kind='curated'` playlists by
  `refreshAutoPlaylists`; reuses `selectCuratedTracks` + the shared `upsertCuratedPlaylist`.
  **Admin-configurable cadence (issue #228, `off`/`daily`/`weekly`)** persisted in
  `library_sync_state` `auto_playlists_cadence`, guarded per-period by `auto_playlists_period`
  (`<cadence>:<n>`, `updated_at` = last-refreshed); `runAutoPlaylistsNow` is the guard-bypassing
  "Generate now"; admin routes `GET`/`PUT /api/admin/playlists/auto` +
  `POST /playlists/auto/refresh` (audit-logged) back an Admin panel; the detail page shows
  "Refreshed &lt;date&gt;" from `modified_at`. →
  [docs/automated-playlists.md](docs/automated-playlists.md)
- **Likes → auto-maintained "Liked Songs" playlist (issue #225)**: a per-user heart (track row
  `track-like`, track-info `track-info-like`, the `SongMenuService` menu's leading Like/Unlike).
  "Like" is personal so it can't reuse the global `library_songs.starred`; instead a new
  `PlaylistKind` value `liked` (one per user, lazily created on first like) makes **the playlist
  itself the store** — membership = liked, newest-first via decreasing `position`, no new table
  (`kind` already exists). `PlaylistService.likeSong`/`unlikeSong`/`likedSongIds`; auth-gated
  `POST`/`DELETE /api/library/songs/:id/like` + `GET /api/library/liked-ids`; web `LikeService`
  (optimistic, signal-backed set hydrated in the app shell). Read-only through the CRUD API (the
  `kind='user'` guard), pinned first in the playlists list. →
  [docs/song-actions.md](docs/song-actions.md)
- **Playlists page (merged single list)**: one list (no separate "yours"/curated shelves) sorted
  server-side curated-first, with an inline "Curated" badge + per-row Rename/Delete restricted to
  `kind='user'` rows, and create-then-redirect straight to the new playlist's detail page. →
  [docs/playlist-generation.md](docs/playlist-generation.md) §0a
- **Artist page — tabbed**: Albums | Singles & EPs | Songs (lazy, paginated Songs tab with
  multi-select bulk actions incl. admin-gated delete — the only view that can remove albumless
  files). → [docs/design-patterns.md](docs/design-patterns.md)
- **Viewport-safe dropdown menus (`MenuPanelComponent`)**: fixed-position panel that flips above /
  clamps into the viewport via the pure `computeMenuPosition`, reserving a `bottomInset` (measured
  from `data-bottom-chrome` layers via `bottomChromeInset`) so it never opens under the
  mini-player/tab bar; every `TrackRowComponent` `⋯` menu uses it. →
  [docs/design-patterns.md](docs/design-patterns.md)
- **Bottom-chrome stacking + scroll lock**: mini-player and tab bar share one `z-50` plane;
  `ScrollLockService` pins the document under full-screen sheets. Full-screen modal backdrops use
  `BottomChromeSafeDirective` (issue #367) so a tall dialog never renders its last content under the
  mini-player/tab bar — hardened with ResizeObserver/transitionend re-measure + a published
  `--bottom-chrome-inset` CSS var, and a canonical bounded-panel recipe (`m-auto`, never
  `items-center`, `max-h` off the var) that variable-height modals must pair with it
  (`measureBottomChromeInset` is the one shared chrome-measuring entry point). →
  [docs/design-patterns.md](docs/design-patterns.md)
- **Page & section idioms (issue #384)**: every routed page inside the app shell has root
  `page-shell max-w-(6xl|3xl|2xl)` (browse/reading/settings-forms — criteria table in the doc;
  pre-auth full-screen shells like login/setup/pair/server-config are exempt); grouped pages share
  `SettingsGroupComponent` cards, tables use `section-flush`, headings `page-title`/`section-title`;
  `page-shell.spec.ts` is the drift guard. → [docs/web-ui.md](docs/web-ui.md) "Page & section idioms"
- **Catalog (metadata-driven) search**: `CatalogService` returns artist/album cards from
  Lidarr/MusicBrainz, scoped to the matched artist, resolving into album-hunt (typed 404 +
  raw-network fallback for absent compilations). On a catalog miss (`ALBUM_NOT_IN_LIDARR`), the
  fallback now opens the **folder-first network lane for the exact clicked album** with a clear
  "download from folders" CTA; loading the full discography (which auto-adds the artist to Lidarr)
  is **opt-in** via a banner button (`browseFallbackDiscography`), no longer an automatic dump. →
  [docs/album-hunt.md](docs/album-hunt.md)
- **Album hunt**: `AlbumHunterService` skewed queries + diacritic scoring + two-phase progress;
  blended "Other sources" + per-track fallback when 0 folders found. The skew builder
  (`buildSkewedQueries`/`buildTrackQueries`, now in shared **`@nicotind/core` `hunt-queries.ts`** —
  one source for API + web, killing the old two-copy sync risk) emits **faithful literal variants**
  (accent-fold, punctuation-strip, distinctive-tokens, reorder, qualifier-strip) that bypass slskd's
  exact-phrase soft ban/cache while staying precise; the imprecise last-char artist truncation was
  dropped. **`matchPct` is recall-only by design** (its three consumers — `acquireAlbum`'s
  `minMatchPct`, the watchlist `AUTO_THRESHOLD`, the user-facing `14/14`— all ask "is the whole album
  here?"), so it can't distinguish a clean rip from a whole-discography dump containing every track:
  both score 100%, and the final tiebreaker (total folder size) **actively preferred the dump**
  (issue #271, prod `album_job` 463 = 254 files enqueued for a 14-track album; the source of #262's
  "233 unavailable"). `compareCandidates` now demotes `isBloatedFolder` candidates (>`BLOAT_RATIO`×
  track count in *audio* files — cue/scans and deluxe editions untouched) right after the match
  bucket and **ahead of peer health** (bloat is a property of the match, not the peer), and
  tiebreaks on **per-track** rather than total size ("better rip" was always the intent).
  Demotion never a filter — a dump may be the only source, and is safe to pick because #262's
  `filesForCanonicalTracks` scopes the enqueue. → [docs/album-hunt.md](docs/album-hunt.md)
- **Watchlist auto-hunt**: star catalog albums; a poller auto-hunts + downloads on a confident
  match. → [docs/album-hunt.md](docs/album-hunt.md)
- **Generation feedback → TDD fixtures (dev golden-dataset)**: capture whether a
  _generated/inferred_ output was right, from real usage, and replay each graded case as a
  regression test. v1 targets the **album-hunt recognizer**: `searchAndScore` is split into a pure
  `scoreFolders(canonicalTracks, rawResponses)` (the replay seam) + `search` (I/O); `huntBase` now
  returns the raw slskd responses. An admin with a dev-mode toggle
  (`user_settings.feedback_capture`, Settings → Developer) gets a throttled 👍/👎 toast after a hunt
  renders (`FeedbackService.shouldPrompt`); the `hunt/base` route snapshots
  `{proposal(+MBIDs), rawResponses, scored candidates}` into a pending `generation_feedback` row
  (`captureHuntMatchFeedback`, admin+toggle-gated) and returns its `feedbackId`. 👍 = top pick
  correct; 👎 opens `FeedbackDetailSheetComponent` to mark the actually-correct folder (or "none") +
  note → `PATCH /api/feedback/:id` (admin, `resolveFeedback`). `scripts/feedback-to-fixtures.ts`
  exports graded rows (`huntFixtureFromRecord`) into `services/__fixtures__/hunt-match/*.json`;
  `album-hunter.replay.test.ts` re-runs `scoreFolders` offline and asserts the human-correct folder
  ranks #1 (red/green loop for recognizer "smart linking"). Generic `resourceType` reserves
  radio/playlist/library/search for later. →
  [docs/generation-feedback.md](docs/generation-feedback.md)
- **Auto-acquisition loop (opt-in)**: a default-off poller sweeps Lidarr's `wanted/missing` list and
  auto-acquires each album through the shared `acquireAlbum` core (same hunt/select/enqueue/fallback
  guards as the watchlist poller + interactive hunt), so it's idempotent and re-entrant. →
  [docs/auto-acquisition-plan.md](docs/auto-acquisition-plan.md)
- **Spotify metadata fallback (via spotDL)**: metadata-only lane that hands a `spotify.com/album`
  URL to `/api/acquire`; the `spotify` plugin gates it. The user's **Spotify Client ID/Secret**
  (entered once on the spotify extension card) is the single source of truth: `SpotdlPlugin` reads
  it live via `PluginRegistry.getConfig('spotify')` and forwards it as
  `SPOTIPY_CLIENT_ID`/`SPOTIPY_CLIENT_SECRET` on spawn (omitted when absent), so spotDL uses the
  user's own rate limits for better metadata matches; a hint under the spotdl card points there
  (`data-testid="spotdl-uses-spotify-credentials"`). For audio quality, `run()` passes
  `--bitrate disable` so the source stream is copied without a second lossy re-encode. →
  [docs/spotify-fallback.md](docs/spotify-fallback.md)
- **Idempotent hunt — one album = one download**: 409 guards + only-missing-tracks enqueue; "already
  have it" outcomes surface as positive notices, not red errors. →
  [docs/album-hunt.md](docs/album-hunt.md)
- **Duplicate prevention**: FLAC>MP3 + auto-dedupe + edition-collapsing album IDs + cross-edition
  folder consolidation at ingest. The **cross-peer fallback no longer creates the duplicates in the
  first place (issue #264)**: `sweep` splits `missing` (the true gap, still what closes a job) from
  `recoverable` (`missing` minus everything in flight from any peer), and only ever acts on the
  latter — so a wave can't start while a previous wave is still moving bytes for the same titles,
  and no fallback attempt is burned waiting. Overtaking a peer is gated on **byte progress**
  (`isStalled`, `stallThresholdMs` default 120 s), not on "the next sweep happened", so a dead peer
  is still abandoned quickly. Clearing a download now actually removes it from slskd
  (`cancel(..., {remove:true})` + the bulk `removeCompleted()`), with `hidden_transfers` demoted to a
  pruned fallback for the removals slskd refuses (issue #265). →
  [docs/download-pipeline.md](docs/download-pipeline.md), [docs/album-hunt.md](docs/album-hunt.md)
- **Lossless → Opus standardization**: lossless downloads transcoded to Opus in place (default-on
  192 kbps) + a library migration path; detection is codec-aware (`isLosslessFile` probes .m4a for
  ALAC, which browsers can't decode); gated on ffmpeg. The env/YAML-only config is exposed read-only
  via `GET /api/settings/downloads` so the **acquire flow shows an accurate reminder** (Results
  header note + per-row "→ Opus Nk" chip on lossless picks), gated on `enabled && ffmpegAvailable`
  so it never claims a transcode that won't run for a lossy pick. →
  [docs/download-pipeline.md](docs/download-pipeline.md)
- **Album deletion**: `DELETE /api/library/albums/:id` is folder-first `rmSync` + synchronous
  canonical-row delete + orphan-aggregate prune; every delete route debounce-schedules an slskd
  share rescan (`ShareRescanScheduler`) so a removed file stops being advertised to peers. →
  [docs/download-pipeline.md](docs/download-pipeline.md)
- **Library quality auditor**: assert (audit) + clean (repair/retag) + prevent (ingest sanitize) for
  DJ-pool/VA-source pollution across DB + disk. → [docs/library-audit.md](docs/library-audit.md)
- **Downloading albums suppressed from listing**: listings exclude albums with active `album_jobs`
  or in-flight transfers via an SQL `WHERE` exclusion. →
  [docs/design-patterns.md](docs/design-patterns.md)
- **Standardized library metadata filters**: one shared `LibraryFilter` (BPM/Camelot
  key/mood/perceptual buckets/year/genre/starred/duration) filters the four library tabs + the
  library **Songs** tab + artist Songs tab server-side; song properties match albums/artists via
  any-track `EXISTS`, state lives in URL query params. →
  [docs/library-filters.md](docs/library-filters.md)
- **Library "Songs" tab (whole-library flat listing)**: `GET /api/library/songs` (clone of
  `/artists/:id/songs` sans the artist predicate) backs a first-class Library tab — newest-first
  default, shared `LibraryFilter` + sort, `TrackRowComponent` + full `SongMenuService` menu,
  `createSelection()` multi-select (play/queue/playlist/save-offline/admin-delete). Replaced the
  Downloads "Recently Added" tab. **Offline** (`SetupService.isOffline()`) it swaps its source to
  `PreserveService.preservedTracks` (client-side search/sort + storage bar + Clear all, backend-free
  row menu), and Library is reachable offline (the removed Downloads "Saved Offline" tab's role
  moved here). → [docs/web-ui.md](docs/web-ui.md)
- **Auto-preserve queue (PWA lock-screen resilience)**: `AutoPreserveCoordinator` (ships in every
  environment — effectively a no-op while mode is "off") watches the player queue and keeps the
  next-N tracks as IndexedDB blobs (configurable Off / 5 / 20 / full, per-device localStorage) so
  playback survives the browser's locked-screen network throttle; `source: 'user' | 'auto'` +
  `evictAutoLRU` ensures radio churn never evicts user-saved tracks. →
  [docs/web-ui.md](docs/web-ui.md)
- **Reactive network / offline detection (fixes Android offline-launch ANR)**:
  `NetworkStatusService` is one live `online` signal (`@capacitor/network` on native via
  `getCapacitorPlugin`, `navigator.onLine` + window events on web); `SetupService.isOffline` becomes
  a `computed` (`!online || serverUnreachable`) so the library source swap, nav gating, redirect +
  the app-shell offline banner (inline in `layout.component.html`, `data-testid="offline-banner"`)
  all react to connectivity flips **both ways** with no reload, and `check()` skips the boot HTTP
  probe when already offline (kills the multi-second blank-screen boot behind the ANR). **The native
  seed is async**, so `check()` first `await`s `NetworkStatusService.whenReady()` (bounded by
  `NETWORK_SEED_TIMEOUT_MS`) — otherwise `online()` is still its optimistic `true` when `check()`
  runs and the offline fast path is silently skipped, so an offline Android launch still blocked on
  the 3 s probe (the ANR persisted despite the fast path existing). **The switch is automatic both
  ways mid-session too**: the interceptor reports status-0 API failures → `reportServerFailure()`
  verification-probes before flipping offline (never on one flaky request); once unreachable a
  `SERVER_RECOVERY_POLL_MS` poll + an instant device-reconnect re-probe + the interceptor's
  success signal (`reportServerSuccess` — any 2xx `/api` response while flagged unreachable heals
  offline mode instantly, issue #372) restore online mode without
  a reload, and the boot `refreshToken` chain (`refreshSession`) is deferred until after `check()` —
  offline keeps the stored session, and the first return to online runs the deferred refresh
  (autoplay suppressed). Native
  Sentry drops Session Replay + tracing (release-only ANR suspect; `loadSentry` also
  try/catch-wrapped at its call site); mid-use hardening = player skips a doomed offline stream (toast, not infinite
  spinner), `preserveCollection` swallows offline fetch rejects, GET requests get a 30s interceptor
  timeout. → [docs/mobile-app.md](docs/mobile-app.md), [docs/web-ui.md](docs/web-ui.md),
  [docs/observability.md](docs/observability.md)
- **Untracked downloads**: `relative_path IS NULL` rows are backfilled by a script; listed at
  `GET /api/library/untracked` (admin). → [docs/download-pipeline.md](docs/download-pipeline.md)
- **URL acquisition (yt-dlp / spotdl / archive)**: `POST /api/acquire` routes a URL to an enabled
  `resolve`-capable plugin → the same organizer + scan pipeline; entered via a link-intent card in
  the search omnibox (merged with search, no separate URL box); idempotent submit reuses an
  in-flight job for the same URL, a truncated result (fewer files than the source reported) still
  finishes `done` but carries a warning + Retry instead of reading as an unqualified success,
  tagless sources (archive.org streams raw bytes with no ID3) return a `ResolveResult`
  (`{ paths, meta }`) so `ingest` threads the item's artist/album onto `jobMeta` (else the organizer
  drops them in `<dataDir>/unsorted` outside the music dir while the job falsely reads "done") and a
  job that files nothing is marked `done` **with a warning** rather than a clean success,
  restart-orphaned jobs are failed at boot (never stuck "running"), Retry on any truncated acquire
  job resumes the same job id/staging dir instead of re-downloading from scratch (spotdl
  additionally passes `--overwrite skip` on top of that generic mechanism), and YouTube's bot-check
  is mitigated by Deno + the bgutil PO-token sidecar + optional `<dataDir>/youtube-cookies.txt`
  cookies. → [docs/download-pipeline.md](docs/download-pipeline.md),
  [docs/source-agnostic-acquisition.md](docs/source-agnostic-acquisition.md)
- **Playlist-from-acquisition**: a URL acquire job classified as a playlist (Spotify
  `/playlist/<id>`, YouTube `/playlist`, YouTube `watch?v=…&list=…`, archive.org with `as=playlist`)
  auto-generates a per-user native playlist from the landed tracks in download order after the
  post-ingest pipeline — the Downloads card then offers an "Open playlist" deep-link straight to
  `/library/playlists/<id>`. Archive items expose a UI toggle (`as= 'playlist'`); Spotify/YouTube
  auto-detect via `classifyAcquireUrl`. Per-track `acquire_job_tracks` rows (`recordAcquireJobTrack`
  upserts keyed job_id+title; the FULL `TrackEvent` incl. `path` must cross the
  `onTrack`→`emitTrack` seam — dropping it there silently disables generation) resolve by basename
  **stem** (survives the Opus transcode) with an `"Artist - "`-stripping title fallback (spotdl is
  title-only); only landed tracks make it in, and a retry refreshes the same playlist in place
  instead of duplicating. → [docs/playlist-from-acquisition.md](docs/playlist-from-acquisition.md)
- **Download list metadata**: `GET /api/downloads` annotates in-flight folders matching `album_jobs`
  with album-job info; a completed acquire job's `destinationAlbums` disambiguates which album(s) it
  actually landed in. → [docs/download-pipeline.md](docs/download-pipeline.md) → "Multi-album
  acquire jobs"
- **Unified acquisition jobs**: every download (hunt/auto-acquire/direct/track-search/URL) is
  wrapped in an `acquisition_jobs` row whose transfer↔job linkage (`username::filename` keys) is
  stored at enqueue time — never re-derived by folder-string matching; items repoint in place on
  fallback re-pulls, and a job closes as an honest partial when remaining tracks are unobtainable.
  **Lifecycle hygiene (issue #262)**: `markItemsScanned` only sees the current scan batch's paths, so
  an item organized by any *other* batch was never revisited and stranded its job at
  `active/scanning` forever (prod: 20 of 28 stranded items already had a `library_songs` row at their
  exact path). `reconcileOrganizedItems` re-resolves them on every hygiene pass, ahead of the 24h
  idle valve so a landed file is rescued rather than written off; both it and `markItemsScanned`
  match `COLLATE NOCASE` (organizer-recorded path vs scanner-minted casing) — and because NOCASE
  folds **ASCII case only, never diacritics**, a miss now falls back to an **accent-folded**
  comparison (core `fold()`, built lazily only after an exact miss): prod had a job stuck 23 h with
  four items whose files were present all along as `Auténticos` vs the recorded `Autenticos`, which
  the idle valve would have written off as a false partial. The nonsense
  "7 of 240 · 233 unavailable" tally was a peer folder holding a whole discography — 254 files
  enqueued for a 14-track album — now scoped by `filesForCanonicalTracks` at both enqueue sites
  (conservative: no tracklist, or no match, passes files through unchanged).
  **Direct grabs get a real "where" post-scan (issue #223)**: a raw peer/single-file grab has only
  noisy folder-segment artist/album guesses, so `backfillDirectJobAlbum` (watcher scan seam,
  `kind='direct'` only) re-points the job to the **canonical** album its file landed in
  (`song_id`→`library_songs.album_id`→`library_albums`), so the feed row + "Open in Library"
  deep-link resolve. → [docs/acquisition-jobs.md](docs/acquisition-jobs.md)
- **Unified downloads feed — one job = one card (issue #261)**: slskd groups + URL acquire jobs both
  adapt into a normalized `DownloadItem` with method/stage badges, a "View N albums" menu for
  multi-album jobs, and a "Now: / Next:" current-track display. Card identity is the **`jobId` the
  server recorded at enqueue time** (shipped on `AlbumJobMeta`), not a key re-derived from `albumId`
  at read time — the re-derivation is why one hunt kept splitting into several cards (prod: one Luis
  Fonsi job rendering as five). `collapseJobMembers` folds a job's peer folders into one card with a
  `Sources (N)` disclosure fed by `listJobFeed`'s new `sources[]`; transfers matching no job collapse
  into a single `collapseUnlinked` "Unlinked transfers" row instead of N loose cards. Two *separate*
  jobs for the same album now correctly stay two cards. The Downloads header also shows a **disk-availability pill**
  (`used / total`, green→red fill) fed by `GET /api/system/disk` (statfs of the music dir). →
  [docs/download-pipeline.md](docs/download-pipeline.md) → "Now: / Next: track display",
  [docs/web-ui.md](docs/web-ui.md)
- **Acquisition provenance (how/where/when)**: the `acquisitions` side-table records
  method/source/time at download time; surfaced per track. →
  [docs/download-pipeline.md](docs/download-pipeline.md)
- **Plugin architecture (acquisition as opt-in plugins)**: kind-agnostic kernel + `PluginRegistry`;
  acquisition is default-off; plugins = slskd/yt-dlp/spotdl/archive/spotify/lrclib/discogs; `auth`
  kind planned for OAuth. Config saves re-init the running plugin live; yt-dlp/spotdl probe/spawn
  with an augmented PATH (`acquireEnv`: bundled-ffmpeg dir + brew/pip bins — GUI apps inherit a
  minimal PATH) + an admin-editable `binaryPath` field; embedded slskd auto-shares the music dir
  (merge-preserving `slskd.yml` regeneration). UI labelled **Extensions**, one section per kind
  (Acquisition / Metadata / Connectivity) — each a collapsible `SettingsGroupComponent` card
  (groupIds `plugins-acquisition`/`plugins-metadata`/`plugins-connectivity`), and each plugin itself
  a collapsible `PluginCardComponent` (header row — name, one unified derived status pill
  off/needs-config/unavailable/ready, Enable/Disable — always visible; description/capabilities/
  config form behind the card's own toggle), and Connectivity hides itself when empty — the web
  `PluginKind` union mirrors the core one and a kind missing from **either** renders its plugins
  nowhere. Extensions with bespoke config no longer get a separate route: slskd's settings
  (`SlskdSettingsComponent`, connection/shares/live status, shows a not-reachable notice when slskd
  is down) are embedded inline in its own card body once expanded, so its ~3s status poll only runs
  while that card is open (`/settings/plugins/slskd` now just redirects to `/settings/plugins`). All
  first-party plugins are constructed in `registerBuiltinPlugins`
  (`services/plugins/builtin.ts`), not inline in `index.ts`, so cross-plugin construction deps
  (spotdl reading spotify's creds) are covered by a test. → [docs/plugins.md](docs/plugins.md)
- **Discogs metadata plugin (genre + artist-info)**: `metadata`-kind, default-off + consent-gated
  plugin (`services/plugins/discogs/`) that resolves release genres/styles from Discogs (strong on
  Latin/regional/pre-2000/DJ-pool — the residual gap #187's MusicBrainz couldn't close). `client.ts`
  (auth via Consumer Key+Secret, on-disk cache, one shared **55/min** token bucket honoring
  `X-Discogs-Ratelimit-Remaining`, injected `fetchFn`/`clock`/`sleep`) + pure `matching.ts`
  (**MBID-first** via `parseDiscogsRef` on MusicBrainz's discogs url-relation → **corroborated name
  search** `selectBestRelease`, artist+album both required, rejecting the same-name "Emilia AR/SE"
  false match) wired into a core `genre` `GenreCapability` (`fetchGenres`, release-scoped — **no
  artist scope** per #187 finding 3, **MBID-only** query, **no `confidence:1.0`** shortcut). **Genre
  enrichment wired (#194, gate #191 PASSED at 72% of the residual gap)**: the album-scoped
  `genre-discogs` enrichment task (`services/genre-discogs.ts`) runs over songs the Lidarr `genre`
  task left genre-less, groups them by album, and writes gated `library_genre_overrides`
  (`source='discogs'`, applied ≥0.8 else pending) — the #187 A1 **second** provider, reusing the
  A1/A3 write path; a confident match is applied inline (mirrors `genre-audio`), an outage (throw)
  never ledgers the album, and it's never a landing gate + off by default. Discogs'
  comma/slash-bearing top-level vocab (`Folk, World, & Country`) is mapped to separator-free
  canonical genres (`discogs-genre-vocab.ts`) inside the plugin before it can shatter `splitGenres`;
  ids generalize into `library_external_ids` (not a third per-provider table). **Flagship Larralde
  case stays unresolved** (measured — Discogs had no corroborated release; remains #187 A2's to
  fix). → [docs/discogs-plugin.md](docs/discogs-plugin.md)
- **spotDL inherits the Spotify plugin's credentials**: `SpotdlPlugin` reads
  `plugins.getConfig('spotify')` live at spawn time and forwards the Client ID/Secret as
  `SPOTIPY_CLIENT_ID` / `SPOTIPY_CLIENT_SECRET` env vars, raising spotDL's Spotify rate limits over
  its built-in shared client (better metadata matches → higher-quality YouTube audio). One source of
  truth — the user enters the key in the spotify card once; the spotdl card has no creds field and
  shows a one-line hint pointing at the spotify card. →
  [docs/spotify-fallback.md](docs/spotify-fallback.md)
- **Quality chip on download cards ("· 320 kbps" / "FLAC · 1411 kbps")**: every `DownloadItem`
  carries an optional `bitrateKbps` + `audioFormat` rendered as a small inline chip next to the
  method badge (`data-testid="download-bitrate"`). slskd captures `SlskdFile.bitRate` at enqueue →
  `acquisition_job_items.bit_rate_kbps`; URL-acquire jobs are ffprobed post-plugin-finish via
  `AcquireWatcher.ingest`. Both upgrade post-scan: the route's `enrichWithBitrate`
  (`routes/downloads.ts`) joins `library_songs.bit_rate` so a downloaded FLAC shows 192 kbps Opus
  once the lossless→opus transcode has run. The pure `formatQuality()` helper
  (`lib/download-status.ts`) renders `"FLAC · 1411 kbps"` for lossless codecs, `"320 kbps"` for
  lossy; missing both → chip hidden. → [docs/download-pipeline.md](docs/download-pipeline.md) →
  "Quality chip"
- **Admin/Settings/Extensions decoupling**: core Settings = universal prefs only; server-admin tools
  (streaming, library processing, find-duplicates) live in **Admin**; slskd owns its
  connection/shares + a Nicotine+-style live status panel (`GET /api/plugins/slskd/status`,
  `SlskdStatus`), embedded inline in its own collapsible Extensions card rather than a dedicated
  route. Credential storage unchanged (UI relocation only). →
  [docs/admin-settings-decoupling.md](docs/admin-settings-decoupling.md)
- **Settings-cards unification (`SettingsGroupComponent`, all five settings-family views)**: one
  bordered, collapsible card (`packages/web/src/app/components/settings-group/`) generalized from
  the Admin-only `AdminGroupComponent` (renamed, no longer a repo symbol) now backs **every**
  group on `/settings`, `/admin`, `/settings/plugins` (incl. each `PluginCardComponent`'s own
  collapsible body), `/settings/devices`, and `/settings/agent-tokens` — collapsed by default
  everywhere, no exceptions (Devices' pairing panel mints its code on first expand via the
  `opened` output rather than an eager `defaultOpen`) — and persisted per-device
  (`lib/group-state.ts`, `localStorage` key `nicotind-group-<id>`, cleared on signout via
  `AuthService.resetSession()`). Admin's 8 groups (System Health / Library Processing / Library
  Maintenance / Streaming & Media / Backups & Data / Acquisition & Automation / User Management /
  Audit Log — the old 14-panel "System" mega-section dissolved across them) were the first
  consumer. `tests/settings-consistency.spec.ts` (CI) is the cross-view gate that every route
  renders fully collapsed on load with identical computed styles;
  `tests/settings-gallery.screens.ts` (out-of-CI, `playwright.screenshots.config.ts`) captures a
  collapsed + expanded shot of every route in mobile and desktop viewports for human review. →
  [docs/design-patterns.md](docs/design-patterns.md) "SettingsGroupComponent",
  [docs/admin-settings-decoupling.md](docs/admin-settings-decoupling.md)
- **Changelog modal**: build-time `CHANGELOG.md` → `changelog.json` (capped at 50 versions); version
  string in header/settings is clickable. `CHANGELOG.md` is also the source for the **GitHub Release
  description** — the `release-notes` job in `deploy.yml` extracts the tag's section into the
  Release body. → [docs/web-ui.md](docs/web-ui.md)
- **Manual PWA update check (frequent releases)**: a Settings → Account **"Check for updates"**
  button (`data-testid="settings-check-update"`) calls `SwUpdate.checkForUpdate()` via
  `UpdateService.checkForUpdate()` and surfaces the outcome through `ToastService`
  (disabled/re-entrant = `unavailable`, silent no-op — the button is hidden without a SW and can't
  be double-clicked; `up-to-date` = success, `available` = info with a Reload action wired to
  `applyUpdate()`, error = red toast). The existing **reload banner** (`UpdateBannerComponent`)
  keeps its job as the universal install CTA once `VERSION_READY` arrives; the manual control is
  just the user-trigger. `ngsw-bypass` already gates every `/api/stream/*` URL so the SW never
  intercepts audio; **see [docs/web-ui.md](docs/web-ui.md) "Manual PWA update check" for the design
  history (3 alternatives considered) + the parity matrix across PWA / Electron (`electron-updater`,
  apply-on-Linux / notify-on-macOS) / Capacitor Android/TV (in-app APK self-update from GitHub
  releases: the same button checks `releases/latest` via the shared `compareVersions`, and the
  `NicotindApkUpdate` plugin downloads the flavor-matched `NicotinD[-TV]-<v>.apk` and opens the
  system installer — `packages/capacitor-apk-update/`) / Capacitor iOS (no OTA — IPA
  reinstallation).**
- **ServiceReview (one resource, one polling lifecycle)**: `GET /api/admin/review` (admin-only, one
  round-trip) replaces the Admin page's prior N independent loaders (`systemStatus`, `scanStatus`,
  `updateCheck`, `backups`, `auditLog`, `processing` summary, `incompleteJobs`/`untracked` tables) —
  `ServiceReviewService` owns one `setInterval(5s)` (Page-Visibility-paused, ref-counted) so every
  Admin sub-section consumes a `computed()` slice from one snapshot; the new CPU/GPU/RAM
  `app-metric-pill` row at the top of System drains from this same signal; sub-fetch failures
  degrade one field + log to `errors[]`, never drop the resource. Slices are gathered **by name**
  via `allNamed()` (`Promise.all` over an object), never destructured positionally — a same-typed
  swap (`incompleteJobsCount`/`untrackedCount` are both `number`) used to type-check cleanly and
  yield a wrong panel, and adding a slice is now two edits rather than three in lockstep (#274). →
  [docs/design-patterns.md](docs/design-patterns.md) "ServiceReview".
- **Unified song listings**: one `TrackRowComponent` + one root `SongMenuService.build(song, ctx)`
  build every song's `⋯` menu (common actions guaranteed, contextual via `SongContext`); Remove
  routes through `ConfirmService`→`deleteSongs`→`deletedSongIds()` (no per-page prune); "Song info"
  opens a global `TrackInfoService` host; multiselect is one `createSelection()` +
  `SelectionBarComponent` everywhere (incl. the library Songs tab). →
  [docs/song-actions.md](docs/song-actions.md)
- **Orphan side-table pruning (issue #259)**: per-song side tables deliberately have **no FK
  cascade** (a rescan rebuilds `library_songs` wholesale, so a cascade would wipe curator data), which
  left orphan rows accumulating forever. Measuring prod first dissolved the apparent tension: the
  curator tables (genres/artists/overrides) have **zero** orphans — the scanner rebuilds them — while
  the *regenerable* ones do grow (1,057 orphan embeddings = 5.16 MB; embeddings are 46% of the DB).
  `services/orphan-prune.ts` therefore prunes only `library_embeddings` +
  `library_song_analysis_failures` (never `library_lyrics` — network-sourced + user-editable), via
  **mark→unmark→sweep** on an `orphaned_at` column with a 30-day grace, so a delete-then-re-download
  still restores the cached embedding. Daily off the backup's processor-tick hook; aborts on an empty
  library and skips any table over a 50% orphan ratio. Counts surface via `GET /api/admin/review`
  `orphanRows` → an Admin panel row (hidden at zero). **`scan_cache` joins them (issue #313)** — the
  first **path**-keyed entry (`OrphanTable.references`), and the one table where an orphan is
  *provably* unreachable since the lookup is by path; `saveScanCache` also clears `orphaned_at` on
  upsert so correctness doesn't depend on unmark-before-sweep. **`acquisitions` joins them too
  (issue #319)** — the product call ("should provenance outlive the deleted file?") landed on
  **prune**, since an orphaned provenance row has no per-track surface and 3,696 of 14,580 live songs
  already carry none. It is safe because `repointOrphanedAcquisitions` runs *first* in the daily pass
  and *recovers* the 17 of 4,586 orphans that are the **only** surviving provenance for a still-live
  song (file replaced by a different-format copy, `opus → mp3` dominating) — stem-unique **and**
  target-has-no-row, since a wrong re-point is worse than missing provenance — so only
  genuinely-deleted rows reach the 30-day sweep. →
  [docs/cache-invalidation.md](docs/cache-invalidation.md)
- **Playlist membership survives a song-id change**: ids are `sha1(path)`, so any move re-mints one
  and the scanner's prune deleted the row out from under every playlist referencing it — silently,
  since reads `INNER JOIN library_songs` (prod: 17 dangling rows across 11 user playlists).
  `repointPlaylistsBeforePrune` runs **inside the prune, before the delete** — `playlist_songs`
  stores only `song_id`, so after the delete nothing identifies the entry and repair is impossible.
  Matches on a **unique** `(title, artist, duration)`; ambiguity is left to dangle because a wrong
  re-point puts the wrong song in someone's playlist (measured: ~96% unique, 3.6% ambiguous, 248
  title+artist pairs where duration is the discriminator). →
  [docs/cache-invalidation.md](docs/cache-invalidation.md)
- **Cover-cache eviction (issue #311)**: the cache had **none** — prod measured 3.6 GB, the largest
  data-dir consumer. `pruneCoverCache` (daily tick, `NICOTIND_COVER_CACHE_PRUNE=off`) sweeps
  entity-keyed files whose row is gone, with #259's grace period so a delete-then-re-download keeps
  its cover. **Only entity-keyed keys**: `c_`/`r_` keys are content-addressed with no owning row, and
  counting them as orphans inflated a first measurement to 51 %/2.3 GB (real figure: 28 %/1.6 GB).
  Prod dry-run reclaims 1,566 MB. → [docs/cache-invalidation.md](docs/cache-invalidation.md)
- **Cache-invalidation on library mutations (issue #237 audit)**: every `LibraryApiService` write
  whose server handler mutates `library_artists`/`library_genres` must
  `tap(() => invalidateLibraryReads())` on success or the cached Artists grid / Genres tab replays
  the stale list for the 30 s TTL (the #210 shape). Audited all mutations; added the missing
  invalidation to `applyGenre`/`applyMetadata`/`deleteSongs`/`deleteAlbum`/`resyncLibrary` (joining
  `setArtistGenre`/`clearArtistGenre`/`fixArtistIdentity`);
  artist-image/cover/lyrics/licence/reclassify/optimize writes correctly don't (id-stable `coverArt`
  or no list impact). The **full cross-layer sweep is now catalogued** in
  [docs/cache-invalidation.md](docs/cache-invalidation.md) — every cache/memo with its writer set,
  plus the structural findings that rule whole classes out (no `dataGroups` ⇒ the SW never caches an
  API response; per-song side tables deliberately skip FK cascades so a rescan can't wipe curator
  data, and dangling rows are invisible because playlist reads `INNER JOIN library_songs`;
  `noArtCache` has a complete `clearCoverNegativeCache` writer set) and the "adding a cache"
  checklist (content-address > short TTL > explicit invalidation). →
  [docs/cache-invalidation.md](docs/cache-invalidation.md), [docs/web-ui.md](docs/web-ui.md)
- **We build the YouTube PO-token provider (issue #238)**: the `bgutil-provider` companion was a
  third-party image whose tag had to be hand-synced with the pip plugin baked into ours; it is now
  `ghcr.io/kevinch3/nicotind-pot-provider`, built by a `docker-pot-provider` job mirroring
  `docker-analysis`, from **pinned upstream source** (`packages/pot-provider/Dockerfile`, GPL-3.0 ⊂
  AGPL-3.0-only) rather than vendored. `check:bgutil-pin` now compares two files **we** control
  instead of one third-party tag. Verified end-to-end — a "starts but mints invalid tokens" provider
  is the exact silent failure the issue exists to prevent — by minting a real PO token against
  YouTube's live attestation endpoint. →
  [docs/deployment.md](docs/deployment.md) "We build the PO-token provider ourselves"
- **Published Docker image (deployment)**: multi-arch GHCR image (`release`/`vX`/`vX.Y.Z` tags, no
  `latest`) published per release tag via native-runner digest builds + one manifest merge; compose
  pulls it (build-from-source is an override), the deploy host pulls too, `/api/health` reports the
  running version, and a ci.yml `docker` job (compose lint + conditional image build) gates
  releases. The ci.yml `release` job that cuts those tags is **orphan-tag-proof**: atomic
  `--follow-tags` push (a rejected branch update rejects the tag too) + self-healing orphan
  detection (a `vX` tag not reachable from master is deleted + re-cut, never silently skipped) —
  fixes the 2026-07-23 freeze where a non-atomic push orphaned `v0.1.244` and wedged every release
  behind a green-but-silent "already published" skip. **The workflow's own
  `cancel-in-progress` concurrency guard no longer cancels itself (issue
  #360)**: it's scoped off for `master` pushes, since the `release` job's
  version-bump commit is itself a push to `master` that used to retrigger a
  run in the same group and cancel the originating (already-succeeded) run
  out from under itself. → [docs/deployment.md](docs/deployment.md)
- **Measure prod before building (`prod-probe.ts`)**: several issues ask for a prod measurement
  first and it repeatedly **changed** the fix rather than confirming it (#262's stated root cause was
  wrong; #259's retention tension dissolved; #271's threshold was calibrated off 462 real jobs) — but
  every probe was a throwaway that re-derived the same boilerplate. `packages/api/src/scripts/prod-probe.ts`
  (dev-only, sibling of `dump-radio.ts`/`check-fragments.ts`) owns it: `--orphans`/`--jobs`/`--transfers`/`--sql`.
  **Two independent safety layers** — the connection is `{readonly:true}` with no override (the real
  enforcement, asserted in tests), and `assertReadOnlySql` is the legible second layer (single
  statement, SELECT/WITH/PRAGMA only, no assigning PRAGMA). Its ordering is load-bearing: comments
  stripped **before** the leading-keyword check (else `-- SELECT\nDELETE` reads as a SELECT) and
  string literals blanked **before** the keyword scan (else `title = 'update me'` is refused). The
  probe's table list is deliberately **wider** than the pruner's — measuring a table you'd never
  prune is what validates the policy. Writes belong on a `VACUUM INTO` copy, never the live file. →
  [docs/prod-inspection.md](docs/prod-inspection.md)
- **Additive schema migrations (`addColumnIfMissing`)**: `applySchema` runs every boot, so it must
  be idempotent — but the 38 `try { ALTER … ADD COLUMN } catch {}` blocks that said so swallowed a
  **genuine** migration error (typo'd type, bad default) exactly as silently as the expected
  duplicate-column case. The helper checks `PRAGMA table_info`, making "already there" a *condition*
  so a real bug throws loudly at boot (issue #275); it **returns whether it added**, so the two
  one-time backfills stay gated on the add rather than re-scanning the table every boot. Additive
  columns only — the 3 table-`RENAME` rebuilds are deliberately untouched, and there is no
  down-migration path by design. → [docs/design-patterns.md](docs/design-patterns.md)
- **OSS best-practices roadmap**: prioritized adoption plan of Immich/Home-Assistant practices
  (backup/restore, safe mode, watchdog + health taxonomy, retention, update check, audit log,
  community files). → [docs/oss-best-practices.md](docs/oss-best-practices.md)
- **Daily backups (HA model, scoped)**: `VACUUM INTO` DB snapshot + secrets into
  `<dataDir>/backups`, once per day ≥04:00 via a marker-guarded processor-tick hook (independent of
  processing enabled), pruned to newest N (`NICOTIND_BACKUP*` envs); admin list/trigger routes +
  Admin "Back up now" block; restore is a documented manual swap. →
  [docs/backup-restore.md](docs/backup-restore.md)
- **Config export/import (portable, host migration)**: `GET`/`POST /api/admin/config/{export,import}`
  emit + apply a JSON bundle of the **14 config tables** — a table qualifies iff its rows encode a
  **human decision or a credential** (settings/plugins/users/playlists/watchlist/genre+artist
  aliases+overrides+identity/metadata overrides); library rows are excluded because a rescan rebuilds
  them. Columns **and** primary keys are read from `PRAGMA table_info` at runtime, never hardcoded —
  five of the fourteen have a non-obvious PK (`library_genre_overrides` is `(scope,key)`,
  `library_artist_aliases` is `alias_norm`, …). Secrets are redacted unless `?secrets=1`, and a
  redacted bundle **skips blanked columns on update** so it can't wipe working credentials. Import is
  **additive-merge only** (replace would delete the target's users on a wrong-bundle import),
  always dry-run-previewed through the *same* reconciliation code as the apply, one transaction, with
  a non-key constraint collision counted as `skip` rather than fatal. Distinct from the daily DB
  backup (whole-DB, same-host recovery). → [docs/config-export.md](docs/config-export.md)
- **Admin audit log**: `audit_log` table + `recordAudit` called explicitly at destructive mutation
  sites (single/bulk song delete, album delete, artist identity, user management) — never a
  blanket middleware; `GET /api/admin/audit` + Admin "Audit log" table; ledger failures never
  break the audited action. **Single-song delete was a gap** (issue #336) — the deletion-extraction
  refactor for #232 preserved it faithfully rather than silently changing audit semantics as a
  side effect; now closed with the same `targetKind`/`targetId`/`detail` shape as album delete.
  → [docs/roles.md](docs/roles.md) "Audit log"
- **Server update check + version history**: daily cached GitHub-releases poll (marker-guarded, 1h
  failure backoff, `NICOTIND_UPDATE_CHECK=off`; scheduled from main.ts — never the processor tick,
  so unit tests can't hit the network) behind `GET /api/admin/update-check` (+`?refresh=1`),
  rendered as the Admin "Server: vX / Update available" row; `version_history` records every version
  ever booted. → [docs/deployment.md](docs/deployment.md) "Update check"
- **Dependency management (updates + held majors + automation)**: `bun outdated --filter '*'` drives
  manual bumps; CI (typecheck/lint/test/e2e/web-build/docker/desktop-smoke) is the gate. Two majors
  are **deliberately held** by peer constraints — `typescript` 6→7 (Angular `compiler-cli` peers
  TS 6) and `@capacitor/*` 6→8 (`@jofr/capacitor-media-session` still peers `@capacitor/core@^6`);
  the Python sidecar's `nvidia-cu11==`/`numpy<2`/essentia pins are deliberate ABI locks. Update
  automation is un-configured but feasible — Renovate recommended (Bun-lockfile + monorepo
  grouping + custom managers for the actionlint pin / pyproject / Dockerfiles), `chore(deps)`
  commits don't trip the release job. →
  [docs/dependency-management.md](docs/dependency-management.md)

## Web UI

Angular v22 standalone SPA with signals, `HttpClient` + interceptors, and lazy-loaded routes. Built
via `ng build` (esbuild); tests run on **plain vitest**, never `ng test` (which forbids the
`vi.mock` five specs rely on — see docs/web-ui.md "Web test harness"). Three type-check surfaces,
none of which covers the others: `tsc --build` (app + packages), `typecheck:web-spec` (specs, which
`tsconfig.app.json` excludes), and `typecheck:template` (**Angular templates** via `ngc` — `tsc`
never sees a binding expression, so this was "green locally, red at `ng build`" until issue #273
folded it into `bun run typecheck`). The HTTP surface is split into per-domain
stateless services under `services/api/` (`Auth`/`Search`/`Library`/`Downloads`/`System`/`Playlists`
ApiService + shared `api-types.ts`) — inject the specific one; there is no monolithic `ApiService`.
→ See [docs/web-ui.md](docs/web-ui.md) for theme system, Angular patterns, and component
conventions.

**i18n (issue #236)**: runtime JSON, one build — `public/i18n/<lang>.json` (`en` is the base +
source of truth), `TranslateService` + `{{ 'key' | t }}`, lookup falling through active → base →
the key itself so a partial translation shows English rather than raw keys. Chosen over
`@angular/localize` because that is compile-time (N builds/locale) and this build is shared by PWA
+ Capacitor + Electron. **The pipe is `pure: false` by measurement**: a pure pipe memoizes on its
args, so a language switch never re-invokes `transform` and the UI keeps the old language — the
spec asserts the switch reaches the DOM. Language is **per-device** (localStorage), because login /
setup / share render before any user exists. Converted so far: login page + Settings picker + app
shell (navs/offline) + library tabs/sort + home vibes + the **Acquire page** primary copy
(`acquire.*`) + **Player/Now-Playing/Settings** (`player.*`/`nowPlaying.*`/`settings.*` — the phase-2
high-traffic slice, incl. the first TS-side `this.i18n.t(key, params)` call sites for toasts/dialogs
built outside a template) + **Devices/remote-access settings** (issue #338, `devices.*` — the
pairing panel, paired-devices list, and the admin Tailscale Funnel state machine; a shared
`common.backToSettings` key was added for the "← Settings" back-link reused by still-untranslated
`agent-tokens`/`plugins` pages) + **onboarding/setup wizard** (`setup.*`, all five wizard steps,
plus `common.back`/`common.next`) + **Admin panel** (issue #338, `admin.*` — 215 keys, every
section; `processingTaskDefs` moved from a pre-translated `label` to a `labelKey` so the task list
stays reactive to a live language switch, matching the rest of the page) + **Acquire's Advanced
disclosure** (issue #338, the raw Soulseek folder-browser section — closes the #338 long tail;
deliberately leaves the shared `getFolderBtn`/`getSongBtn`/`getGroupFileBtn` download-status-label
helpers untranslated since they're used by other components, not scoped to this one page); **es.json
is at full parity** with the base. Extraction is a phased pass — **API
error `code` fields (issue #337, client mapping started)**: `NicotinDError`'s existing `code` extended
onto the inline `c.json({ error })` responses in `routes/auth.ts`/`devices.ts`/`settings.ts`/
`agent-tokens.ts` — additive `{ error, code }`, the ~24 other route files untouched. The web client
now maps the subset of codes whose English message is stable across every call site
(`lib/http-error.ts` `ERROR_CODE_I18N_KEYS` + `errorMessageForCode`/`httpErrorMessageI18n`) —
generic per-site-varying codes (`VALIDATION_ERROR`/`FORBIDDEN`/`NOT_FOUND`/…) intentionally still
fall through to the raw server string. Converted: login/register, the `/pair` claim flow
(`claimPairing` now throws `PairingClaimError` carrying `code`), and `auth.interceptor.ts`'s
force-logout check, which used to string-match the English `error` body and is now on the stable
`code` instead. → [docs/i18n.md](docs/i18n.md)
**Bundle budget**: `angular.json` carried the untouched Angular scaffold defaults (500 kB/1 MB), so
the build warned on every run and the next real regression was invisible. Measured before deciding
(issue #256): initial is 735 kB **raw** but **188 kB transfer**, and **42 % is Sentry** — eager on
purpose (`main.ts` inits it before `bootstrapApplication` to catch startup failures; prod ships a
hardcoded DSN), so deferring it is a product trade, not cleanup. Budget raised to a number the
project stands behind (780 kB, verified it still fires), `qrcode` made lazy (devices chunk 38.9 →
14 kB), and its CJS bailout declared via `allowedCommonJsDependencies` — the build is now
warning-free. → [docs/web-ui.md](docs/web-ui.md) "Bundle size budget"

## Mobile app (Capacitor Android + iOS)

`packages/mobile` is a thin **Capacitor** shell that wraps the **same** `@nicotind/web` Angular
build (no second UI codebase). The enabler is a runtime-configurable API base URL
(`ServerConfigService` + a native-only server-picker + `nativeAppCors()`). Background audio +
lock-screen controls come from `@jofr/capacitor-media-session` on Android and an iOS-only
`@nicotind/capacitor-now-playing` Swift plugin (owns `MPNowPlayingInfoCenter` + `AVAudioSession` +
transport). Android/iOS artifacts are built by tag-only best-effort CI jobs in `deploy.yml`. **The Android APK also supports sideloaded Android TV use, listed on the TV home launcher**
(manifest `LEANBACK_LAUNCHER` + a disc+wordmark banner rendered deterministically via opentype.js
paths + optional leanback/touchscreen/camera features, locked in by `android-manifest.test.ts`; a
`tv` Angular build configuration — shipped by CI as a second `NicotinD-TV-<version>.apk` —
defaulting remote-control opt-in on, releasing ArrowLeft/Right to the WebView's spatial D-pad
navigation instead of the seek shortcut, insetting content into the TV overscan safe area via
`applyTvBuildClass` + the `html.tv-build` styles, and swapping Now Playing for a dedicated 10-foot
player — blurred-cover backdrop, bottom-pinned glass transport without shuffle/repeat, Next-up chip
— driven by `isTvUi()` (the root class, e2e-testable via `now-playing-tv.spec.ts`); a roving-tabindex D-pad
navigation directive pair — vertical/horizontal/grid axes — covers the Now Playing queue,
transport controls, every Library/Search/artist-detail grid, every `TrackRowComponent`-based song
list, and Settings/Admin/Extensions button/toggle rows (forms stay Tab-order-only by design),
plus a global keyboard shortcut set (Space/K play-pause, J/L prev/next, M mute, N now-playing, arrow-key seek that defers to D-pad nav groups, `/` for Acquire — Escape-as-back is a deliberately deferred follow-up given the modal-arbitration work it needs). The `@nicotind/capacitor-tv-channels` plugin owns the Google TV launcher surface: a Watch Next "Continue listening" entry for the current track, a "Recently added" preview-channel row of the newest albums whose tiles deep-link into the app via a sanitized route extra (issue #395, `publishChannel`/`clearChannel` + the retained `deepLink` event), and the Assistant's play-from-search voice intent. → See [docs/mobile-app.md](docs/mobile-app.md) and
[docs/ios-app.md](docs/ios-app.md).

## Desktop app (Electron)

`packages/desktop` wraps the **same** backend (`src/main.ts` + workspace packages) and the **same**
`@nicotind/web` build as everywhere else; Electron supervises the backend as a local Bun child
process ("sidecar", `electron/sidecar.ts`) via handshake+health-checked spawn/restart (env
`NICOTIND_MODE=external` — no slskd/Lidarr in v1), and the renderer loads `http://127.0.0.1:<port>`
(same-origin, no `file://`). The user picks a local music folder via a native dialog (onboarding +
Settings, through one shared `services/native/native-capabilities.ts` interface both Electron and
Capacitor implement); the desktop owns the musicDir preference (`electron/desktop-config.ts`) since
the backend only holds it in-memory, and the onboarding wizard's final step **restarts the sidecar**
so the boot-time-captured musicDir (organizer/scanner) matches the pick — first-session acquisitions
would otherwise land in `~/Music`. Packaging (`electron-builder.yml` +
`scripts/prepare-resources.ts`) ships the backend as unbundled source + a production `bun install` +
a standalone `bun`/`ffmpeg` binary ("Variant B" — `bun build --compile` breaks pino-pretty's
`require.resolve`), staged to exactly the paths `electron/paths.ts` resolves in prod; targets
AppImage/deb (Linux) + **ad-hoc-signed** dmg (macOS — never `identity: null`; unsigned arm64 = "app
is damaged"), with `electron-updater` auto-update (apply on Linux, notify-only on macOS until
Developer-ID signing). → [docs/desktop-app.md](docs/desktop-app.md)

- **Per-platform chrome + tray (desktop only)**: macOS uses `titleBarStyle: 'hiddenInset'` (keeps
  native traffic lights); Linux/Win use `frame: false, titleBarStyle: 'hidden'` with the Angular
  `<header>` (`packages/web/src/app/components/layout/`) repurposed as the in-app window-drag region
  via `[-webkit-app-region: drag]`, with a shared `DesktopWindowControlsComponent` (min/max/close)
  on the right and a fallback overlay title bar (`DesktopTitleBarOverlayComponent`) on routes
  outside the shell (setup/login/server/share — else first-run is undraggable/unclosable); close →
  hide-to-tray on Linux via the pure `shouldHideOnClose` (music continues in the background —
  `electron/tray.ts`); the shared `quitting` flag in `main.ts` keeps tray Quit and `app.before-quit`
  on the same code path. The icon pack is the PWA set staged by `scripts/stage-icons.mjs` (`ffmpeg`
  resize, no new deps) into `electron-builder.yml`'s `build/icons/` **and** by
  `prepare-resources.ts` into `resources/icons/` for runtime window/tray lookups. →
  [docs/desktop-app.md](docs/desktop-app.md) "Per-platform window chrome + tray"

## End-to-end tests

`packages/e2e` is a Playwright suite that boots the real server against a throwaway DB + silent-FLAC
fixtures and drives the SPA in Chromium (auth, library, playback, player controls, plugin capability
gating). Acquisition is default-off so no slskd/Lidarr is needed. Selectors are `data-testid`
attributes — **adding a `data-testid` is the standard for new e2e-targeted elements**. **Before
writing a spec, check docs/e2e.md "What the e2e environment does NOT give you"** (the Playwright
`request` fixture is unauthenticated — log in + `bearer(token)` explicitly; no resolve plugin is
enabled on a fresh server — capability-gated UI needs the spec to enable one). **The web bundle is
built automatically** at config-eval time (`ensureWebBuild()`) — Hono serves the *prebuilt*
`packages/web/dist` with no dev server or watch, so the suite used to silently test the previous
bundle and report pre-fix behaviour as the actual value (issue #253); `E2E_SKIP_BUILD=1` is the
fast path, and `E2E_BASE_URL` never builds. CI is split: `ci.yml`
runs `ci` + `e2e` then a `release` job tags `vX.Y.Z`; that tag triggers `deploy.yml`. A gated
**playground harness** (`PLAYGROUND=1`), the mutating **real round-trip** (`PLAYGROUND_REAL=1`), and
**screenshot flows** are all out of CI. **The README's 3 locally-capturable screenshots refresh with
one command** (`bun run --filter @nicotind/e2e screens:readme`, docs/e2e.md "Screenshot flows") — run
it and commit any changed `docs/images/*.png` whenever a UI change touches the Library/album/Now-Playing
screens. The flow catalogue + recurring routines live in
[docs/testing-routines.md](docs/testing-routines.md). → See [docs/e2e.md](docs/e2e.md).

**Real-use feedback log**: [docs/feedback-log-2026-07.md](docs/feedback-log-2026-07.md) is a
rolling, dated log of friction noticed while actually _using_ the app — one entry per observation
with Severity/Status. Rotate monthly.

## Configuration

Config is loaded from `config/default.yml`, overridden by environment variables. See `.env.example`
for all options. Key vars: `SOULSEEK_USERNAME`, `SOULSEEK_PASSWORD`, `NICOTIND_MODE`,
`NICOTIND_MUSIC_DIR`.
