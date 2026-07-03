# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It is an **index**, kept deliberately small because it loads into every request. The full
detail behind each pattern below lives in `docs/` (loaded only when relevant) — primarily
[docs/design-patterns.md](docs/design-patterns.md) plus the per-feature `docs/<feature>.md`
files linked from each entry.

## Quality Gates

Every task on this project must satisfy all three gates before being considered done:

1. **Every change must be tested.** New features get new tests. Bug fixes get regression tests. Refactors must not reduce coverage. If a change can't reasonably be unit-tested, add an integration or e2e test instead — untested code is not shippable.

2. **Every test must run in CI.** Adding a test locally is not enough. Verify the relevant GitHub Actions workflow actually executes the new test on push. If a new test file or package is added, confirm it's picked up by `.github/workflows/`. Don't close out a task until CI covers the new test.

3. **Documentation must be updated in the same change as the code.** This is not optional and not a follow-up task: **every time you add or modify behavior, update the docs in the same commit/PR.** Significant decisions — new patterns, new services, why an approach was chosen over alternatives, trade-offs accepted — must be captured. If a change makes an existing doc statement wrong, fix that statement; stale docs are treated as a bug. **Where docs live (CLAUDE.md is an index, not the detail store):**
   - **The detail goes in `docs/`** — either the relevant existing `docs/<feature>.md`, or [docs/design-patterns.md](docs/design-patterns.md) for patterns without a dedicated file. Write the full rationale/implementation notes there, not inline in this file. These files are *not* loaded into every request, so detail here is cheap.
   - **Update the one-line index entry in `CLAUDE.md`** (under Key Design Patterns or the relevant section) so the new/changed behavior is discoverable, and **point it at the doc** holding the detail. A reader should never have to discover a `docs/` file by accident; this file should never grow a dense multi-sentence bullet again.
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

One-line index; **full detail for every entry is in [docs/design-patterns.md](docs/design-patterns.md)** (and the per-feature doc linked on each line). Add detail there, not here.

