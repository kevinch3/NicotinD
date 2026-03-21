# NicotinD

Unified music acquisition + streaming platform. NicotinD orchestrates [slskd](https://github.com/slskd/slskd) (Soulseek P2P client) and [Navidrome](https://www.navidrome.org/) (music streaming server) behind a single API — files downloaded via Soulseek instantly become streamable.

## Quick Start (Docker)

```bash
git clone https://github.com/your-user/NicotinD.git
cd NicotinD
docker compose up -d
```

Open `http://localhost:8484`. The setup wizard walks you through:

1. **Create admin account**
2. **Soulseek credentials** (optional, skip and configure later)
3. **Tailscale auth key** (optional, for remote access from your phone)

No `.env` file or manual config needed.

The Docker Compose stack wires NicotinD and the bundled slskd container to the same web credentials by default (`slskd` / `slskd`). If you change those credentials, set `SLSKD_USERNAME` and `SLSKD_PASSWORD` for both services.

## How it works

```
docker compose up
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  ┌──────────────┐  shares network   ┌──────────────┐   │
│  │  tailscale   │◄────────────────► │  nicotind    │   │
│  │  (sidecar)   │                   │  :8484       │   │
│  └──────────────┘                   └──────┬───────┘   │
│                                       │         │       │
│            ┌──────────────────────────┘         │       │
│            ▼                                    ▼       │
│  ┌──────────────┐                    ┌──────────────┐  │
│  │  slskd       │                    │  navidrome   │  │
│  │  :5030       │                    │  :4533       │  │
│  │  (internal)  │                    │  (internal)  │  │
│  └──────┬───────┘                    └──────┬───────┘  │
│         │          shared volume            │          │
│         └──────────► /data/music ◄──────────┘          │
│                                                         │
│  Exposed to host: only port 8484                       │
└─────────────────────────────────────────────────────────┘
```

- **NicotinD** — Hono API + React web UI (port 8484, the only exposed port)
- **slskd** — Soulseek client (internal only), downloads to shared music volume
- **Navidrome** — Music streaming server (internal only), reads from shared music volume
- **Tailscale** — Sidecar container for secure remote access via your tailnet

NicotinD manages both services as child processes (embedded mode) or connects to existing instances (external mode). A **DownloadWatcher** polls slskd for completed transfers, repairs missing MP3 metadata from filename patterns + MusicBrainz lookup, and then triggers Navidrome library rescans automatically.

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

## Remote Access with Tailscale

NicotinD includes built-in Tailscale integration for secure remote access — no port forwarding, no dynamic DNS, no VPN config.

### How it works

The Tailscale container runs as a sidecar sharing NicotinD's network stack (`network_mode: service:nicotind`). When connected to your tailnet, NicotinD becomes accessible at a stable hostname like `nicotind.your-tailnet.ts.net:8484`.

### Setup

You can provide your Tailscale auth key in two ways:

- **Setup wizard** (recommended) — paste it in step 3 during first-run setup
- **Settings page** — configure it later from Settings > Tailscale Remote Access

### Getting a Tailscale auth key

1. Go to the [Tailscale admin console](https://login.tailscale.com/admin/settings/keys)
2. Generate an auth key (reusable recommended)
3. Paste it into NicotinD

### Accessing from mobile

1. Install [Tailscale](https://tailscale.com/download) on your phone
2. Sign in with the same Tailscale account
3. Open `http://nicotind:8484` in your mobile browser

## Docker Compose Details

### Volumes

| Volume | Purpose |
|--------|---------|
| `music` | Shared music directory (slskd writes, navidrome reads) |
| `nicotind-data` | NicotinD SQLite database and secrets |
| `slskd-data` | slskd application directory (`/app`, including config and state) |
| `navidrome-data` | Navidrome database and cache |
| `tailscale-state` | Tailscale persistent state (survives restarts) |
| `tailscale-sock` | Shared Unix socket for NicotinD to control Tailscale |

### Using a host directory for music

Replace the `music` volume with a bind mount in `docker-compose.yml`:

```yaml
services:
  nicotind:
    volumes:
      - /path/to/your/music:/data/music
  slskd:
    volumes:
      - /path/to/your/music:/data/music
  navidrome:
    volumes:
      - /path/to/your/music:/data/music:ro
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

# Run (embedded mode — auto-downloads slskd + navidrome binaries)
bun run src/main.ts
```

### Commands

```bash
bun run typecheck    # TypeScript type checking
bun run lint         # ESLint
bun run format       # Prettier
bun run test         # Run tests
bun run dev          # Dev mode (concurrent services)
```

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
| `NICOTIND_NAVIDROME_URL` | `http://localhost:4533` | Navidrome URL (external mode only) |
| `TAILSCALE_SOCKET` | `/var/run/tailscale/tailscaled.sock` | Tailscale daemon socket path |

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
| `GET` | `/api/system/status` | Service health status |
| `POST` | `/api/system/scan` | Trigger library rescan |
| `GET` | `/api/tailscale/status` | Tailscale connection status |
| `POST` | `/api/tailscale/connect` | Connect to Tailscale (admin) |
| `POST` | `/api/tailscale/disconnect` | Disconnect from Tailscale (admin) |
| `*` | `/rest/*` | Subsonic API proxy to Navidrome |

Routes under `/api/setup/*` are public (locked after first user is created). Routes under `/api/auth/*` and `/rest/*` use their own auth. All other `/api/*` routes require a `Bearer` JWT token.

## Project Structure

```
packages/
  core/                # Shared types, Zod schemas, logger, crypto utils
  slskd-client/        # Typed HTTP client for slskd REST API
  navidrome-client/     # Typed HTTP client for Navidrome Subsonic API
  service-manager/      # Sub-service lifecycle management (strategy pattern)
  api/                  # Hono API server, routes, JWT auth, SQLite DB
  web/                  # React + Vite web UI
  cli/                  # CLI (planned)
src/
  main.ts              # Entry point — loads config, starts services, serves API
config/
  default.yml          # Default configuration
```

## License

MIT
