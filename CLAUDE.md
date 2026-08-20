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

2. **Every test must run in CI.** `bun run verify` runs every gate the CI **gate jobs**
   (`ci` + `web-test` + `storybook` — see `GATE_JOBS`) run, in one
   command — **use it before pushing** rather than remembering the list. It is kept honest by
   `check:ci-parity`, which fails when any gate job gains a step `verify` doesn't reach **or
   stops blocking `release`** (a gate that isn't in `release`'s `needs` is advisory — the #457
   shape): the
   web-spec typecheck was CI-only for months, so a spec could drift from the type it asserts
   against with every local gate green (that is the third instance of this exact class, after
   #273 and #376). `bun run e2e` is deliberately *not* in `verify` — it is its own CI job and takes
   minutes; run it before declaring a feature done, per the rest of this gate.
   Adding a test locally is not enough. Verify the relevant GitHub
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

NicotinD is a unified music acquisition + streaming platform. Acquisition sources are external,
Torrentio-style **addons** (the **slskd** Soulseek addon is the first — it lives in its own repo and
core carries zero slskd code, talking to it over the acquisition addon protocol); NicotinD
**natively scans/streams** the music library itself (Navidrome was removed — see Architecture).
Downloads land in a shared folder;
the DownloadWatcher organizes and incrementally scans completed transfers into the canonical SQLite
library that the API streams from. URL-based acquisition (yt-dlp / spotdl) feeds the same pipeline.

## Commands

```bash
bun install              # Install all workspace dependencies
bun run verify           # EVERY gate the CI gate jobs run, in one command — run this before pushing
bun run typecheck        # TypeScript type checking (tsc --build + Angular templates + e2e + web specs)
bun run lint             # ESLint across all packages
bun run check:claude-md  # fail on CLAUDE.md symbols that don't exist / broken docs links (CI gate)
bun run check:ci-parity  # fail when a gate job runs a check `verify` doesn't, or doesn't block release (CI gate)
bun run check:route-auth # fail when an /api route group is mounted with no auth decision (CI gate)
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
bun run e2e:tv           # Android TV emulator lane (real APK on an AVD) — D-pad/focus + WebView-only risk
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
commits, and creates a git tag. Full pipeline detail (what each tag ships, manual overrides) →
[docs/releasing.md](docs/releasing.md).

## Architecture

```
NicotinD (Hono API :8484)  — native library scanner + streaming, all in-process
└── slskd addon (:8585, opt-in profile) ── slskd (Soulseek client :5030)
        AddonJobPoller (HTTP fetch) → LibraryOrganizer → LibraryScanner (tags → SQLite)
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
| `@nicotind/addon-sdk`       | Published npm SDK: acquisition addon protocol v1 DTOs/schemas + hunt-query helpers + logger for building addons     |
| `@nicotind/service-manager` | Strategy pattern for managing sub-service lifecycle (child_process or Docker) — Lidarr only since the slskd split    |
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
  (`albumIdsByGroupKey`). A **loose single never keeps a `Various Artists` album artist** (issue
  #593): when a track with no usable album collapses into its own single release, `resolveTags`
  adopts the already-resolved track artist — a single has exactly one performer by construction,
  so VA there means only that the *source* tagged a playlist. Prod had 34 of 34 review-queue
  albums as one-track VA releases (all one spotdl Spotify-playlist job; the files really do carry
  `ALBUMARTIST=Various Artists`/`ALBUM=Unknown`, so core was mapping faithfully) with the real
  performer stranded and unreachable from the Artists grid, which filters VA out. Real multi-track
  compilations carry an album name and stay under VA. →
  [docs/library-scanner.md](docs/library-scanner.md)
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
- **Artist origin / nationality (standard metadata)**: `library_artist_origins` (MB-first via
  `library_mbids`, TTL tombstones, `source='user'` permanent, carried by `carryArtistCuration`);
  core `origin.ts` = ISO vocab + musical-cultural regions + `originCloseness`; a weight-8 radio
  axis with `MISSING_ORIGIN_FLOOR`, a `LibraryFilter.countries` filter (`unknown` bucket), recipe
  `countries`, and an artist-page flag line with curator edit
  (`PUT /api/library/artists/:id/origin`, null = user tombstone). →
  [docs/artist-origin.md](docs/artist-origin.md)
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
  **Range handling is RFC 9110-complete**: `serveFileWithRange` serves suffix ranges
  (`bytes=-N` = the **last** N bytes) correctly — it used to hand back the *head* of the file under
  a mismatched Content-Range, which stalled iOS Safari's tail-probing media loader forever (the
  iPhone-PWA "metadata loads, song never finishes loading" bug; masked when auto-preserve was on,
  since that path is a range-less `fetch()`). **Transcode cache integrity** (size-in-key, 1 KiB
  size floor, ffprobe post-check +
  `-xerror`/`+discardcorrupt`/`-err_detect explode`, in-use pin during pruning released via a
  grace timer (`schedulePinRelease` — the old release-at-stream-end body wrapper made Bun drop
  `Content-Length` and emit a chunked 206, which Firefox *and* iOS Safari stall on; the Blob body
  must reach Bun untouched, and a real-socket wire suite in `streaming.test.ts` pins that),
  plus a **negative cache** for permanently-unusable sources —
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
  chain** (`artist-image-providers.ts` `buildArtistImageProviders` → `lidarr → spotify → discogs`, each
  provider self-contained so the Lidarr `db` coupling never leaks; the Discogs seat (issue #422)
  bridges the plugin kernel's new `artist-image` capability via `makePluginArtistImageLookup`
  (MBID-only, never a name search), and the web's "Fetch automatically" menu entry is
  **availability-gated** by the live `GET /api/library/artist-image/sources` — disabled when no
  source could serve a portrait;
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
  (admin), the Admin "Check fragmentation" button — **now actionable in-app (issue #314)**: each
  defect row carries its remediation (duplicate clusters → per-spelling merge via the existing
  identity route; hidden rows → reclassify/unhide/two-click delete; mis-split clusters → a
  preview-then-select `fragment-remediation.ts` flow that writes a unified `ALBUMARTIST` into the
  selected files' tags via two new curator routes, then rescans) — and `scripts/check-fragments.ts` (CLI gate — its `expandHome` copy returned `''` for absolute
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
  historical octave errors are repaired by `analyze-bpm.ts --recheck`. The drawer also has a
  curator-gated **AcoustID fingerprint identify + apply** (`services/identify.ts` shared with the
  review inbox; `buildIdentifyApplyTags` echoes the approved suggestion, never clears tags) for a
  file whose tags are wrong or missing. →
  [docs/library-scanner.md](docs/library-scanner.md),
  [docs/library-processing.md](docs/library-processing.md),
  [docs/download-review.md](docs/download-review.md)
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
  `/analyze`, the one caller that should count as activity. **The mirror bug (issue #539)**: once
  release fired, `/health` reported the idle-dropped state `status:"unavailable"` — same as a boot
  load failure — so the API's health gate skipped every task and the reloading `/analyze` never came
  (livelock: "configured but unreachable" forever on kpc). `RegistryHolder.can_serve()` now backs
  `/health`: cold-but-reloadable reports `status:"ok", loaded:false`; `"unavailable"` is reserved
  for the never-loaded-at-boot case. **The 7.6 GB is now actually fixed (issue #605)**, and the
  "TF just never releases" framing above was only half the story: measuring VRAM after each
  individual inference showed EffNet + its 8 heads sit at 2,233 MiB and **one** predictor,
  `TensorflowPredictMusiCNN`, adds **5.4 GB** to emit a 216×200 array feeding only valence. Bounding
  it via `musicnn_batch_size()` (`ANALYSIS_MUSICNN_BATCH_SIZE`, default **4** — the memory sweet spot
  *and* the fastest measured; 0/-1 rejected because they are Essentia's accumulate-every-patch
  sentinels) takes the idle footprint **7,631 → 2,235 MiB**, freeing ~5.4 GB and making the card
  genuinely shareable, with bit-identical feature output. EffNet cannot follow: its graph is the
  published *bs64* variant with 64 baked into a `Reshape`, so 2,233 MiB is the floor. The
  once-promising `TF_GPU_ALLOCATOR=cuda_malloc_async` lever was measured on `kpc` and **segfaults the
  sidecar at boot** (`Failed to create session: Internal: No allocator statistics`, exit 139); it
  stays commented out in `docker-compose.gpu.yml` as a warning, not a suggestion. →
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
  `GET /api/admin/processing/queue`. **A deep link into the window explains itself (issue #466)**:
  `GET /albums/:id` still 404s a quarantined album but now carries `code: 'ALBUM_PROCESSING'` vs
  `ALBUM_NOT_FOUND`, and the album page classifies it via the pure `albumLoadFailureFor`
  (`processing`/`missing`/`unavailable`) instead of `catch {}`-ing every failure into one
  "Album not found." — the Downloads "Open in Library" link appears exactly when the album is
  quarantined (prod: >24 h for 7,195 of 14,974 songs). → [docs/library-processing.md](docs/library-processing.md),
  [docs/download-pipeline.md](docs/download-pipeline.md)
- **Download inbox triage (hold-for-review, issue #411)**: opt-in `holdForReview` processing setting
  holds quarantined downloads until curator approval in the Downloads inbox; `download_reviews`
  decision table (pending = derived), multi-source metadata candidates + AcoustID identify + per-track
  retag + an **Apply MusicBrainz titles** action (issue #413 — MB is the only source with a per-track
  tracklist; position-matched, titles-only, fills the grid without saving). **Identify failures are
  typed (issue #414)** — `no-match` / `fpcalc-missing` / `undecodable` (with the fpcalc stderr tail) /
  `source-error` / `file-missing` ask for opposite curator actions, so they render as a per-track
  error chip instead of one generic toast. **Inert while acquisition is off (issue #416)** — the
  inbox lives on the hidden Downloads page, so the landing gate ANDs in live `acquisitionEnabled`
  and the admin route denies enabling the hold; the same change extracted the path-safety triad into
  `services/song-path.ts` and Lucene-escaped `searchReleaseGroups`. **Bulk sweep + mobile
  layout (issue #592)**: `review-approve-all`/`review-discard-all` in the section header, both
  `ConfirmService`-gated with the count named, fanning out over the *existing* per-album routes
  (each already audited — per-album granularity beats one route's atomicity for a destructive
  mass action) sequentially, never aborting on a failure; the card stacks `flex-col … sm:flex-row`
  because the `shrink-0` action row's ~300px minimum overflowed a 360px viewport and clipped
  Discard out of reach. Its Approve button + done/skipped step badges use the shipped
  `.status-done`/`.status-error` filled pills — they were `bg-status-success` + `text-white`, a
  background utility that **never compiled** (issue #591), so on every light theme the primary
  action was white-on-white. →
  [docs/download-review.md](docs/download-review.md)
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
  the queue/lyrics choice is one per-device-persisted `activePanel` signal with `lyricsOpen`
  **derived** from it (issue #446: two independently-writable booleans drifted — entering karaoke
  fullscreen wrote the render flag directly, so the persisted panel disagreed with the screen and
  the next launch restored the wrong one; `setActivePanel` is now the single writer and also exits
  fullscreen when leaving lyrics, so the overlay can't outlive the panel behind it) —
  fullscreen defaults to a current+next-line-only auto-follow view (narrow-screen/TV friendly) with
  a wheel/touch-gesture browse mode for tap-to-seek; a centered styled empty state carries an inline
  Fetch button. Fetch is
  **reliable 1-click**: LRCLIB retries transient failures (404 stays no-match) and the route returns
  `502` for a source error vs `null` for a confident miss, so the first click doesn't
  false-negative. **Vocal mute** (`?vocals=off` → server-side ffmpeg center-channel cancellation
  `pan=stereo|c0=c0-c1|c1=c1-c0`) is a mic toggle in the karaoke overlay; it forces the transcode
  path even when transcoding is off and is cached as a separate `novox` transcode entry. It is a
  **center**-canceller, not a separator, so it also removes the kick/bass (measured −9.35 dB of
  sub-bass) and, because `c0`/`c1` are anti-phase by construction, collapses to **digital silence
  on any mono downmix** (issue #602). Replacing it with real ML separation is spiked, measured and
  scoped (issue #603): `anvuew/BS-RoFormer` (GPL-3.0 — the "Mini" alternative is CC-BY-NC and
  unusable), **on demand + opt-in, never precomputed**, GPU-only (P4000: RTF 0.261× / 3.0 GB, ~55 s
  per song, but progressive separation starts playback in ~6 s; CPU-only is RTF 4.1×). →
  [docs/design-patterns.md](docs/design-patterns.md),
  [docs/vocal-isolation-spike.md](docs/vocal-isolation-spike.md)
- **Unified search**: `GET /api/search?q=` blends local library + parallel slskd network results
  into the one source-agnostic results list. →
  [docs/source-agnostic-acquisition.md](docs/source-agnostic-acquisition.md)
- **Merged `/get` workspace (Acquire + Downloads, one nav item)**: "ask for music" and "watch it
  arrive" are halves of one job, so they're one route with an internal `?tab=find|downloads` instead
  of two top-level destinations. `GetComponent` is a **shell** — it owns the tab bar, the param and
  the badge, and mounts the untouched `SearchComponent`/`DownloadsComponent` as children. The `@if`
  (never `[hidden]`) is load-bearing: destroying the inactive tab is what unregisters its
  `PullToRefreshService` handler (a stack spliced on the registrant's destroy) and tears down
  `SearchComponent`'s result poll. Tab state lives in the **URL** (unlike Library's localStorage
  mode) because "show me my downloads" must be linkable; `/search`, `/acquire` and `/downloads` are
  kept as **function** `redirectTo`s (a string one can only *preserve* params, never *add* the
  `tab`). `acquireGuard` now covers the whole route, resolving the old asymmetry where `/downloads`
  was hard-gated but `/acquire` only soft-gated itself. Nav is four items — **Home · Library · Add ·
  Settings** — and the mobile bar's column count is derived from the visible tab count (it was a
  hardcoded `grid-cols-5` with a 4-item listener case); the mobile badge now counts acquire jobs too,
  matching desktop. Supersedes the #227 split, whose "find what I own" half is now the Library find
  bar below. → [docs/source-agnostic-acquisition.md](docs/source-agnostic-acquisition.md)
  "Unified search", [docs/web-ui.md](docs/web-ui.md) "The /get workspace"
- **Library cross-type find bar**: one box above the Library tabs searching **everything you own at
  once** — albums, artists, songs, grouped by type (`LibraryFindComponent`, its own file because
  `library.component.ts` is already 759 lines / 7 tabs). A non-empty query **replaces** the tab
  content (`browseMode()` goes null) rather than filtering the active tab: feedback-log #7 was a user
  whose album and tracks both existed but who was looking at the wrong result type, and a per-tab
  filter reproduces that by construction. Debounced into `?find=` so a search is linkable; clearing
  restores the tab the user was on (`libraryMode` is never written). No matching of its own — the
  `/api/search` local lane already tokenizes, accent-folds and excludes quarantined rows. **No
  acquisition handoff** (deliberate: Library is a listening surface). Playlists are out of scope —
  `LibrarySearchProvider` returns `{artists, albums, songs}` only. The Songs-tab search box stays as
  a within-tab filter. → [docs/web-ui.md](docs/web-ui.md) "Library find bar"
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
  `analysis` only, dropping slskd/Lidarr (the bgutil provider left core entirely in #550); it needs
  *both* `profiles:` on those services and
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
  never sees a nonsensical "No Soulseek results" empty state for a source they don't have. The
  one-click Get (`AutoHuntService`) sends the addon `candidateRef` and self-heals across up to 3
  candidates on retriable enqueue failures, surfacing the server's reason on exhaustion (#530/#531
  — post-cutover it 400'd on every click with a generic toast and zero logs). →
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
- **WebMCP alignment (proposed — not yet implemented)**: our shipped MCP tool descriptor
  (name/description/inputSchema/handler → a `content` array) is already the shape Chrome's
  WebMCP `document.modelContext` registration takes, so `MCP_TOOLS` is a host-agnostic registry
  that today has one host. Plan: phase 1 extracts the registry contract + promotes
  `checkToolAccess` into one shared predicate and makes host exposure a **declared** field
  (default server-only, gated by a test that no destructive tool reaches a browser — the
  `check:route-auth` shape); phase 2 adds a flagged, feature-detected browser host owning only
  **session** tools (playback/queue/likes and `startRadioWithFilter` over `LibraryFilter`,
  the differentiated one) since `/api/mcp` structurally can't reach the running player.
  Nothing destructive is ever browser-exposed — the refiner cap, the confirm gate and the
  audit ledger don't exist under a tab's ambient JWT. Chrome DevTools MCP is dev tooling, not
  a product surface; client-side WebGPU/WebNN stays NO-GO per
  [docs/client-side-ml-feasibility.md](docs/client-side-ml-feasibility.md). →
  [docs/webmcp-alignment.md](docs/webmcp-alignment.md)
- **Presence tracking + last connection (admin-only)**: in-memory `PresenceService` tracks
  `isConnected` / `amountOfDevices` / `amountOfSessions` per user via 60s HTTP heartbeats + stale
  cleanup; merged into `GET /api/admin/users` and ordered by `compareUsersByActivity` in JS, since
  SQL can't see the presence map. Session state stays ephemeral, but the *derived*
  `users.last_seen_at` **is** persisted (`touchLastSeen`, throttled to ≤1 write/user/5min, forced on
  login, best-effort like `agent_tokens.last_used_at`) — an in-memory map reports "never" for every
  user after each deploy, which is the one question an admin asks about a dormant account. The Admin
  users table is five columns with **nothing `hidden sm:table-cell`** (Online/Devices/Sessions folded
  into one Activity cell, Joined under the username), the role picker replaced the badge that
  duplicated it, and the rest sit behind a `⋯` `MenuPanelComponent`.
  → [docs/presence-tracking.md](docs/presence-tracking.md), [docs/roles.md](docs/roles.md)
- **Shared relative time (`lib/relative-time.ts`)**: one `timeAgo` for the Downloads feed + the Admin
  users table (`check:shared-helpers`-registered); the translator is an optional param so the module
  stays pure and an un-i18n'd caller keeps its English. → [docs/web-ui.md](docs/web-ui.md)
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
  **Filter-seeded radio / stations**: the same route also starts a mood/genre/bpm "vibe" with **no
  seed song** — a `LibraryFilter` (parsed from the shared serialize grammar) constrains the pool via
  `songFilterWheres`, seeded by its `seedCentroid`; `PlayerService.radioFilter` keeps auto-replenish
  in-vibe. `toOrderable` used to omit `genre`/`genres` entirely, so every filter-radio vibe scored
  genre-blind (issue #187 task B4, fixed); the centroid's modal key ("collapses to C major") was
  investigated and is a measured null result, not a bug — see docs/radio.md. **A *genre* station is
  graded, not tag-tested (formula v3)**: membership IS the filter, so the genre axis scored 1.0 for
  the whole pool and ~27% of the weight mass ordered nothing (an "Electronic" chip served Queen and
  Madonna beside Calvin Harris on bpm/energy alone); `services/station-affinity.ts`
  (`genreDepthScore` × `artistGenreShares` → `stationAffinity`) replaces the genre axis and reuses
  its weight — a demotion never an exclusion, and either signal can carry a track so a real
  electronic record by a mostly-pop artist still places. `buildFilterRadio` also **never called
  `loadEmbeddings`** (the #187 B4 shape again — the strongest axis in the v2 poll data was dark on
  every station), now loaded and scored against an affinity-weighted, trimmed `anchorCentroid`
  rather than the pool average, with the seed's genres taken from the **request** instead of the
  pool's modal primary (which inverts on an umbrella tag). Stations are also the first thing the
  eval polls can measure — `kind:'filter'` was schema-only and `evaluatePollAgreement` skipped it,
  so all 70 votes to date graded seed radio; `RadioPollSettings.filters` now generates one station
  scenario each. **Measured on prod and corrected (v4)**: v3's grading ordered the *pool* (widest-
  spread axis on 6 of 8 landing chips) but not the *served window* — its `SHARE_REFERENCE` ceiling
  gave full marks to any artist ≥50% of whose catalogue wears the tag, tying 23–74% of each pool at
  1.00, so the top 10 scored **sd 0.000** on 5 of 8 chips and was really ordered by key/origin. Raw
  share fixes it (ties 7–27%, sd non-zero on 8 of 8); the depth curve, `DEPTH_WEIGHT` and
  `ANCHOR_FRACTION` were measured **unfalsifiable on this library** (0–2 of 10) and deliberately not
  touched. `dump-radio.ts` now prints the served-window spread, the number that would have caught
  it. → [docs/radio.md](docs/radio.md) "Stations",
  [docs/measurements/radio-stations-2026-08.md](docs/measurements/radio-stations-2026-08.md). This backs the
  **radio/mood landing** (the post-login home route `''`, `pages/radio-landing/`): a last-track
  resume shortcut (disappears on tap) + one-tap vibe presets + top-genre chips; acquisition search
  moved to the `/get` Find tab. Shared scoring with `/songs/:id/similar`. **Recently-played demotion (P3)**: any candidate *this listener* played lately is demoted by
  `recentPlayPenalty` (0.2) × `recentPlayFactor` (linear decay, 1 = just played → 0 at
  `RECENT_PLAY_WINDOW_MS` 7d), applied **post-normalization beside `artistPenalty`, never as an
  `add()` axis** — every other feature is compared seed-vs-candidate, but play recency is a property
  of the candidate alone, so an axis would mean "prefer songs I've played as often as the seed".
  Because it never enters `weightAcc` it can't dilute the real axes. Sourced per-user from
  `play_events` via `lastPlayedAtMap` (a denormalized `library_songs` column was rejected — that
  table is global, so it would blend every user on a shared server), counting *every* event not just
  `counted=1` (a bailed-on track was still heard). A demotion, never an exclusion — a hard filter
  empties the pool on a small library. Surfaced in `dump-radio.ts`. `/api/radio` and
  `/api/catalog` were **mounted without the auth middleware** (issue #461 — radio returns library
  rows, catalog's `/discography` provisions a Lidarr artist), which made this inert; both are now
  gated and **`check:route-auth`** (a CI gate + `bun run verify` step) fails when any `/api` group is
  mounted without either `auth` or a reasoned `PUBLIC_ROUTES` entry, since forgetting that line makes
  a route public and nothing else complains. A **missing candidate genre is floored, not
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
  genre-blindness. **Formula v2 (issue #583, first human calibration)**: the first 70 poll votes
  showed v1 ordering its own top-5 worse than random (pairwise AUC 0.43) — junk genre tags
  (`isRealGenre`/`JUNK_GENRES`, e.g. "Other") no longer count as a genre match, the pool excludes
  sub-60s tracks (`minCandidateDurationSec`, env `NICOTIND_RADIO_MIN_DURATION` — e2e sets 0 for its
  30s fixtures), weights recalibrated (duration 1→3, bpm 8→4, embedding 4→8), and
  `RADIO_FORMULA_VERSION` is stamped onto every poll so the replay harness
  (`radio-poll-eval.ts` `evaluatePollAgreement` + `scripts/eval-radio-poll.ts`) never pools votes
  across formulas — see docs/radio.md "Calibration history" + the plain-language formula section. →
  [docs/radio.md](docs/radio.md), [docs/web-ui.md](docs/web-ui.md)
- **Radio evaluation polls (public, admin-created)**: an admin freezes N radio scenarios
  (seed + next-up snapshots incl. per-axis explanations — mandatory, the pool is
  `ORDER BY RANDOM()`) behind a public `/poll/:token` wizard; anonymous raters thumb each
  suggestion (previews via short-lived read-only share JWTs), `export-radio-poll.ts` distills
  consensus-graded datasets for weight tuning, polls are stamped with the generating
  `RADIO_FORMULA_VERSION` (`formula_version`), and `eval-radio-poll.ts` replays them into
  per-formula agreement AUC. → [docs/radio-eval-polls.md](docs/radio-eval-polls.md)
- **Remote playback (cast, Spotify-Connect-style)**: per-user `PlaybackStateManager` broadcasts
  state/commands over `GET /api/ws/playback`; each browser tab is a device. **A pruned device now
  heals (issue #433)**: `heartbeat` returns whether the device was known and `websocket.ts`
  re-registers when it wasn't — the client only sends `REGISTER` from `onopen`, which never fires
  again on a still-OPEN socket, so a routine 90s stale-prune (Android WebView throttles the 30s
  heartbeat timer behind a TV screensaver) used to remove the TV *permanently*; and `onClose`
  unregisters only if no other connection still holds that device id, since the client reuses one
  stable id across reconnects and a dead socket's late close was evicting the live one. →
  [docs/remote-playback.md](docs/remote-playback.md)
- **Hardware cast (Chromecast + DLNA, server-side controller)**: a `CastController` runs protocol
  adapters (`castv2`/`bonjour` for Chromecast, `node-ssdp`/`upnp-mediarenderer-client` for DLNA)
  server-side; any browser controls hardware via REST `/api/cast/*`; short-lived scoped
  `cast_tokens` authenticate the hardware's direct `GET /api/stream` fetches; the controller bridges
  hardware state into the existing WS `PlaybackStateManager` as a proxy device. No browser Cast SDK,
  no native mobile plugin, opt-in discovery with manual-IP fallback for Docker. →
  [docs/cast-integration.md](docs/cast-integration.md)
- **Service modes**: `embedded` (best-effort download/manage **Lidarr** — slskd left for its addon
  in phase 3/4, so this no longer spawns it) or `external`; the library/streaming stack is
  in-process. → [docs/design-patterns.md](docs/design-patterns.md)
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
  at a public HTTPS URL via `tailscale funnel` behind a guided admin state machine. **Settings →
  Devices now has the camera button (issue #434)**: the scanner existed but its only call site was
  the `/server` page, reachable from Settings behind a link labelled "Switch server" — nowhere a
  user looks to authorize a device. A `canScanBarcode()`-gated scan card feeds the pure
  `parseApproveCode` (accepts the TV's `/approve#c=…` link *and* the bare printed code, validated
  against the alphabet, `/pair` QRs rejected) and routes to `/approve#c=…` — the same entry point
  the OS camera app would open, so `ApproveLoginComponent` stays the one confirm-and-post site. The
  alphabet moved to `@nicotind/core` `pairing-code.ts` (`isPairingCodeShape`) so the minter and the
  validator can't drift; web reaches it through the `src/types/core.ts` shim, not core's barrel. →
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
- **Acquisition addon protocol (phases 0-4 shipped; the addon now lives in its own repo)**: Stremio/Torrentio-style
  open HTTP addon protocol; the slskd bridge **and** the hunt/retry/fallback engine migrate into a
  separately-distributed addon (in-monorepo sidecar first, own repo + image last), leaving core
  with zero slskd code; smart-addon/thin-core seam at `acquireAlbum` (guards core-side), HTTP file
  delivery into staging, feed continuity by mirroring addon job items into `acquisition_job_items`.
  **Shipped (issue #487)**: protocol v1 manage/observe surface (`types/addon.ts` DTOs +
  `validateAddonManifest`), `AddonClient`/`RemoteAddonPlugin`/`addon_registrations` +
  `loadRegisteredAddons` boot loading, admin register-by-URL routes on `/api/plugins`, the
  Extensions "Add addon" form + generic `AddonStatusPanelComponent`, and a fixture-addon e2e spec —
  a remote addon renders as a normal consent-gated extension card with zero addon-specific UI.
  **Shipped (issue #488)**: `packages/slskd-addon` — the hunt engine moved wholesale (api imports
  it back via path-preserving shims until phase 3), `normalizeTitle`/`titlesOverlap` promoted to
  core `title-match.ts`, the fallback's host touchpoints abstracted as `FallbackHost` (the addon
  implements it over its own `addon_jobs` ledger; the transitional api-side impl was dead once the
  hunt ran addon-side and was removed in the phase-4 decouple), the watcher's polling half extracted
  as `TransferPoller`, and the full
  protocol engine (search / albums/search with candidateRef / jobs with Idempotency-Key +
  wanted-track scoping / file delivery with ETag / browse / share-rescan notify) + Dockerfile.
  **Shipped (issue #489, the cutover spine)**: with a remote addon enabled, core speaks the
  protocol — `AddonSearchProvider` registers into `ProviderRegistry` (blended/raw/browse/enqueue
  lanes light up with zero route changes), `AddonJobPoller` mirrors addon jobs into the unified
  feed (`transfer_key` = `addon:<id>:<itemId>`, repoints are in-place upserts) and ingests
  fileReady completions over HTTP through the organize→scan pipeline, `acquireAlbum` runs its
  source half addon-side (guards stay core-side; the addon 409 is the in-flight guard), and an
  opt-in `slskd-addon` compose profile + the `addon-acquire.spec.ts` e2e loop cover it. #489
  closed complete (core has zero in-process slskd; soaked + deployed as v0.2.0 on kpc).
  **Phase 4a shipped**: the addon-facing subset of core is extracted into a publishable leaf
  package `@nicotind/addon-sdk` (`packages/addon-sdk`, deps `zod`+`pino` only — owns the plugin
  manifest contract, the v1 protocol DTOs/schemas/`negotiateCapabilities`, capability-risk copy,
  `hunt-queries`/`title-match`, and its own leaf logger); `@nicotind/core` keeps transparent
  re-export shims at every old path (one-directional core → addon-sdk, no cycle). **Phase 4b/4c
  shipped**: `slskd-client` was decoupled from core too (local slskd wire types), api dropped its
  vestigial `@nicotind/slskd-addon` dependency (the dead `fallback-host.ts` deleted; tests moved to
  local fixtures), and both `packages/slskd-addon` + `packages/slskd-client` were **deleted from the
  monorepo** — split via `git subtree` into the public `kevinch3/nicotind-slskd-addon` repo (own CI +
  published `ghcr.io/kevinch3/nicotind-slskd-addon` image), which the compose `slskd-addon` service
  now pulls. `@nicotind/addon-sdk` is published to **npm** (`@nicotind/addon-sdk@0.1.0`); core keeps
  only it. Remaining is the deploy-host re-migration onto the published image. →
  [docs/acquisition-addon-protocol.md](docs/acquisition-addon-protocol.md)
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
- **Privacy & data protection (issue #454)**: the listening log made this app hold real personal
  data, so it gets consent/access/erasure/retention rather than an assurance (`services/privacy.ts`,
  `/api/privacy`). Consent is **opt-out** with three levels resolved by the pure
  `resolveHistoryCollection` — env `NICOTIND_HISTORY=off` is a **hard floor an admin cannot lift**
  (mirrors #235), then an instance setting, then the user's own; `historyCollectionState` reports the
  *most restrictive* blocker so the UI explains rather than offering a control that does nothing.
  Enforced **server-side** in `POST /api/history/plays` (a stale client must not write history the
  user turned off) and the response carries the state so `ListeningQueueService` stops buffering
  instead of retrying refused events forever. `exportUserData` (Art. 15) reads columns from
  `PRAGMA table_info` at runtime so a schema change can't silently omit someone's data, redacts
  secret *values* (`agent_tokens.token_hash`) by an explicit list, and reports `skipped` tables.
  `deleteUserHistory` (Art. 17) is **scoped to `play_events`** and deliberately does **not** flip the
  consent flag — "forget what I listened to" ≠ "stop recording"; audit-logged with a count only, never
  the titles. Retention `history_retention_days` defaults to **0 = keep forever**, swept by
  `maybeRunDailyHistoryRetention` on the processor tick (marker-guarded like the backup/orphan/cover
  passes, no grace period, failures logged not swallowed). Settings → Privacy states what's stored in
  prose — including which third parties metadata lookups contact — because someone deciding whether
  to opt out shouldn't have to leave the app. **No admin route reads a user's history by design.**
  → [docs/privacy.md](docs/privacy.md)
- **Listening history (per-user play log)**: an append-only `play_events` row per playback session —
  the app had **no** play tracking at all before (`albumOrderBy('frequent')` fell back to
  `created DESC`; popularity's local play-count axis had no signal to build on). The client reports
  **raw facts** (`ListeningTrackerService` session lifecycle + pure `accumulate` counting only
  forward `timeupdate` motion under `MAX_DELTA_SEC`, so a seek accrues nothing) through a durable
  localStorage outbox (`ListeningQueueService`, flushed on session end / page-hidden / the
  `NetworkStatusService.reconnects` counter, so offline listening survives) into an **idempotent**
  batch `POST /api/history/plays`; the **server** owns the Last.fm counting rule (`countsAsPlay`:
  half the track or 4 min, 30 s floor) so it stays retunable — a client-side verdict would freeze the
  threshold forever. `GET /api/stream/:id` is deliberately **not** the signal (N Range hits per
  track, the 30 s gapless preload streams tracks that never play, preserved tracks play from
  IndexedDB and never hit it, share tokens attribute to the sharer). No FK on `song_id` *and* a
  `title`/`artist`/`album` snapshot on each event: ids are `sha1(path)` and re-mint on any
  move/retag, so a cascade would delete history on a rescan and an id-only row would vanish from a
  year review (the dangling-`playlist_songs` failure). Every player call site is gated on
  `isActiveDevice()` (a controller tab mirroring a remote device isn't a play) and repeat-one
  explicitly closes+reopens the session (it never changes `currentTrack`). Both endpoints take **no
  user id** — privacy is structural; admin sees only the `playEvents` row count (the measure-first
  hook for the keep-forever retention policy). Backs the "Recently played" shelf on the landing page
  and the Library **Stats** tab (`listeningStats` + `GET /api/history/stats?period=30d|year|all`,
  `LibraryStatsComponent`): totals, top songs/artists/albums/genres and a local-hour listening clock,
  all **derived at read time** (no rollup table — it would need invalidating by the still-open
  retention/erasure work). `year` is the *calendar* year, not a rolling 365 days (a rolling window
  mixes two years every January); an unknown `period` falls back to the default rather than 400ing;
  genres rank through `library_song_genres` not the primary-only `library_songs.genre`; deleted songs
  still count via the event snapshot; clock bars are percent-of-busiest-hour, since 24 shares of a
  total are unreadable. → [docs/listening-history.md](docs/listening-history.md)
- **Likes → auto-maintained "Liked Songs" playlist (issue #225)**: a per-user heart (track row
  `track-like`, track-info `track-info-like`, the `SongMenuService` menu's leading Like/Unlike, and
  — for quick interaction without a menu detour — the mini-player `player-like` and the Now Playing
  sheet's `now-playing-like`, both TV-aware; see docs/song-actions.md "On the player itself").
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
- **List loading skeletons**: one shape-matched `SkeletonComponent` (seven list variants) replaces the
  copy-pasted list spinner on every fetching list; a spinner now means only "an action you started is
  in progress". → [docs/web-ui.md](docs/web-ui.md) "List loading skeletons"
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
  renders — from **both** hunt paths via one shared `FeedbackService.promptForHunt` (issue #451: the
  `AutoHuntService` "Get" path, the one nearly every hunt takes, captured a row and never prompted,
  so prod graded 0 of ~39 captures; `shouldPrompt` also consumed the id before knowing the toast
  survived `ToastService`'s 3-countdown-toast drop, and is now a pure check paired with
  `markPrompted`). Because a 12 s toast is a lossy surface, the durable half is an **Admin →
  "Generation feedback" review queue** (`GET /api/feedback/summaries` — a lightweight projection,
  never `listFeedback`, whose `output_json` is 251 KB per real row — plus `GET /api/feedback/:id` for
  the grading sheet's candidates), and the pending TTL is **30 days**, not 24 h. The `hunt/base` route snapshots
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
- **Spotify metadata fallback (via the spotDL addon)**: metadata-only lane that hands a
  `spotify.com/album` URL to `/api/acquire`; the `spotify` metadata plugin gates finding the album,
  and the **external `nicotind-spotdl-addon`** (registered under Extensions) resolves the download.
  spotDL is no longer in-process (its former `SpotdlPlugin` was removed in the phase-4 spotdl
  cutover); the addon holds its **own optional Spotify Client ID/Secret** (`SPOTDL_ADDON_CLIENT_ID`/
  `SECRET` → `SPOTIPY_*` on spawn) rather than reaching into core's spotify plugin. It passes
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
  ALAC, which browsers can't decode); gated on ffmpeg; a strict-mode (`explode`) failure retries
  once leniently gated on the duration check, with the ffmpeg stderr tail in the error (#534 — a
  one-bad-frame rip used to stay FLAC forever behind an opaque "code 183"). The env/YAML-only config is exposed read-only
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
- **Import music from a folder or archive (internal/API-only)**: `LibraryImportService` runs a
  server-side folder **or `.zip`** through the same organize → scan → quarantine pipeline as a
  download (chunk-wise, copy-by-default with opt-in move under a disk-truth deletion rule,
  staging-copy mandatory because the organizer consumes its inputs); `kind='import'` mirror row in
  `acquisition_jobs` gives it a Downloads-feed card ("Imported" badge — unreachable until
  `methodForBackend` learned `'import'`), admin-only and deliberately independent of the acquisition
  kill-switch (streaming-only installs are the likeliest importers). **The Admin "Import music" card
  was removed** — import is an operator action, so `/api/admin/import` is the whole surface.
  Archives are read by a hand-rolled, dependency-free `import-archive.ts` over `node:zlib`:
  **central-directory-first** (only it is authoritative when a streaming zipper writes a data
  descriptor, and it yields the uncompressed total *before* inflating, which keeps the disk preflight
  honest and makes a bomb detectable up front), extraction streams **straight into staging** rather
  than a temp dir (no doubled peak disk), `safeArchivePath` guards traversal without flattening the
  album tree, symlink/encrypted/ZIP64/oversized entries are refused with typed codes, and move mode
  deletes the **archive** only once nothing was left unconsumed. →
  [docs/import.md](docs/import.md)
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
  `getCapacitorPlugin`, `navigator.onLine` + window events on web) **plus a monotonic `reconnects`
  counter**: the reconnect fast path must react to the connectivity *event*, not to a diff of
  `online` — signals coalesce, so a quick false→true pair flushes the effect once with only the
  final `true`, the edge is invisible, and the app sat offline for the full 20 s recovery poll
  despite a live network (a fast airplane-mode toggle is exactly that pair). `verify()` also
  *coalesces* a concurrent call instead of dropping it, so a reconnect racing an already-doomed
  in-flight probe still gets its answer. `SetupService.isOffline` becomes
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
- **URL acquisition (yt-dlp / spotdl / archive)**: `POST /api/acquire` routes a URL first to a
  `resolve`-capable **addon** via `resolveAddonForUrl` (the bundled **archive** addon —
  `services/addons/bundled/archive/`, an in-process `LocalAddonTransport` over the same
  `AddonJobPoller`/feed lane as external addons) or an **external** `resolve` addon selected by
  priority-ordered `urlPatterns` — **yt-dlp and spotdl are now external addons**
  (`nicotind-ytdlp-addon` = the `priority:-10` catch-all `^https?://` resolver; `nicotind-spotdl-addon`
  = `spotify.com` at default priority so it beats the catch-all; both own repos + published images,
  core carries no yt-dlp/spotdl code). Eagerly mirrors a
  `kind:url` `acquisition_jobs` row so the Downloads card shows in-flight at submit (#509 cause 2);
  no in-process `resolve` plugin remains. **What the split dropped**: both downloader
  addons spawn with `stdio: 'ignore'`, losing the playlist name, the expected track
  count (so a 1-of-16 download reports a clean `Done 1 of 1` — the truncation check
  compares against a total only the source knows) and per-track order; the parsers
  for all three moved to `@nicotind/addon-sdk` `downloader-output.ts` for the addons
  to adopt (core keeps shims; `DownloaderTrackEvent` avoids the DOM `TrackEvent`
  global). Core's half: `classifyAcquireUrl` was read only inside the retired
  `AcquireWatcher`, so every playlist URL reached the addon as `as: undefined` —
  `resolveAcquireAs` now owns that precedence for both lanes.
  The unified feed no longer blanket-skips
  `kind:url` (renders an addon url job like a network one, #509 cause 1). Both paths reach the same
  organizer + scan pipeline; entered via a link-intent card in
  the search omnibox (merged with search, no separate URL box); **idempotent submit reuses an
  in-flight job for the same URL on _both_ paths** — the watcher's `acquire_jobs` guard was the only
  one, so post-cutover every re-click of **Get** on a YouTube/Spotify link started another download
  (the addon branch had no guard, and `GET /api/acquire/jobs` read only `acquire_jobs`, so the link
  card never saw the job it had just started and kept the button armed — the Downloads tab, reading
  `acquisition_jobs`, was the only surface that showed it, which is what "the list fills in too
  late" was). Now: an additive `acquisition_jobs.source_url` records the pasted link (`source_ref`
  holds the `addon:<id>:<jobId>` poller key), `findInFlightAddonUrlJob` returns the running job as
  **200 `{reused:true}`** instead of a second one, the addon gets an `Idempotency-Key` of
  `url:<href>` (and its 409 reads as in-flight, not an error), `services/addon-url-jobs.ts`
  **projects** addon url jobs into `AcquireJob` for `/api/acquire/jobs` + `/jobs/:id`
  (cancel/delete/retry too) — a read-only projection, so the poller stays the only writer — and
  `mergeAcquisitionJobs` drops the acquire-lane twin of an `addon:`-ref'd url job so the feed still
  renders one card; web-side, `linkSubmitting` disables **Get** for the request round-trip, and
  `submitLinkIntent`/`retryLinkJob` **kick an immediate `TransferService.kickPoll()`** (issue #595
  — the feed's idle timer is 30s, so a pasted link bumped the nav badge, which reads the
  already-refreshed `acquire.activeJobs()`, while the Downloads card stayed half a minute stale;
  every other download-initiating site already kicked it). A
  truncated result (fewer files than the source reported) still
  finishes `done` but carries a warning + Retry instead of reading as an unqualified success,
  tagless sources (archive.org streams raw bytes with no ID3) return a `ResolveResult`
  (`{ paths, meta }`) so `ingest` threads the item's artist/album onto `jobMeta` (else the organizer
  drops them in `<dataDir>/unsorted` outside the music dir while the job falsely reads "done") and a
  job that files nothing is marked `done` **with a warning** rather than a clean success,
  restart-orphaned jobs are failed at boot (never stuck "running"), **the poller mirrors the addon's
  own `state`/`error` onto the feed row** (`applyAddonOutcome` — it read neither before, and
  `recomputeStage` deliberately no-ops on an item-less job, so a beatport link handed to yt-dlp's
  `^https?://` catch-all sat at "Downloading 0 of 0" forever with no reason and no Remove; ordering
  is load-bearing — after ingest, before the release that deletes the addon job and its error text —
  and `failOrphanedJob` now COALESCEs so the generic "restarted mid-download" guess can't clobber
  the real one; `sanitizeAddonError` reduces an addon's Rich Python **traceback** to its trailing
  exception line before it reaches the card — issue #601, prod showed a user
  `/usr/lib/python3.13/json/__init__.py:346 in loads` when spotdl's rate-limited YouTube Music
  preflight died inside `ytmusicapi` — while leaving non-traceback addon summaries untouched, so
  it narrows formatting, never *which* error is mirrored), Retry on any truncated acquire
  job resumes the same job id/staging dir instead of re-downloading from scratch (spotdl
  additionally passes `--overwrite skip` on top of that generic mechanism), and YouTube's bot-check
  is mitigated by Deno + the bgutil PO-token sidecar + optional `<dataDir>/youtube-cookies.txt`
  cookies — all of which now live in the **ytdlp/spotdl addon images**, not core's (issue #550).
  → [docs/download-pipeline.md](docs/download-pipeline.md),
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
  jobs for the same album now correctly stay two cards. `methodForBackend` maps every addon id
  incl. `slskd` (#532 — hunt cards rendered "?Unknown source" post-cutover), and every feed row is
  removable: `DELETE /jobs/:id` always drops the core row (addon proxy best-effort), with removal
  failures toasted instead of swallowed (#533) — so `canRemove` is now unconditional rather than
  gated on a stage a stuck card could never reach, `canCancel` accepts `queued`, and a failed URL
  acquire finally offers the **Retry** the acquire route always supported. A raw folder grab is
  **the addon job's mirror** (#586): `ISearchProvider.download` returns a `DownloadReceipt` the
  route links via `mapAddonJob` (one grab used to render as two cards, the visible one
  uncancellable), and Cancel on a row no addon owns closes it core-side (`cancelUnownedJob`).
  Downloader addons must **report what the source reported** (#585,
  `docs/download-pipeline.md` "What the addon split dropped"): title + one item per track +
  `unavailable` placeholders to the announced total, else a partial playlist reads "Done 1 of 1".
  The Downloads header also shows a **disk-availability pill** (`used / total`, green→red fill) fed by `GET /api/system/disk`
  (statfs of the music dir). **Card titles are one shared pure chain**
  (`downloadTitleFor`, `@nicotind/core`): addon display title → canonical album → landed albums →
  the source/peer folder (`isGenericFolderName`-guarded; a Soulseek uploader's folder describes the
  release) → a bare artist → the pasted link (humanized slug, but a structured "Spotify playlist"
  rather than a guessed base62 id) → the source label. It replaced a literal `"<Source> download"`
  that merely repeated the method chip; `AcquisitionJobView` gained `displayTitle`/`sourceUrl`/
  `destinationAlbums` to feed it, and `acquisition_jobs.display_title` is its own column because
  `album_title` is *filing* metadata (a playlist name there mints a phantom album). →
  [docs/download-pipeline.md](docs/download-pipeline.md) → "Card titles" / "Now: / Next: track display",
  [docs/web-ui.md](docs/web-ui.md)
- **Acquisition provenance (how/where/when)**: the `acquisitions` side-table records
  method/source/time at download time; surfaced per track. →
  [docs/download-pipeline.md](docs/download-pipeline.md)
- **Plugin architecture (acquisition as opt-in plugins)**: kind-agnostic kernel + `PluginRegistry`;
  acquisition is default-off; in-process plugins = spotify/lrclib/discogs/acoustid (slskd + yt-dlp +
  **spotdl** are now **external addons**, archive a **bundled addon** — all speaking the addon
  protocol, not the `Plugin` interface; core carries no yt-dlp/spotdl/slskd code); `auth`
  kind planned for OAuth. Config saves re-init the running plugin live. UI labelled **Extensions**, one section per kind
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
  (`services/plugins/builtin.ts`), not inline in `index.ts`, covered by a test. **Curated addon
  marketplace (issue #517)**: `ADDON_CATALOG` (`packages/core/src/addon-catalog.ts`) is a short,
  vetted, in-repo list (slskd/ytdlp/spotdl/archive — **not** an open registry, so the compliance
  posture holds); pure `renderComposeSnippet` + `catalogInstallState` (browser-safe) back
  `GET /api/plugins/catalog` and the admin-only "Available add-ons" Extensions section
  (`AddonCatalogService`/`AddonCatalogCardComponent`). **One-click install**:
  `POST /api/plugins/catalog/:id/install` mints a token (`mintAddonToken`), writes a `pending`
  `addon_registrations` row (additive `status`/`catalog_id`), and returns the snippet with the token
  baked in (no copy-paste); `promotePendingAddons` (60s interval + on `GET /catalog` +
  `POST /catalog/:id/check`) auto-activates it once its container answers — Install → paste → Pending
  → Enable. `POST /api/plugins/addons/preview` (`previewAddonManifest`) shows a manifest before the
  from-URL consent; a shareable `/extensions/install?catalog=<id>` link (+ QR via `renderQrDataUrl`)
  deep-links the marketplace with the entry highlighted. Zero new privilege (no Docker socket,
  curated urls only). →
  [docs/plugins.md](docs/plugins.md)
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
  AGPL-3.0-only) rather than vendored. Verified end-to-end — a "starts but mints invalid tokens"
  provider is the exact silent failure the issue exists to prevent — by minting a real PO token
  against YouTube's live attestation endpoint. **The image outlived its core-side consumer (issue
  #550)**: the plugin/provider pairing gate (`check:bgutil-pin`) compared core's baked pip plugin
  against the provider, but phase 4 moved every downloader out, so it was guarding a copy nothing
  ran; it retired with that copy. The provider image stays — the ytdlp/spotdl addons consume it, and
  **their** pins are the ones that can actually break a download (issue #551). The canonical version
  is now published **on the artifact** as `LABEL org.nicotind.bgutil.version`, wired to the `ARG` (a
  literal would report the old version after a bump, and a source-to-source check would pass while
  the published image is stale); `pot-provider-pin.test.ts` pins that contract. The addon-side
  assertions still need wiring once a release publishes a labelled image.
  → [docs/deployment.md](docs/deployment.md) "We build the PO-token provider ourselves"
- **Published Docker image (deployment)**: multi-arch GHCR image (`release`/`vX`/`vX.Y.Z` tags, no
  `latest`) published per release tag via native-runner digest builds + one manifest merge; compose
  pulls it (build-from-source is an override), the deploy host pulls too, `/api/health` reports the
  running version, and a ci.yml `docker` job (compose lint + conditional image build) gates
  releases. The ci.yml `release` job that cuts those tags is **orphan-tag-proof**: atomic
  `--follow-tags` push (a rejected branch update rejects the tag too) + self-healing orphan
  detection (a `vX` tag not reachable from master is deleted + re-cut, never silently skipped) —
  fixes the 2026-07-23 freeze where a non-atomic push orphaned `v0.1.244` and wedged every release
  behind a green-but-silent "already published" skip. **The same green-but-silent shape bit the
  *deploy* side (issue #457)**: `deploy` tolerated `docker-merge.result == 'skipped'`
  unconditionally for the `workflow_dispatch` case, but a job whose `needs` *failed* also reports
  `skipped` — so v0.1.329's failed GHCR push produced a **green deploy that redeployed the previous
  version**. The tolerance is now scoped to `workflow_dispatch` (on a tag push `skipped` can only
  mean upstream failure), and `docker-merge` verifies every tag it claimed (`vX.Y.Z`/`vX`/`release`)
  actually resolves before succeeding. **The workflow's own
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

- **Storybook component catalog**: 36 shared components (19 zero-injection + 17 light-DI)
  storied and documented, with theme/TV-build/viewport toolbar globals; per-component prose
  comes from each component's own class JSDoc via Compodoc (not hand-written MDX, which
  would drift), MDX covers only Foundations + Patterns. Stories run the **real** services
  behind an HTTP fixture interceptor — no fake service classes. `bun run smoke:storybook` is
  a second gate beside `build:storybook` because compiling a story is not running one (the
  first green build shipped 67 of 139 stories that threw on mount). `a11y:storybook:strict`
  is a third gate — axe over every story, promoted from report to gate only once it hit zero
  (fixing 241 contrast nodes + nine unnamed transport buttons; contrast turned out to be a
  theme-token problem, and accent needed splitting into `--theme-accent` for fills vs
  `--theme-accent-text` for text, which pull the requirement in opposite directions). Both
  gates are **one traversal** (`storybook-gates.mjs` + `lib/storybook-runner.mjs`, flags
  `--smoke`/`--a11y`/`--strict`) across a pool of contexts, waiting on first render instead
  of `networkidle` — 273s → 61s with byte-identical detection, verified red *and* green
  against a deliberately broken story; they run in their own `storybook` CI job, not `ci`.
  The 11
  app-shell components (5–14 injections) are deliberately out of scope. →
  [docs/storybook.md](docs/storybook.md)

Angular v22 standalone SPA with signals, `HttpClient` + interceptors, and lazy-loaded routes. Built
via `ng build` (esbuild); tests run on **plain vitest**, never `ng test` (which forbids the
`vi.mock` five specs rely on — see docs/web-ui.md "Web test harness"). Four type-check surfaces,
none of which covers the others — **all four are now folded into `bun run typecheck`**, so the local
command matches what CI enforces: `tsc --build` (app + packages), `typecheck:template` (**Angular
templates** via `ngc` — `tsc` never sees a binding expression, so this was "green locally, red at
`ng build`" until issue #273 folded it in), the **e2e specs** (`@nicotind/e2e typecheck`, issue #376
— `packages/e2e` sat in none of the other three, so spec type errors only surfaced when Playwright
loaded the file), and `typecheck:web-spec` (**web specs**, which `tsconfig.app.json` excludes and
vitest transpiles without checking — it was the last surface CI ran but `bun run typecheck` didn't,
which is exactly how a green local run still landed a red CI: a spec stub drifting from the type it
asserts against is invisible until that step). The HTTP surface is split into per-domain
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
`common.backToSettings` key was added for the "← Settings" back-link) + **onboarding/setup wizard**
(`setup.*`, all five wizard steps,
plus `common.back`/`common.next`) + **Admin panel** (issue #338, `admin.*` — 215 keys, every
section; `processingTaskDefs` moved from a pre-translated `label` to a `labelKey` so the task list
stays reactive to a live language switch, matching the rest of the page) + **Acquire's Advanced
disclosure** (issue #338, the raw Soulseek folder-browser section — closes the #338 long tail;
deliberately leaves the shared `getFolderBtn`/`getSongBtn`/`getGroupFileBtn` download-status-label
helpers untranslated since they're used by other components, not scoped to this one page) +
**Extensions / Agent tokens / slskd settings** (issue #380, `extensions.*`/`agentTokens.*`/`slskd.*`
— the settings-adjacent trio #338 skipped: kind groups, status pills, config forms + consent dialog;
mint/shown-once/revoke; the slskd status panel, connection + shares forms and both notices — the
`common.backToSettings` back-link finally picked up on both pages; per-plugin manifest strings
(name/description/config-field labels) stay untranslated since they're server data, not web copy);
**es.json is at full parity** with the base. Extraction is a phased pass — **API
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
player — blurred-cover backdrop, bottom-pinned glass transport without shuffle/repeat, a Next-up chip that opens a D-pad queue overlay with jump/remove (issue #399, `NowPlayingTvQueueComponent`)
— driven by `isTvUi()` (the root class, e2e-testable via `now-playing-tv.spec.ts`); a roving-tabindex D-pad
navigation directive pair — vertical/horizontal/grid axes — covers the Now Playing queue,
transport controls, every Library/Search/artist-detail grid, every `TrackRowComponent`-based song
list, Settings/Admin/Extensions button/toggle rows (forms stay Tab-order-only by design), and — the
last pointer-only holdout — the **mini-player grab notch** (issue #432: it and the bar were bound
solely to `(pointerdown)`, so expanding Now Playing was impossible from a remote; it stays a `<div>`
rather than a `<button>` because `onBarPointerDown` bails on `closest('button')` and that would kill
the touch swipe-to-open, and `TvNavItemDirective`'s `[attr.role]` no longer clobbers an
author-provided `role`),
plus a global keyboard shortcut set (Space/K play-pause, J/L prev/next, M mute, N now-playing, arrow-key seek that defers to D-pad nav groups, `/` for Acquire; Escape shares the hardware-Back `BackHandlerStack` (issue #398) so one press closes only the topmost overlay, via `registerOverlayCloser` for `@if`-rendered modals). The `@nicotind/capacitor-tv-channels` plugin owns the Google TV launcher surface: a Watch Next "Continue listening" entry for the current track, a "Recently added" preview-channel row of the newest albums whose tiles deep-link into the app via a sanitized route extra (issue #395, `publishChannel`/`clearChannel` + the retained `deepLink` event), and the Assistant's play-from-search voice intent. → See [docs/mobile-app.md](docs/mobile-app.md) and
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

**TV surface (issue #436/#438)**: the TV is a route-level fork —
three screens (moods / browse / player) plus minimal settings, no form controls anywhere, one
button contract — because every TV defect so far reduces to two bug *classes*, not N bugs: a
native control eating the arrow keys (a remote has no Tab to escape with), or a nav group
clamping and swallowing the press. Enforced by extending the e2e:tv reachability audit to fail
on any focusable native form control (a native input carries neither `appTvNavItem` nor
`tabindex=0`, so the reachability walk is blind to it — which is why that audit passed while #438 was
live). The fork keys off **`isTvBuild()`, never `isTvUi()`**: `app.routes.ts` is evaluated before
`applyTvBuildClass()` runs, so a DOM-based check there silently registers nothing. `app-player` is
still mounted on TV but **headless** — it owns the `<audio>` engine, not just the bar. →
[docs/tv-ux.md](docs/tv-ux.md)

**Android TV emulator lane (`bun run e2e:tv`)**: a *second*, local-only Playwright lane driving the
real APK on an AVD via Playwright's `_android` API (`chromium.connectOverCDP` does **not** work — a
WebView exposes no browser-level target). It exists for the one thing the Chromium suite
structurally cannot model: **an Android WebView has spatial navigation and desktop Chrome does not**,
so a desktop test can't tell "focus correctly moved" from "focus never could have moved" — which is
where issue #436's focus trap hid. Covers D-pad escape + a generic reachability audit (BFS over the
focus graph, identity = a stamped `data-tvwalk` attribute because derived testids can't round-trip),
hardware Back (#394, no Back key exists in Chromium), and a WebView-only smoke pass (CORS,
`ngsw-bypass`, real audio decode). `tv/preflight.ts` owns the whole lifecycle and **deliberately
caches nothing** — gradle's incremental no-op is 9.8 s, so skips would save ~18 s and reintroduce
#253's stale-bundle failure. Three tests are `test.fail()` pinning #436: green while the bug is open,
loudly red the moment it's fixed without updating them. →
[docs/e2e-tv-emulator.md](docs/e2e-tv-emulator.md)

**Real-use feedback log**: [docs/feedback-log-2026-08.md](docs/feedback-log-2026-08.md) is a
rolling, dated log of friction noticed while actually _using_ the app — one entry per observation
with Severity/Status. Rotate monthly.

## Configuration

Config is loaded from `config/default.yml`, overridden by environment variables. See `.env.example`
for all options and [docs/configuration.md](docs/configuration.md) for the reference table. Key
vars: `NICOTIND_MODE`, `NICOTIND_MUSIC_DIR`, `NICOTIND_DATA_DIR` (Soulseek creds live on the
slskd addon since phase 3 — `SLSKD_ADDON_*` envs on that container).
