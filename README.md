# NicotinD

Unified music acquisition + streaming platform. NicotinD orchestrates [slskd](https://github.com/slskd/slskd) (Soulseek P2P client) and [Navidrome](https://www.navidrome.org/) (music streaming server) behind a single API — files downloaded via Soulseek instantly become streamable.

## How it works

```
NicotinD (:8484)
├── slskd (:5030)       ─┐
└── Navidrome (:4533)    ─┤── shared music folder
                          └── auto-rescan on download completion
```

NicotinD manages both services as child processes (embedded mode) or connects to existing instances (external mode). A **DownloadWatcher** polls slskd for completed transfers and triggers Navidrome library rescans automatically.

### Unified search

A single search query hits both your local library and the Soulseek network:

1. **Local results** appear instantly (from Navidrome)
2. **Network results** stream in below a divider (from Soulseek)
3. Downloading a network result adds it to your local library

### Multi-user

- Shared music library — everyone sees all downloads
- Per-user settings and playlists (stored in SQLite)
- First registered user becomes admin

### Subsonic compatibility

The `/rest/*` proxy passes requests through to Navidrome, so existing Subsonic clients (DSub, Symfonium, play:Sub) work out of the box.

## Requirements

- [Bun](https://bun.sh/) >= 1.1
- [slskd](https://github.com/slskd/slskd) binary (embedded mode) or running instance (external mode)
- [Navidrome](https://www.navidrome.org/) binary (embedded mode) or running instance (external mode)

## Quick start

```bash
# Install dependencies
bun install

# Copy and edit config
cp .env.example .env
# Set SOULSEEK_USERNAME and SOULSEEK_PASSWORD

# Run
bun run src/main.ts
```

NicotinD starts on `http://localhost:8484`. Register a user via the API to get started:

```bash
# Register (first user becomes admin)
curl -X POST http://localhost:8484/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username": "admin", "password": "yourpassword"}'

# Login — returns a JWT
curl -X POST http://localhost:8484/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username": "admin", "password": "yourpassword"}'

# Search (use the JWT from login)
curl -H 'Authorization: Bearer <token>' \
  'http://localhost:8484/api/search?q=artist+name'

# System status
curl -H 'Authorization: Bearer <token>' \
  http://localhost:8484/api/system/status
```

## Configuration

Configuration is loaded from `config/default.yml` and can be overridden with environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `NICOTIND_PORT` | `8484` | API server port |
| `NICOTIND_DATA_DIR` | `~/.nicotind` | Data directory (SQLite DB, logs, service configs) |
| `NICOTIND_MUSIC_DIR` | `~/Music` | Shared music folder (slskd downloads here, Navidrome reads from here) |
| `NICOTIND_MODE` | `embedded` | `embedded` (manage sub-services) or `external` (connect to existing) |
| `SOULSEEK_USERNAME` | — | Your Soulseek account username |
| `SOULSEEK_PASSWORD` | — | Your Soulseek account password |
| `NICOTIND_SLSKD_URL` | `http://localhost:5030` | slskd URL (external mode only) |
| `NICOTIND_NAVIDROME_URL` | `http://localhost:4533` | Navidrome URL (external mode only) |

## API routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/register` | Register a new user |
| `POST` | `/api/auth/login` | Login, returns JWT |
| `GET` | `/api/search?q=` | Unified search (local + network) |
| `GET` | `/api/search/:id/network` | Poll for Soulseek results |
| `POST` | `/api/downloads` | Enqueue a download from Soulseek |
| `GET` | `/api/downloads` | List active downloads |
| `GET` | `/api/library/artists` | Browse artists |
| `GET` | `/api/library/albums` | Browse albums |
| `GET` | `/api/library/songs` | Browse songs |
| `GET` | `/api/stream/:id` | Stream audio |
| `GET` | `/api/system/status` | Service health status |
| `POST` | `/api/system/scan` | Trigger library rescan |
| `*` | `/rest/*` | Subsonic API proxy to Navidrome |

All routes except `/api/auth/*` and `/rest/*` require a `Bearer` JWT token.

## Development

```bash
bun install            # Install dependencies
bun run typecheck      # TypeScript type checking
bun run lint           # ESLint
bun run format         # Prettier
bun run dev            # Dev mode (concurrent services)
```

## Project structure

```
packages/
  core/                # Shared types, Zod schemas, logger, crypto utils
  slskd-client/        # Typed HTTP client for slskd REST API
  navidrome-client/     # Typed HTTP client for Navidrome Subsonic API
  service-manager/      # Sub-service lifecycle management (strategy pattern)
  api/                  # Hono API server, routes, JWT auth, SQLite DB
  cli/                  # CLI (planned)
  web/                  # Web UI (planned)
src/
  main.ts              # Entry point — loads config, starts services, serves API
config/
  default.yml          # Default configuration
```

## License

MIT
