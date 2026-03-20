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
```

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
| `@nicotind/web` | React + Vite web UI (Phase 2) |
| `@nicotind/cli` | Commander.js CLI (Phase 3) |

**Entry point**: `src/main.ts` — loads config, starts services, wires clients into the API server.

## Key Design Patterns

- **Unified search**: `GET /api/search?q=` queries Navidrome locally first, fires slskd network search in parallel. Client polls `/api/search/:id/network` for Soulseek results. Local results display above a divider, network results below with download actions.
- **Multi-user**: Shared music library (all users see all downloads). Per-user settings and playlists stored in bun:sqlite (`packages/api/src/db.ts`). First registered user becomes admin.
- **Service modes**: `embedded` (NicotinD spawns slskd/navidrome as child processes) or `external` (connects to pre-existing instances via URLs).
- **Subsonic proxy**: `/rest/*` transparently forwards to Navidrome so existing mobile apps (DSub, Symfonium) work unmodified.
- **Auth flow**: NicotinD issues its own JWTs. Internally holds auto-generated credentials for slskd (API key) and Navidrome (Subsonic token auth: `md5(password+salt)`).

## Configuration

Config is loaded from `config/default.yml`, overridden by environment variables. See `.env.example` for all options. Key vars: `SOULSEEK_USERNAME`, `SOULSEEK_PASSWORD`, `NICOTIND_MODE`, `NICOTIND_MUSIC_DIR`.