- **Source-agnostic acquisition (the north star)**: every acquirable result from any source maps to one `AcquisitionCandidate` rendered in one blended, ranked list with a neutral source chip + single Get; adding a source = one adapter + a pure mapper, no route/UI change. → [docs/source-agnostic-acquisition.md](docs/source-agnostic-acquisition.md)
- **Native library scanner**: `LibraryScanner` walks the music dir, reads tags (`music-metadata`) → `library_*` tables with deterministic SHA1 IDs; `resolveTags` applies user metadata overrides before minting IDs (survives rescans). → [docs/library-scanner.md](docs/library-scanner.md)
- **VA / compilation handling**: `resolveTags` separates `albumArtist` (grouping) from `trackArtist` (performer); `classifyFolder` detects compilations via COMPILATION flag, VA albumArtist, or ≥3 artists sharing one album; dedicated Compilations tab, VA hidden from artists, "Appears On" on artist pages. → [docs/library-scanner.md](docs/library-scanner.md)
- **Multi-artist support**: `splitArtists` parses compound names + featuring credits into individual artist associations stored in `library_song_artists` / `library_album_artists` join tables; cross-references existing library to avoid splitting band names; `ArtistLinksComponent` renders clickable inline links. → [docs/library-scanner.md](docs/library-scanner.md)
- **Native streaming + cover art**: `GET /api/stream/:id` (Range/206 + seekable disk transcode cache) and `GET /api/cover/:id` (override→canonical→folder→embedded, sized WebP thumbnails honoring `size=`); an artist id with no real photo 404s to the placeholder (no album-cover fallback). → [docs/library-scanner.md](docs/library-scanner.md)
- **Canonical artwork**: `library_artwork` stores canonical URLs keyed on deterministic IDs (survives rescans). → [docs/library-scanner.md](docs/library-scanner.md)
- **Artist images (auto + override)**: real portraits resolved Lidarr-poster→Spotify (`resolveArtistImageUrl`), auto-filled by the `artist-image` enrichment task; users (admin) upload or copy-from-album a per-artist override (`<dataDir>/artist-overrides`, served first, `manual_override=1`). → [docs/library-scanner.md](docs/library-scanner.md)
- **Metadata optimization**: conservative, all-or-nothing bulk Lidarr re-fetch of cover/year/release-type (`optimizeAllAlbums`); skips placeholder-artist albums. → [docs/metadata-optimize.md](docs/metadata-optimize.md)
- **User-driven metadata fix**: interactive Lidarr candidate search + free-text + multi-source cover picker, persisted in `library_metadata_overrides` with immediate canonical re-point. → [docs/metadata-optimize.md](docs/metadata-optimize.md)
- **On-demand track analysis (BPM + genre)**: per-track analyze/verify in the track-info drawer + bulk backfill scripts; writes DB **and** file tag. → [docs/library-scanner.md](docs/library-scanner.md)
- **Windowed library processing**: resumable background enrichment (bpm/genre/key/artist-image) via an extensible task registry, run only inside a daily window. → [docs/library-processing.md](docs/library-processing.md)
- **Lyrics (on-demand, plugin-sourced, editable)**: new `metadata` plugin kind + `lyrics` capability (LRCLIB first source); stored in `library_lyrics` + file tag, user-editable. → [docs/design-patterns.md](docs/design-patterns.md)
- **Unified search**: `GET /api/search?q=` blends local library + parallel slskd network results into the one source-agnostic results list. → [docs/source-agnostic-acquisition.md](docs/source-agnostic-acquisition.md)
- **Guided acquire UX**: catalog cards are the primary path; the raw network/folder-browser lane is demoted behind an "Advanced" disclosure; the hunt modal leads with the best match. → [docs/design-patterns.md](docs/design-patterns.md)
- **Inline download lifecycle**: result cards go idle → progress % → "Open in Library", driven by `TransferService` (adaptive polling) + a `libraryDirty` signal. → [docs/design-patterns.md](docs/design-patterns.md)
- **Multi-user**: shared music library, per-user settings in sqlite; first registered user becomes admin. → [docs/design-patterns.md](docs/design-patterns.md)
- **Onboarding**: expanded setup wizard for self-hosters (music dir + quality + Lidarr); first-login welcome banner for admin-provisioned app users. → [docs/onboarding.md](docs/onboarding.md)
- **Smart radio (metadata-driven queue)**: `GET /api/radio/next` scores candidates by BPM proximity, Camelot key compatibility, genre match, year, duration, and artist diversity; `PlayerService.radio` auto-appends results when the queue drains. Shared scoring with `/songs/:id/similar`. → [docs/radio.md](docs/radio.md)
- **Remote playback (cast, Spotify-Connect-style)**: per-user `PlaybackStateManager` broadcasts state/commands over `GET /api/ws/playback`; each browser tab is a device. → [docs/remote-playback.md](docs/remote-playback.md)
- **Service modes**: `embedded` (spawn slskd as child process) or `external`; the library/streaming stack is in-process. → [docs/design-patterns.md](docs/design-patterns.md)
- **Auth flow**: NicotinD issues its own JWTs (30-day sliding sessions, silent refresh on boot); share tokens are short-lived, read-only, non-refreshable. → [docs/design-patterns.md](docs/design-patterns.md)
- **Release-type model (singles & EPs)**: every album carries a `classification`, set metadata-first (Lidarr/MusicBrainz) with a track-count heuristic fallback. → [docs/download-pipeline.md](docs/download-pipeline.md)
- **Native playlists (per-user)**: `playlists`/`playlist_songs` + `PlaylistService`, private per user, with sharing + server-side OG/Twitter link previews. → [docs/web-ui.md](docs/web-ui.md)
- **Curated playlists (system, global)**: gradient-covered Spotify-style shelves shown to all users; read-only by `kind` (not ownership). → [docs/curated-playlists.md](docs/curated-playlists.md)
- **Automated playlists (recipe → weekly-refreshed curated shelves)**: code-defined `RECIPES` (bpm/key/year/genre `where` + sort) materialized into `kind='curated'` playlists by `refreshAutoPlaylists`, refreshed once per ISO week via an in-process guard in the processor tick; reuses `selectCuratedTracks` + the shared `upsertCuratedPlaylist`. → [docs/automated-playlists.md](docs/automated-playlists.md)
- **Playlist generator (seed/starred → Radio-scored user playlist)**: `POST /api/playlists/generate` fills an editable user playlist from a song/artist/starred seed via `rankCandidates` (the Radio scorer) + `orderTracks('harmonic')` Camelot/BPM sequencing; pure engine in `playlist-recipe.ts`. → [docs/playlist-generation.md](docs/playlist-generation.md)
- **Artist page — tabbed**: Albums | Singles & EPs | Songs (lazy, paginated Songs tab with multi-select bulk actions incl. admin-gated delete — the only view that can remove albumless files). → [docs/design-patterns.md](docs/design-patterns.md)
- **Viewport-safe dropdown menus (`MenuPanelComponent`)**: fixed-position panel that flips above / clamps into the viewport via the pure `computeMenuPosition`. → [docs/design-patterns.md](docs/design-patterns.md)
- **Bottom-chrome stacking + scroll lock**: mini-player and tab bar share one `z-50` plane; `ScrollLockService` pins the document under full-screen sheets. → [docs/design-patterns.md](docs/design-patterns.md)
- **Catalog (metadata-driven) search**: `CatalogService` returns artist/album cards from Lidarr/MusicBrainz, scoped to the matched artist, resolving into album-hunt (typed 404 + raw-network fallback for absent compilations). → [docs/album-hunt.md](docs/album-hunt.md)
- **Album hunt**: `AlbumHunterService` skewed queries + diacritic scoring + two-phase progress; blended "Other sources" + per-track fallback when 0 folders found. → [docs/album-hunt.md](docs/album-hunt.md)
- **Watchlist auto-hunt**: star catalog albums; a poller auto-hunts + downloads on a confident match. → [docs/album-hunt.md](docs/album-hunt.md)
- **Spotify metadata fallback (via spotDL)**: metadata-only lane that hands a `spotify.com/album` URL to `/api/acquire`; the `spotify` plugin gates it. → [docs/spotify-fallback.md](docs/spotify-fallback.md)
- **Idempotent hunt — one album = one download**: 409 guards + only-missing-tracks enqueue; "already have it" outcomes surface as positive notices, not red errors. → [docs/album-hunt.md](docs/album-hunt.md)
- **Duplicate prevention**: FLAC>MP3 + auto-dedupe + edition-collapsing album IDs + cross-edition folder consolidation at ingest. → [docs/download-pipeline.md](docs/download-pipeline.md)
- **Lossless → Opus standardization**: lossless downloads transcoded to Opus in place (default-on 192 kbps) + a library migration path; gated on ffmpeg. → [docs/download-pipeline.md](docs/download-pipeline.md)
- **Album deletion**: `DELETE /api/library/albums/:id` is folder-first `rmSync` + synchronous canonical-row delete + orphan-aggregate prune. → [docs/download-pipeline.md](docs/download-pipeline.md)
- **Library quality auditor**: assert (audit) + clean (repair/retag) + prevent (ingest sanitize) for DJ-pool/VA-source pollution across DB + disk. → [docs/library-audit.md](docs/library-audit.md)
- **Downloading albums suppressed from listing**: listings exclude albums with active `album_jobs` or in-flight transfers via an SQL `WHERE` exclusion. → [docs/design-patterns.md](docs/design-patterns.md)
- **Untracked downloads**: `relative_path IS NULL` rows are backfilled by a script; listed at `GET /api/library/untracked` (admin). → [docs/download-pipeline.md](docs/download-pipeline.md)
- **URL acquisition (yt-dlp / spotdl / archive)**: `POST /api/acquire` routes a URL to an enabled `resolve`-capable plugin → the same organizer + scan pipeline. → [docs/download-pipeline.md](docs/download-pipeline.md)
- **Download list metadata**: `GET /api/downloads` annotates in-flight folders matching `album_jobs` with album-job info. → [docs/download-pipeline.md](docs/download-pipeline.md)
- **Unified downloads feed**: slskd groups + URL acquire jobs both adapt into a normalized `DownloadItem` with method/stage badges. → [docs/download-pipeline.md](docs/download-pipeline.md)
- **Acquisition provenance (how/where/when)**: the `acquisitions` side-table records method/source/time at download time; surfaced per track. → [docs/download-pipeline.md](docs/download-pipeline.md)
- **Plugin architecture (acquisition as opt-in plugins)**: kind-agnostic kernel + `PluginRegistry`; acquisition is default-off; plugins = slskd/yt-dlp/spotdl/archive/spotify/lrclib. → [docs/plugins.md](docs/plugins.md)
- **Changelog modal**: build-time `CHANGELOG.md` → `changelog.json` (capped at 50 versions); version string in header/settings is clickable → [docs/web-ui.md](docs/web-ui.md)

