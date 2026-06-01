# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quality Gates

Every task on this project must satisfy all three gates before being considered done:

1. **Every change must be tested.** New features get new tests. Bug fixes get regression tests. Refactors must not reduce coverage. If a change can't reasonably be unit-tested, add an integration or e2e test instead — untested code is not shippable.

2. **Every test must run in CI.** Adding a test locally is not enough. Verify the relevant GitHub Actions workflow actually executes the new test on push. If a new test file or package is added, confirm it's picked up by `.github/workflows/`. Don't close out a task until CI covers the new test.

3. **Every business or architecture decision must be documented.** Significant decisions — new patterns, new services, why an approach was chosen over alternatives, trade-offs accepted — belong in `CLAUDE.md` (architectural context), as a concise `// why` comment in code, or in a `docs/` file if scope warrants.

## What is NicotinD?

NicotinD is a unified music acquisition + streaming platform that orchestrates **slskd** (Soulseek P2P client) and **Navidrome** (music streaming server) behind a single API, web UI, and CLI. Downloads from Soulseek land in a shared folder that Navidrome streams from — the DownloadWatcher triggers library rescans automatically.

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
NicotinD (Hono API :8484)
├── slskd (Soulseek client :5030)  ─┐
└── Navidrome (streaming :4533)     ─┤── shared /data/music folder
                                     └── DownloadWatcher triggers rescan on completion
