# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **`viewChild()` signal queries**: Replace React `useRef` for DOM element access (e.g. `<audio>` element).
- **Offline support**: `PreserveService` + IndexedDB layer (`preserve-store.ts`) for offline track caching with LRU eviction.

## Configuration

Config is loaded from `config/default.yml`, overridden by environment variables. See `.env.example` for all options. Key vars: `SOULSEEK_USERNAME`, `SOULSEEK_PASSWORD`, `NICOTIND_MODE`, `NICOTIND_MUSIC_DIR`.