## Web UI

Angular v22 standalone SPA with signals, `HttpClient` + interceptors, and lazy-loaded routes. Built via `ng build` (esbuild); tests via `ng test` (vitest). The HTTP surface is split into per-domain stateless services under `services/api/` (`Auth`/`Search`/`Library`/`Downloads`/`System`/`Playlists` ApiService + shared `api-types.ts`) — inject the specific one; there is no monolithic `ApiService`. → See [docs/web-ui.md](docs/web-ui.md) for theme system, Angular patterns, and component conventions.

## Mobile app (Capacitor Android + iOS)

`packages/mobile` is a thin **Capacitor** shell that wraps the **same** `@nicotind/web` Angular build (no second UI codebase). The enabler is a runtime-configurable API base URL (`ServerConfigService` + a native-only server-picker + `nativeAppCors()`). Background audio + lock-screen controls come from `@jofr/capacitor-media-session` on Android and an iOS-only `@nicotind/capacitor-now-playing` Swift plugin (owns `MPNowPlayingInfoCenter` + `AVAudioSession` + transport). Android/iOS artifacts are built by tag-only best-effort CI jobs in `deploy.yml`. → See [docs/mobile-app.md](docs/mobile-app.md) and [docs/ios-app.md](docs/ios-app.md).

## End-to-end tests

