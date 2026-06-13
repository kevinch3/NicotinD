# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quality Gates

Every task on this project must satisfy all three gates before being considered done:

1. **Every change must be tested.** New features get new tests. Bug fixes get regression tests. Refactors must not reduce coverage. If a change can't reasonably be unit-tested, add an integration or e2e test instead — untested code is not shippable.

2. **Every test must run in CI.** Adding a test locally is not enough. Verify the relevant GitHub Actions workflow actually executes the new test on push. If a new test file or package is added, confirm it's picked up by `.github/workflows/`. Don't close out a task until CI covers the new test.

3. **Documentation must be updated in the same change as the code.** This is not optional and not a follow-up task: **every time you add or modify behavior, update the docs in the same commit/PR.** Significant decisions — new patterns, new services, why an approach was chosen over alternatives, trade-offs accepted — must be captured. If a change makes an existing doc statement wrong, fix that statement; stale docs are treated as a bug. Where docs live:
   - **Inline in `CLAUDE.md`** (the default) — add or update a bullet in the relevant section (Key Design Patterns / Web UI). This is the established pattern; most subfeatures are one dense bullet here.
   - **A dedicated `docs/<feature>.md` file** when a feature is large enough that an inline bullet can't do it justice. When you do this, **add a one-line pointer to it from `CLAUDE.md`** so the main file remains the index — a reader should never have to discover a `docs/` file by accident.
   - **A concise `// why` comment in code** for local rationale that belongs next to the implementation.

   A change is not "done" (gate-complete) until its documentation reflects reality.

## What is NicotinD?

NicotinD is a unified music acquisition + streaming platform that orchestrates **slskd** (Soulseek P2P client) behind a single API, web UI, and CLI, and **natively scans/streams** the music library itself (Navidrome was removed — see Architecture). Downloads from Soulseek land in a shared folder; the DownloadWatcher organizes and incrementally scans completed transfers into the canonical SQLite library that the API streams from. URL-based acquisition (yt-dlp / spotdl) feeds the same pipeline.

## Commands

```bash
bun install              # Install all workspace dependencies
bun run typecheck        # TypeScript type checking (tsc --build)
bun run lint             # ESLint across all packages
bun run format           # Prettier formatting
bun run src/main.ts      # Start NicotinD (requires .env or config/default.yml)
bun run release          # Bump version (auto-detected), generate CHANGELOG, tag
bun run release:minor    # Force a minor version bump
bun run release:major    # Force a major version bump
```

## Commit Conventions

This repo uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must follow this format:

```
<type>(<optional scope>): <description>
```

**Types that bump the version** (appear in CHANGELOG):
| Type | When to use | Version bump |
|------|-------------|--------------|
| `feat` | New user-facing feature | minor |
| `fix` | Bug fix | patch |
| `perf` | Performance improvement | patch |

**Types that don't bump** (hidden from CHANGELOG):
| Type | When to use |
|------|-------------|
| `chore` | Deps, tooling, config, CI tweaks |
| `refactor` | Code restructuring (no behavior change) |
| `style` | Formatting, whitespace |
| `docs` | Documentation only |
| `test` | Adding/updating tests |
| `ci` | CI pipeline changes |
| `build` | Build system changes |

**Breaking changes**: Add `BREAKING CHANGE:` in the commit body or `!` after the type (e.g. `feat!: remove legacy auth`) to trigger a major bump.

**Enforcement**: A `commit-msg` hook via husky + commitlint rejects non-conforming messages.

**Releasing**: When ready to release, run `bun run release`. It reads the commit history since the last tag, determines the version bump, updates `package.json`, generates/updates `CHANGELOG.md`, commits, and creates a git tag.

## Architecture

```
NicotinD (Hono API :8484)  — native library scanner + streaming, all in-process
└── slskd (Soulseek client :5030)  ──── shared /data/music folder
        DownloadWatcher → LibraryOrganizer → LibraryScanner (tags → SQLite)
```