```

**Bun monorepo** with workspace packages:

| Package | Purpose |
|---------|---------|
| `@nicotind/core` | Shared types (Zod schemas), logger (pino), crypto utils, error classes |
| `@nicotind/slskd-client` | Typed HTTP client wrapping slskd's REST API (`/api/v0/*`) |
| `@nicotind/navidrome-client` | Typed HTTP client wrapping Navidrome's Subsonic API (`/rest/*`) |
| `@nicotind/service-manager` | Strategy pattern for managing sub-service lifecycle (child_process or Docker) |
| `@nicotind/api` | Hono API server — routes, JWT auth, unified search, download watcher, SQLite DB |
| `@nicotind/web` | Angular v22 web UI (standalone components, signals, Tailwind) |
| `@nicotind/cli` | Commander.js CLI (Phase 3) |

**Entry point**: `src/main.ts` — loads config, starts services, wires clients into the API server.

## Key Design Patterns

- **Unified search**: `GET /api/search?q=` queries Navidrome locally first, fires slskd network search in parallel. Client polls `/api/search/:id/network` for Soulseek results. Local results display above a divider, network results below with download actions.
- **Inline download lifecycle**: Search result cards show a 3-state machine (idle → blue progress wash + % → green "▶ Open in Library"). Driven by `TransferService`. When a transfer completes, a `libraryDirty` signal triggers Library auto-refresh.
- **Multi-user**: Shared music library (all users see all downloads). Per-user settings and playlists stored in bun:sqlite (`packages/api/src/db.ts`). First registered user becomes admin.
- **Service modes**: `embedded` (NicotinD spawns slskd/navidrome as child processes) or `external` (connects to pre-existing instances via URLs).
- **Subsonic proxy**: `/rest/*` transparently forwards to Navidrome so existing mobile apps (DSub, Symfonium) work unmodified.
- **Auth flow**: NicotinD issues its own JWTs. Internally holds auto-generated credentials for slskd (API key) and Navidrome (Subsonic token auth: `md5(password+salt)`).
- **Auto-playlists**: `AutoPlaylistService` (`packages/api/src/services/auto-playlist.service.ts`) runs after each Navidrome scan — single-file downloads → "All Singles", multi-file folder downloads → playlist named after the cleaned folder. Owned by the admin Navidrome user.
- **Singles vs album classification**: `LibraryOrganizer` places tracks at `<Artist>/<Album>/<Track>` when an album is known, or `<Artist>/Singles/` as fallback. For **multi-file** downloads, `classifyFolder` in `compilation-tagger.ts` derives the album from the peer folder name (single-artist consolidation path). For **single-file** downloads, `deriveFolderTags` in `library-organizer.ts` calls `inferFolderAlbum` (`path-inference.ts`) to derive the album from the peer directory's leaf segment when the ID3 album tag is missing — a common situation with Soulseek peers. Generic folder names ("downloads", "src", "music", etc.) and folders that just echo the artist name are blocked by `looksLikeGenericFolder` so they don't become fake albums. Files that were mislabeled as Singles before this fix can be repaired with `bun run packages/api/src/scripts/repair-singles.ts`.
- **Catalog (metadata-driven) search**: the main search is metadata-first. `CatalogService` (`packages/api/src/services/catalog-search.service.ts`, routes at `/api/catalog`) looks the query up against Lidarr/MusicBrainz (`artist.lookup`/`album.lookup`) and returns structured artist/album cards. Selecting an album calls `POST /api/catalog/resolve`, which **adds the artist to Lidarr on demand** (via the shared `addArtistFromLookup` helper in `lidarr-provision.ts`, also used by discography) to obtain the canonical tracklist, then reuses the existing album-hunt flow (`/api/discography/albums/:id/hunt`) unchanged. Raw slskd file search (`/api/search`) remains as an **always-visible fallback** section below the metadata cards, and is the only path when Lidarr is unconfigured (the `/api/catalog` route isn't mounted, and the web search view degrades gracefully). Trade-off accepted: every hunted album becomes a monitored Lidarr artist — consistent with the pre-existing discography behavior.
- **Album hunt — soft-ban bypass ("skew search")**: `AlbumHunterService.hunt` (`packages/api/src/services/album-hunter.service.ts`) normally fires `Artist Album` / `Artist - Album` against slskd. slskd/Soulseek silently returns **zero** responses for some exact phrases (a server-side soft ban) even when the files exist. When `skewSearch` is set on the `POST .../hunt` body (the album-hunt modal's "Skew search" checkbox, **on by default** — uncheck to force unmodified queries) **and** no base candidate is confidently complete (best `matchPct < SKEW_TRIGGER_PCT`, ~67% — not just when the base is *empty*, since one junk 10% partial would otherwise suppress skew entirely), `hunt` also runs the textually-skewed variants from the exported pure `buildSkewedQueries` (reorder, album-only, drop leading "the", artist + first album word; de-duped and never re-running a base query) and **merges** them with the base via `mergeCandidates` (de-duped by `username::directory`, higher score wins). A confidently-complete base adds zero extra searches. The shared search→poll→score body lives in the private `searchAndScore` so both passes reuse it. **Matching is diacritic-insensitive**: `normalizeTitle` NFD-decomposes then strips combining marks (`"canción"`/`"cancion"` → `"cancion"`) so accented Latin-American titles match peers' unaccented spellings — used by both hunt scoring and the fallback. `HUNT_TIMEOUT_MS` is 45s so slow/queued peers surface before scoring.
- **Album hunt — cross-peer fallback (duplication fix)**: `AlbumFallbackService` (`packages/api/src/services/album-fallback.service.ts`) recovers tracks the chosen folder *promised but the peer failed to deliver*. Its recovery target is the **primary folder's own file manifest** (`target_files_json`, the files the user actually selected at `hunt-download` time) — **not** the canonical Lidarr tracklist. Why: Lidarr often returns a bloated deluxe/special-edition tracklist (e.g. "Circus" = 24 tracks incl. live/acoustic/bonus cuts) that no single Soulseek folder contains, so a canonical-targeted `missing` set is *permanently* non-empty — the fallback then exhausts all attempts dumping near-complete duplicate rips (`02 - Circus (2).mp3`, `(3)`…) into one `<Artist>/<Album>` folder, and Navidrome splits that folder by embedded `mbz_album_id` into several duplicate album cards. Targeting the manifest means a folder that downloads in full is `done` immediately and never triggers a fallback wave; genuinely-failed primary tracks are still recovered from alternates. Legacy jobs without a stored manifest fall back to canonical titles (`parseTargets`). **Fresh per-track recovery**: when the recorded alternates (a hunt-time snapshot — often offline by the time the primary fails) can't cover a missing track, `sweep` fires a *live* slskd search per still-missing track (`"<artist> <track>"`, using the `artist_name` column captured at `hunt-download`) and enqueues the healthiest matching file from any peer — tracks already in flight from a prior wave are skipped. This is what converts would-be `exhausted` jobs into `done`. Each wave counts against `fallbackMaxAttempts` (config `downloads.fallbackMaxAttempts`, default 5) so the loop terminates; legacy rows with no `artist_name` keep the old alternates-only behavior. The incomplete-album surface lists these jobs via `GET /api/discography/jobs?state=exhausted|active|incomplete|all` (joined to `album_title`/`artist_name`).
- **Album deletion (reliability)**: `DELETE /api/library/albums/:id` (`packages/api/src/routes/library.ts`) is **folder-first**: `tryDeleteAlbumFolder` recursively removes the album's `<Artist>/<Album>` directory in one `rmSync` (taking cover art + sidecars with it) when all tracks share one album-specific folder, guarded against the music root, bare `<Artist>` roots, shared `Singles` folders, and folders holding foreign audio; otherwise it falls back to the per-file `deleteOne` chain. It then **synchronously** deletes the canonical rows (`library_songs`, `library_albums`, `completed_downloads`) and writes a row to **`library_album_tombstones`**, all in one transaction — the canonical tables are the only source the UI reads, so the deletion persists immediately. The handler triggers a Navidrome scan but **does not run `runSync` inline**: `NavidromeSyncer` skips re-adding tombstoned albums until a scan stops reporting them (then clears the tombstone), which closes the prior race where a sync running before the async scan finished resurrected the just-deleted album.
- **Duplicate prevention (two layers)**: shared logic lives in `packages/api/src/services/album-dedupe.ts` (`dupKey`/`pickKeeper`/`dedupeFolder`), reused by the manual `repair-album-dupes.ts` script. (1) **Format preference** — when config `downloads.preferFlacSkipMp3` is on, `LibraryOrganizer.placeFile` drops an incoming MP3 (and removes its source) if a same-title FLAC already sits in the destination album folder. (2) **Auto-dedupe** — after each batch, `organizeBatch` runs `dedupeFolder` on every real `<Artist>/<Album>` dir it touched (never `Singles`/unsorted), removing collision-suffix/mixed-format true copies and returning `dedupedBasenames` so `DownloadWatcher` prunes the matching `completed_downloads` rows. On by default (`autoDedupe`).
- **Navidrome restart resilience**: `ServiceManager.startNavidrome` (`packages/service-manager/src/manager.ts`) goes through `startWithRetry` (up to `NAVIDROME_START_ATTEMPTS=3`, `START_RETRY_BACKOFF_MS` backoff). Navidrome occasionally exits early (code 2, stale-lock/port race) on the first start or two after an unclean shutdown; the dead process is stopped (freeing the port/lock) and the start retried in-process, instead of failing the whole boot (which previously meant ~90s of unavailability while the supervisor restarted everything). `startWithRetry` takes injectable `healthCheck`/`backoffMs` seams for deterministic tests.
- **Untracked downloads (legacy `relative_path`)**: rows predating the organizer have `relative_path IS NULL` and are invisible to playlist/deletion/tombstoning. `backfillRelativePaths` (`packages/api/src/services/untracked-backfill.ts`, CLI `scripts/backfill-untracked.ts`, dry-run unless `--apply`) indexes the music dir by basename and fills in unambiguous matches. `GET /api/library/untracked` (admin) lists the rows still lacking a path.

## Web UI

Angular v22 standalone SPA with signals (`signal()`, `computed()`, `effect()`), `HttpClient` + interceptors, and Angular Router with lazy-loaded routes. Built via `ng build` (uses esbuild under the hood). Tests run via `ng test` (vitest, integrated via `@angular/build:unit-test`).

### Theme System

CSS custom properties set via `[data-theme]` on `<html>`. Six built-in presets: **Midnight** (default), **Daylight**, **Warm Paper**, **OLED Black**, **Twilight**, **Forest**. Theme is persisted to localStorage (`nicotind-theme`) and applied before first paint (inline script in `index.html`) to avoid flash.

- Theme service: `packages/web/src/app/services/theme.service.ts` (Angular `signal()` + localStorage)
- Token definitions: `packages/web/src/styles.css` (`@layer base` — `:root` + per-`[data-theme]` overrides)
- Settings UI: Settings → Appearance — swatch grid + "Follow system theme" toggle
- Cover art: `packages/web/src/app/components/cover-art/cover-art.component.ts` — `<img>` with deterministic gradient fallback based on `hash(artist + album)`

### Key Angular Patterns

- **Services with signals**: All Zustand stores became `@Injectable` services using `signal()` / `computed()` (no NgRx). 1:1 mapping: `PlayerService`, `TransferService`, `SearchService`, `ThemeService`, `RemotePlaybackService`, `PreserveService`, `AuthService`, `ListControlsService`.
- **`HttpClient` + `authInterceptor`**: All API calls return `Observable<T>`. The interceptor attaches Bearer tokens and handles 401/403 auto-logout.
- **Standalone components**: No NgModules. Every component declares its own `imports` array.
- **`effect()` for side effects**: Replaces React's `useEffect`. Used for audio playback coordination, auto-refresh on download completion, remote device sync.
- **Reactivity & event-handling conventions** (`why`: one consistent signal-first standard, no leaked subscriptions/listeners):
  - **State-shaped streams → `toSignal()`**: bridge an Observable that represents *current value* (e.g. the SW version stream in `update.service.ts`) into a read-only signal via `toSignal(...)`, rather than `.subscribe()`-ing into a writable signal.
  - **Subscription teardown → `takeUntilDestroyed(destroyRef)`**: never hand-roll `Subscription[]` arrays or `ngOnDestroy` unsubscribes for lifecycle cleanup. Inject `DestroyRef` and pipe `takeUntilDestroyed(this.destroyRef)` (used in `remote-playback.service.ts`, `settings.component.ts`, `layout.component.ts`). Keep a `Subscription` handle *only* when you need to cancel imperatively (e.g. restart a poll), not for teardown.
  - **RxJS stays where it's the right tool**: genuine multi-subscriber event streams keep using RxJS — the WebSocket message bus (`playback-ws.service.ts` `Subject`) and router events. Don't force-convert these to signals.
  - **Pointer-drag gestures → `createPointerDrag()`**: all `document` pointermove/one-shot pointerup drag gestures go through the shared `packages/web/src/app/lib/pointer-drag.ts` primitive, which owns the left-button guard, the `dragging` signal, and **automatic listener teardown via `DestroyRef`**. Do not hand-wire `document.addEventListener('pointermove'…)` in components.
- **`viewChild()` signal queries**: Replace React `useRef` for DOM element access (e.g. `<audio>` element).
- **Offline support**: `PreserveService` + IndexedDB layer (`preserve-store.ts`) for offline track caching with LRU eviction.
- **Player expand/collapse gesture**: The mini bar (`player.component`) shows a grab-handle pill and opens Now Playing on tap or swipe-up (`pointerdown` → distance/threshold; controls and the `[data-seek]` bar are excluded). The Now Playing sheet (`now-playing.component`) dismisses with a **live-follow** drag: `dragOffsetPx`/`dragging` signals bind `[style.transform]` (downward-only) and toggle `transition-none` so it tracks the finger and snaps closed past a threshold. Pointer wiring for all three (mini-bar open, sheet dismiss, `folder-browser` resize) goes through the shared `createPointerDrag()` primitive (`packages/web/src/app/lib/pointer-drag.ts`), which handles the document `pointermove`/once `pointerup` lifecycle and auto-detaches on `DestroyRef`. Player text uses `translate="no"` + `.no-callout` to suppress the mobile translate/selection popup. Artist/album navigation lives only in Now Playing — the mini bar never navigates.

## Configuration

Config is loaded from `config/default.yml`, overridden by environment variables. See `.env.example` for all options. Key vars: `SOULSEEK_USERNAME`, `SOULSEEK_PASSWORD`, `NICOTIND_MODE`, `NICOTIND_MUSIC_DIR`.