`packages/e2e` is a Playwright suite that boots the real server against a throwaway DB + silent-FLAC fixtures and drives the SPA in Chromium (auth, library, playback, player controls, plugin capability gating). Acquisition is default-off so no slskd/Lidarr is needed. Selectors are `data-testid` attributes — **adding a `data-testid` is the standard for new e2e-targeted elements**. CI is split: `ci.yml` runs `ci` + `e2e` then a `release` job tags `vX.Y.Z`; that tag triggers `deploy.yml`. A gated **playground harness** (`PLAYGROUND=1`), the mutating **real round-trip** (`PLAYGROUND_REAL=1`), and **screenshot flows** are all out of CI. The flow catalogue + recurring routines live in [docs/testing-routines.md](docs/testing-routines.md). → See [docs/e2e.md](docs/e2e.md).

**Real-use feedback log**: [docs/feedback-log-2026-06.md](docs/feedback-log-2026-06.md) is a rolling, dated log of friction noticed while actually *using* the app — one entry per observation with Severity/Status. Rotate monthly.

## Configuration

Config is loaded from `config/default.yml`, overridden by environment variables. See `.env.example` for all options. Key vars: `SOULSEEK_USERNAME`, `SOULSEEK_PASSWORD`, `NICOTIND_MODE`, `NICOTIND_MUSIC_DIR`.
