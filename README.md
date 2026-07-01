# NicotinD

Unified music acquisition + streaming platform. NicotinD orchestrates [slskd](https://github.com/slskd/slskd) (Soulseek P2P client) behind a single API and web UI — files downloaded via Soulseek are scanned into a native library and streamed directly by NicotinD.

## Quick Start (Docker)

```bash
git clone https://github.com/kevinch3/NicotinD.git
cd NicotinD
docker compose up -d
```

Open `http://localhost:8484`. The setup wizard walks you through:

1. **Create admin account**
2. **Soulseek credentials** (optional, skip and configure later)

No `.env` file or manual config needed.

The Docker Compose stack wires NicotinD and the bundled slskd container to the same web credentials by default (`slskd` / `slskd`). If you change those credentials, set `SLSKD_USERNAME` and `SLSKD_PASSWORD` for both services.

## How it works

```
docker compose up
┌──────────────────────────────────────────────────────┐
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  nicotind  :8484                             │   │
│  │  (API + web UI + native library + streaming) │   │
│  └─────────────────────┬────────────────────────┘   │
│                         │                            │
│            ┌────────────┘                            │
│            ▼                                         │
│  ┌──────────────┐                                    │
│  │  slskd       │                                    │
│  │  :5030       │                                    │
│  │  (internal)  │                                    │
│  └──────┬───────┘                                    │
│         │          shared volume                     │
│         └──────────► /data/music ◄── LibraryScanner  │
│                                                      │
│  Exposed to host: only port 8484                    │
└──────────────────────────────────────────────────────┘
```

- **NicotinD** — Hono API + Angular web UI (port 8484, the only exposed port). Includes the native `LibraryScanner` (reads tags via `music-metadata`, stores in SQLite), HTTP range-served audio streaming, and cover art resolution.
- **slskd** — Soulseek client (internal only), downloads to shared music volume. NicotinD's `DownloadWatcher` picks up completed transfers, organizes them, and scans them into the library.

### Unified search

A single search query hits both your local library and the Soulseek network:

1. **Local results** appear instantly (from the SQLite library)
2. **Network results** stream in below a divider (from Soulseek)
3. Downloading a network result adds it to your local library

### Multi-user

- Shared music library — everyone sees all downloads
- Per-user settings (stored in SQLite)
- First registered user becomes admin

## Docker Compose Details

### Volumes

| Volume | Purpose |
|--------|---------|
| `music` | Shared music directory (slskd writes, NicotinD scans and streams) |
| `nicotind-data` | NicotinD SQLite database and secrets |
| `slskd-data` | slskd application directory (`/app`, including config and state) |
| `lidarr-config` | Lidarr database and config |

### Using a host directory for music

Replace the `music` volume with a bind mount in `docker-compose.override.yml`:

```yaml
services:
  nicotind:
    volumes:
      - /path/to/your/music:/data/music
  slskd:
    volumes:
      - /path/to/your/music:/data/music
```

## Local Development (without Docker)

### Requirements

- [Bun](https://bun.sh/) >= 1.1

### Setup

```bash
bun install

# Copy and edit config
cp .env.example .env
# Set SOULSEEK_USERNAME and SOULSEEK_PASSWORD

# Run (embedded mode — auto-downloads slskd binary on first run)
bun run src/main.ts
```

### Commands

```bash
bun run typecheck    # TypeScript type checking
bun run lint         # ESLint
bun run format       # Prettier
bun run test         # Run all source tests (ignores dist artifacts)
bun run test:tdd     # Watch mode + bail fast for red/green loop
bun run test:api     # Run API package tests only
bun run test:web     # Run web package tests only
bun run test:coverage # Generate text + lcov coverage report
bun run dev          # Dev mode (concurrent services)
```

### TDD Workflow

Use this loop for all new features and bug fixes:

1. Write a failing test close to the behavior (`*.test.ts` for API/core packages, `*.spec.ts` for web package).
2. Run `bun run test:tdd` and keep the scope focused (`bun run test:api` or `bun run test:web` when useful).
3. Implement the smallest change to make the test pass.
4. Refactor with tests still green.
5. Before merging, run `bun run test` and `bun run test:coverage`.

Conventions:

- Keep unit tests deterministic: use in-memory fakes/mocks for network/process-heavy dependencies.
- Add a regression test before fixing any reported bug.
- Avoid testing build output; test source paths only.
- Web package tests use vitest (via Angular's `@angular/build:unit-test` builder). API/core tests use `bun:test`.

## Configuration

Configuration is loaded from `config/default.yml` and can be overridden with environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `NICOTIND_PORT` | `8484` | API server port |
| `NICOTIND_DATA_DIR` | `~/.nicotind` | Data directory (SQLite DB, secrets) |
| `NICOTIND_MUSIC_DIR` | `~/Music` | Shared music folder |
| `NICOTIND_MODE` | `embedded` | `embedded` (manage sub-services) or `external` (connect to existing) |
| `NICOTIND_METADATA_FIX_ENABLED` | `true` | Auto-repair missing MP3 tags after download |
| `NICOTIND_METADATA_FIX_MIN_SCORE` | `85` | Minimum MusicBrainz match score (0-100) for auto-fill |
| `SOULSEEK_USERNAME` | — | Your Soulseek account username |
| `SOULSEEK_PASSWORD` | — | Your Soulseek account password |
| `SLSKD_USERNAME` | `slskd` | slskd web login username |
| `SLSKD_PASSWORD` | `slskd` | slskd web login password |
| `NICOTIND_SLSKD_URL` | `http://localhost:5030` | slskd URL (external mode only) |

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/setup/status` | Check if initial setup is needed |
| `POST` | `/api/setup/complete` | Complete initial setup (create admin, configure services) |
| `POST` | `/api/auth/register` | Register a new user |
| `POST` | `/api/auth/login` | Login, returns JWT |
| `GET` | `/api/search?q=` | Unified search (local + network) |
| `GET` | `/api/search/:id/network` | Poll for Soulseek results |
| `POST` | `/api/downloads` | Enqueue a download from Soulseek |
| `GET` | `/api/downloads` | List active downloads |
| `GET` | `/api/library/artists` | Browse artists |
| `GET` | `/api/library/albums` | Browse albums |
| `GET` | `/api/library/recent-songs` | Recently added songs |
| `GET` | `/api/stream/:id` | Stream audio |
| `GET` | `/api/cover/:id` | Album/artist cover art |
| `GET` | `/api/system/status` | Service health status |
| `POST` | `/api/system/scan` | Trigger library rescan |

Routes under `/api/setup/*` are public (locked after first user is created). Routes under `/api/auth/*` use their own auth. All other `/api/*` routes require a `Bearer` JWT token.

## Project Structure

```
packages/
  core/                # Shared types, Zod schemas, logger, crypto utils
  slskd-client/        # Typed HTTP client for slskd REST API
  service-manager/     # Sub-service lifecycle management (strategy pattern)
  api/                 # Hono API server, routes, JWT auth, native library scanner + streaming, SQLite DB
  web/                 # Angular v22 web UI (standalone components, signals, Tailwind)
  cli/                 # CLI (planned)
src/
  main.ts              # Entry point — loads config, starts services, serves API
config/
  default.yml          # Default configuration
```

## License

MIT