> **Navidrome was removed.** NicotinD is now fully native: it scans the music
> dir itself (`LibraryScanner`, `music-metadata`), serves audio bytes from disk
> with HTTP range support (optional ffmpeg transcoding), and resolves cover art
> from folder/embedded images. The canonical `library_*` SQLite tables are the
> single source of truth. The **`/rest/*` Subsonic proxy and the playlist feature
> were dropped** in the same migration (playlists to be re-added natively later).

**Bun monorepo** with workspace packages:

| Package | Purpose |
|---------|---------|
| `@nicotind/core` | Shared types (Zod schemas), logger (pino), crypto utils, error classes |
| `@nicotind/slskd-client` | Typed HTTP client wrapping slskd's REST API (`/api/v0/*`) |
| `@nicotind/service-manager` | Strategy pattern for managing sub-service lifecycle (child_process or Docker) |
| `@nicotind/api` | Hono API server — routes, JWT auth, unified search, download watcher, native library scanner + streaming, SQLite DB |
| `@nicotind/web` | Angular v22 web UI (standalone components, signals, Tailwind) |
| `@nicotind/cli` | Commander.js CLI (Phase 3) |

**Entry point**: `src/main.ts` — loads config, starts services, wires clients into the API server.

## Key Design Patterns

- **Native library scanner**: `LibraryScanner` (`packages/api/src/services/library-scanner.ts`) walks the music dir, reads tags via `music-metadata`, and writes to `library_*` SQLite tables with deterministic SHA1 IDs. Includes clean tracklist selection (one best file per track) via `selectAlbumTracks`, Lidarr-canonical matching, and edition-collapsing album IDs. → See [docs/library-scanner.md](docs/library-scanner.md).
- **Native streaming + cover art**: `streamingRoutes` serves `GET /api/stream/:id` from disk with HTTP Range/206 and optional ffmpeg transcoding; `GET /api/cover/:id` resolves canonical → folder → embedded art. 404 responses carry `Cache-Control: public, max-age=300` and a module-level `noArtCache` (10 min TTL) short-circuits the slow `extractCover()` IO on repeat misses. → See [docs/library-scanner.md](docs/library-scanner.md).
- **Canonical artwork**: `library_artwork` table stores canonical URLs keyed on deterministic IDs (survives rescans); populated by `hunt-download` and `scripts/backfill-artwork.ts`. → See [docs/library-scanner.md](docs/library-scanner.md).
- **Unified search**: `GET /api/search?q=` queries the local library first (`LibrarySearchProvider`), fires slskd network search in parallel. Local results display above a divider, network results below with download actions.
- **Inline download lifecycle**: Search result cards show idle → blue progress wash + % → green "▶ Open in Library". Driven by `TransferService`; a `libraryDirty` signal tracks completed downloads (cleared on library page load, ignoring initial boot completions to prevent double-loading and disruptive auto-refreshes of active views). `TransferService` uses adaptive polling: 3 s when any transfer or acquire job is active, 30 s when idle. `kickPoll()` resets to fast mode immediately when a download is initiated.
- **Multi-user**: Shared music library (all users see all downloads). Per-user settings in bun:sqlite (`packages/api/src/db.ts`). First registered user becomes admin.
- **Service modes**: `embedded` (NicotinD spawns slskd as child process) or `external` (connects to a pre-existing slskd). Library/streaming stack is in-process — no music-server subprocess.
- **Auth flow**: NicotinD issues its own JWTs; holds auto-generated API key for slskd. Web player streams via `/api/stream/:id?token=` (JWT in query param).
- **Release-type model (singles & EPs, Spotify-style)**: every album carries a `classification` (`album`/`ep`/`single`/`compilation`/`unknown`). The `LibraryCurator` classifies **metadata-first** — Lidarr/MusicBrainz `albumType` from the `library_release_meta` side table (`release-meta-store.ts`, keyed on the scanner's `albumId`, survives rescans) wins; otherwise a track-count heuristic (1 → single, 2–6 → ep, 7+ → album). Album-less tracks are **un-bucketed at scan time**: `isLooseSinglesBucket` makes each loose track its own single release named after the title (no more shared hidden `<Artist>/Singles/` bucket; the organizer no longer force-writes `album="Singles"`). The Albums grid stays album-only via a single centralized filter (`GRID_CLASSIFICATION_SQL` in `routes/library.ts`); singles & EPs surface on the **artist page** (`GET /artists/:id` → `{ albums, singlesAndEps }`) and a dedicated **`GET /library/singles`** list. Ingest-time `SingleEnrichmentService` does a best-effort Lidarr lookup on URL-acquired singles (release type + canonical artwork via the existing `artwork-store`), degrading gracefully when Lidarr is unconfigured. → See [docs/download-pipeline.md](docs/download-pipeline.md).
- **Native playlists (per-user)**: `playlists`/`playlist_songs` tables + `PlaylistService` (`services/playlist.service.ts`) behind `/api/playlists` (`routes/playlists.ts`), every handler scoped to `c.var.user.sub` so playlists are private. Songs are referenced by the scanner's stable `songId`; reads JOIN `library_songs` and **silently drop songs whose file moved** (id changed) so a playlist degrades rather than showing dead entries. → See [docs/web-ui.md](docs/web-ui.md).
- **Catalog (metadata-driven) search**: `CatalogService` (`/api/catalog`) looks up Lidarr/MusicBrainz and returns structured artist/album cards; resolves to the album-hunt flow on selection. Raw slskd search is an always-visible fallback. → See [docs/album-hunt.md](docs/album-hunt.md).
- **Album hunt**: `AlbumHunterService` fires base + skewed queries against slskd with soft-ban bypass (`buildSkewedQueries`), diacritic-insensitive scoring, two-phase endpoint for live UI progress, and a cross-peer fallback + auto-retry for exhausted jobs. → See [docs/album-hunt.md](docs/album-hunt.md).
- **Watchlist auto-hunt**: `WatchlistService` (`/api/watchlist`) lets users star catalog albums; a poller auto-hunts and downloads them when a confident candidate appears. → See [docs/album-hunt.md](docs/album-hunt.md).
- **Idempotent hunt — one album = one download**: `hunt-download` guards with 409s for already-active or already-complete albums and enqueues **only missing tracks** via `filesMissingOnDisk`. → See [docs/album-hunt.md](docs/album-hunt.md).
- **Duplicate prevention**: Format preference (FLAC over MP3) + auto-dedupe after each organized batch. Album IDs are deterministically edition-collapsing so scanner-level dedup is inherent. → See [docs/download-pipeline.md](docs/download-pipeline.md).
- **Album deletion**: `DELETE /api/library/albums/:id` is folder-first (`rmSync` the whole `<Artist>/<Album>` dir), then synchronously deletes canonical rows — no tombstone/async-scan reconciliation needed. → See [docs/download-pipeline.md](docs/download-pipeline.md).
- **Downloading albums suppressed from listing**: `GET /api/library/albums` and `GET /api/library/artists/:id` exclude albums with an active `album_jobs` row (matched via `normalizeForGrouping`). Albums appear the moment their job exits `active`. `DownloadWatcher.start()` seeds `knownCompleted` from `completed_downloads` at boot so container restarts don't replay history.
- **Untracked downloads**: Rows with `relative_path IS NULL` (pre-organizer) are backfilled by `backfillRelativePaths` (`scripts/backfill-untracked.ts`, dry-run unless `--apply`). Listed at `GET /api/library/untracked` (admin).
- **URL acquisition (yt-dlp / spotdl)**: `POST /api/acquire` routes the URL to an enabled `resolve`-capable **plugin** via `registry.getEnabledForUrl()` (no hardcoded backend detection) and runs downloads through the same `LibraryOrganizer` + incremental scan pipeline as Soulseek; 503 when no enabled plugin handles/can-serve the URL. Gated by plugin enable-state + binary on PATH. Completed/failed acquire jobs surface in the Downloads → Active tab ("URL Downloads" section) with Retry and Dismiss actions; done/failed rows older than 7 days are auto-pruned at startup. `AcquireJob` type lives in `@nicotind/core`. Uploads tab removed from the Downloads UI. → See [docs/download-pipeline.md](docs/download-pipeline.md).
- **Download list metadata**: `GET /api/downloads` annotates in-flight folders matching `album_jobs` with `albumJob: { artistName, albumTitle, canonicalTrackCount }`. Web groups transfers via the pure `lib/download-groups.ts`.
- **Plugin architecture (acquisition as opt-in plugins)**: acquisition (and, later, connectivity) is factored into opt-in plugins behind a kind-agnostic kernel. Contracts live in `@nicotind/core` (`src/plugin/*`: manifest + `Search/Browse/Resolve/Download/Connectivity` capability interfaces + `PluginHostContext` — the *only* surface a plugin may use; plugins produce staged files and never touch the DB/organizer). `PluginRegistry` (`services/plugins/registry.ts`) registers build-time plugins, persists enable/consent/config (`plugins` + `plugin_kv` tables), and resolves plugins by kind/capability/URL. `routes/plugins.ts`: `GET /api/plugins` (any user, drives capability-gated UI), admin-only `POST :id/enable|disable` (consent-gated → `412` with disclaimer when required, records acting admin) + `PUT :id/config` (validated against the manifest's zod schema). **Compliance posture**: acquisition is default-off (zero capability until an admin enables a plugin). The **slskd plugin** (`services/plugins/slskd/`) wraps the Soulseek client and (de)registers its `SlskdSearchProvider` in `ProviderRegistry` on enable/disable — so network search/downloads/browse gate on it with no route changes; **hunt + watchlist** gate via `requireAcquisitionMiddleware` (`services/plugins/gate.ts`) + the poller's `isAcquisitionEnabled`. **yt-dlp + spotdl** are `resolve` plugins (`services/plugins/{ytdlp,spotdl}/`) on a shared process runner (`services/plugins/acquire/process.ts`); `AcquireWatcher` routes URLs via `registry.getEnabledForUrl()` (no more `detectBackend` enum) and owns job records + ingest, while plugins stage files. **Default-off compliance**: fresh installs enable nothing (`seedLegacyAcquisitionPlugins` migrates *existing* installs once, guarded by an `app_settings` marker). **Web**: `PluginService` (signals, capability computeds `hasSearch`/`hasResolve`/`hasDownload`) + the admin **Settings → Plugins** page (`pages/plugins/`, route `/settings/plugins`); the search page gates the URL acquire box on `hasResolve` and the watchlist star on `hasDownload`. *Phases A–D landed; connectivity (E) is scaffolded (kind handled generically) but no connectivity plugin is shipped.* → See [docs/plugins.md](docs/plugins.md).

## Web UI

Angular v22 standalone SPA with signals, `HttpClient` + interceptors, and lazy-loaded routes. Built via `ng build` (esbuild); tests via `ng test` (vitest). → See [docs/web-ui.md](docs/web-ui.md) for theme system, Angular patterns, and component conventions.

## End-to-end tests

`packages/e2e` is a Playwright suite that boots the real server (`bun run src/main.ts`) against a throwaway DB + committed silent-FLAC fixtures and drives the SPA in Chromium: auth, library, playback, **player controls (pause/next/seek/shuffle)**, and the compliance-critical plugin capability gating. No slskd/Lidarr needed — acquisition is default-off, so the test server runs `NICOTIND_MODE=external` with dead slskd/Lidarr URLs and a fresh `.tmp-data` dir per run (deterministic first-user admin). Selectors are `data-testid` attributes — **adding a `data-testid` is the standard for new e2e-targeted elements** (`app-password-field` forwards a `testId` input). Runs on port 8585 (override `E2E_PORT`); `E2E_BASE_URL` points it at a running instance (prod smoke) and skips the managed server. CI: the `e2e` job in `.github/workflows/deploy.yml` builds web + runs the suite, and `release`/`deploy` gate on it. → See [docs/e2e.md](docs/e2e.md).

## Configuration

Config is loaded from `config/default.yml`, overridden by environment variables. See `.env.example` for all options. Key vars: `SOULSEEK_USERNAME`, `SOULSEEK_PASSWORD`, `NICOTIND_MODE`, `NICOTIND_MUSIC_DIR`.
