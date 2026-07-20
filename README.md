# NicotinD

Unified music acquisition + streaming platform. NicotinD orchestrates [slskd](https://github.com/slskd/slskd) (Soulseek P2P client) and the Lidarr metadata API behind a single API, web UI, CLI, and native **Android/iOS apps** — files downloaded from any source are scanned into a native library, streamed with HTTP range support, and can be **preserved for offline playback** or **remotely cast to any device** Spotify-Connect-style.

## Quick Start (Docker)

```bash
git clone https://github.com/kevinch3/NicotinD.git
cd NicotinD
docker compose up -d
```

Open `http://localhost:8484`. The setup wizard walks you through:

1. **Create admin account**
2. **Soulseek credentials** (optional, skip and configure later)

No `.env` file or manual config needed. The server runs from the **published multi-arch image** (`ghcr.io/kevinch3/nicotind`, amd64 + arm64) — nothing compiles locally except the small analysis sidecar. The Docker Compose stack wires NicotinD and the bundled slskd container to the same web credentials by default (`slskd` / `slskd`). If you change those, set `SLSKD_USERNAME` and `SLSKD_PASSWORD` for both services. Full install/upgrade/rollback detail: [docs/deployment.md](docs/deployment.md).

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
│  │  slskd       │         shared volume             │
│  │  :5030       │ ─────► /data/music ◄── Library    │
│  │  (internal)  │                Scanner            │
│  └──────────────┘                                    │
│                                                      │
│  Exposed to host: only port 8484                    │
└──────────────────────────────────────────────────────┘
```

- **NicotinD** — Hono API + Angular web UI (port 8484, the only exposed port). Includes the native `LibraryScanner` (reads tags via `music-metadata`, stores in SQLite), HTTP range-served audio streaming, cover art resolution, **remote-playback WebSocket**, **preserved-track IndexedDB serving**, **plugin-sourced metadata** (Lidarr/MusicBrainz, LRCLIB lyrics, Spotify fallback), and **offline enrichment** (BPM/key/genre/artist-image).
- **slskd** — Soulseek client (internal only), downloads to the shared music volume. NicotinD's `DownloadWatcher` picks up completed transfers, organizes them, runs the source-agnostic organizer + incremental scan, and exposes them in the library.

---

## Key features

### 🎵 Source-agnostic acquisition
A single search query hits both your local library and the Soulseek network; **every acquirable result is a normalized `AcquisitionCandidate`** (slskd, archive.org, spotdl via spotify.com URLs) rendered in one blended, ranked list with a neutral source chip and one **Get** action. Adding a new source = one adapter + a pure mapper — no route or UI change. See [docs/source-agnostic-acquisition.md](docs/source-agnostic-acquisition.md).

- **Album hunt modal**: guided acquisition flow that auto-picks the best candidate, surfaces format/size/match% confidence, and falls back to per-track when 0 folders match. See [docs/album-hunt.md](docs/album-hunt.md).
- **Watchlist auto-hunt**: star catalog albums; a poller auto-hunts and downloads on a confident match.
- **Plugin architecture**: acquisition is opt-in. Default plugins: `slskd`, `yt-dlp`, `spotdl`, `archive.org`, `spotify` (metadata-only). See [docs/plugins.md](docs/plugins.md).
- **One album = one download** (idempotent hunt): 409 guards + only-missing-tracks enqueue; "already have it" surfaces as a positive notice, not a red error.

### 📡 Remote playback (Spotify-Connect-style)
Any browser tab or mobile device can become a playback receiver; one device browses and controls, another plays the audio. See [docs/remote-playback.md](docs/remote-playback.md).

- **WebSocket transport** (`GET /api/ws/playback`) — per-user `PlaybackStateManager` keeps a single shared state object (`activeDeviceId`, `isPlaying`, `volume`, `position`, `queue`, `track`).
- **Device switcher** in the mini-player (speaker icon 🖥️) lists all connected devices; switching streams the current track to the chosen target.
- **Heartbeat + auto-reconnect** with exponential backoff (1s → 30s cap).
- **Opt-in** per device in **Settings → Remote Playback**; auto-disables with a reason on persistent failure.
- **Cloudflare note**: enable **Network → WebSockets** in the dashboard or the `101 Switching Protocols` upgrade will be dropped.

### 💾 Preserve mode (offline downloads)
Save tracks and collections to your device for offline playback. See [docs/web-ui.md](docs/web-ui.md) § "Offline downloads (preserve)".

- **Per-track action** ("Save offline" / "Remove download") on every track row, with a green `offline` dot indicator.
- **Collection-level download** on album/playlist/genre detail pages — `preserveCollection(key, …)` is keyed by a stable id so different collections download **in parallel** and each page shows only its own progress.
- **IndexedDB store** caches audio + cover blobs (`packages/web/src/app/lib/preserve-store.ts`); the player serves preserved tracks from IndexedDB and falls back to `/api/stream/:id`.
- **User-configurable storage budget** (1/2/5/10 GB or Unlimited) in **Settings → Offline storage**, with a live usage bar.
- **LRU eviction** for single-track saves; bulk path **stops at the cap** (`stoppedAtCap`) so a huge collection keeps what fit rather than thrashing the same batch.
- **Downloads → "Saved Offline" tab** manages the cache (search, sort, multiselect bulk delete).

### 📱 Native apps
The same Angular UI ships inside Capacitor shells for Android and iOS — **no second UI codebase**. See [docs/mobile-app.md](docs/mobile-app.md) and [docs/ios-app.md](docs/ios-app.md).

- **Server-picker** on first launch — point the app at any self-hosted NicotinD instance.
- **Android APK** attached to the GitHub Release on every tag (`v*`). CI signs with `ANDROID_KEYSTORE_*` secrets when present; otherwise an unsigned APK is attached (developers can `assembleRelease` locally).
- **iOS IPA** (unsigned, for **AltStore / Sideloadly** re-signing) attached to the same Release; no Apple Developer Program required.
- **Background audio + lock-screen controls** via `@jofr/capacitor-media-session` (Android foreground service) and the `@nicotind/capacitor-now-playing` Swift plugin (iOS, owns `MPNowPlayingInfoCenter` + `AVAudioSession`).
- **Branded native app icon + splash** generated from the shared brand SVG; the same mark as the PWA manifest icon and favicon.
- **CORS allowlist** for `https://localhost` / `http://localhost` / `capacitor://localhost` exposes `Content-Range`/`Accept-Ranges`/`Content-Length` so cross-origin 206 range streaming and seeking work in the WebView.
- **Safe-area header** + bottom-chrome stacking for notched iPhones.

### 🎚 Smart radio
Metadata-driven queue curation. When the queue runs low, `GET /api/radio/next` scores candidates by **BPM proximity, Camelot key compatibility, genre match, year, duration, and artist diversity**; the top matches are auto-appended. Toggle in the Now Playing sheet. See [docs/radio.md](docs/radio.md).

### 🎤 Lyrics (plugin-sourced, editable)
On-demand lyrics via the **`lrclib` plugin** (new `metadata` plugin kind + `lyrics` capability). Stored in `library_lyrics` + the file tag (`ID3 USLT` / Vorbis `LYRICS`); user-editable. The drawer shows plain + synced LRC. See [docs/design-patterns.md](docs/design-patterns.md) § "Lyrics".

### 🎨 Curated playlists
System-global, gradient-covered Spotify-style shelves shown to all users; read-only by `kind` (not ownership). See [docs/curated-playlists.md](docs/curated-playlists.md).

### 🔗 Share links
Short-lived, read-only, non-refreshable tokens for albums and playlists. The server renders **OG/Twitter link previews** at `GET /share/:token` for crawlers (Slack/iMessage/Discord) so shared links show real thumbnails. See [docs/web-ui.md](docs/web-ui.md) § "Sharing albums & playlists".

### 🧠 Metadata optimization
- **Cover picker + free-text + Lidarr candidate search** (admin) to fix wrong artist/album on persisted `library_metadata_overrides`.
- **Bulk Lidarr re-fetch** (`optimizeAllAlbums`) for cover/year/release-type, all-or-nothing per album; skips placeholder-artist albums.
- **On-demand track analysis (BPM + genre)** in the track-info drawer; writes the **DB and the file tag**.
- **Windowed background enrichment** (bpm/genre/key/artist-image) runs only inside a daily window via an extensible task registry.

### 🧹 Library quality auditor
Assert (audit) + clean (repair/retag) + prevent (ingest sanitize) for DJ-pool/VA-source pollution across DB + disk. See [docs/library-audit.md](docs/library-audit.md).

### 🗂 Singles & EPs (Spotify-style)
Every album carries a `classification` (`album` | `ep` | `single` | `compilation` | `unknown`), set metadata-first (Lidarr/MusicBrainz) with a track-count heuristic fallback. Singles surface on the artist's **Singles & EPs** section + a dedicated Library **Singles** mode. See [docs/download-pipeline.md](docs/download-pipeline.md) § "Release-type model".

### 🧰 Native playlists
Per-user `playlists`/`playlist_songs` with create/rename/delete/share; visible to owner only by default. See [docs/web-ui.md](docs/web-ui.md) § "Native playlists".

### 📦 More
- **Multi-user**: shared music library, per-user settings in SQLite; first registered user becomes admin.
- **Multi-select + shift-click range** for bulk add/delete on album/playlist/genre detail pages.
- **E-Ink theme** (7 presets total): a high-contrast, larger-font theme for e-paper devices with `stroke-width: 3` icon outlines.
- **PWA**: installable, share-target for URL acquisition, persisted player queue across restarts.
- **Lossless → Opus** standardization (default-on 192 kbps) — FLAC transcoded to Opus in place; gated on `ffmpeg`.
- **Auto-dedupe + edition-collapsing** album IDs at ingest (FLAC > MP3, cross-edition folder consolidation).

---

## Docker Compose Details

### Docker images

The server ships as a multi-arch (amd64 + arm64) image on GHCR, published by CI on every release tag:

| Tag | Meaning | Use when |
|---|---|---|
| `release` | latest tagged release (compose default) | you just want current stable |
| `vX` | latest release of major `X` | you want upgrades without major bumps |
| `vX.Y.Z` | exact release | pinning / rollback |

There is deliberately **no `latest` tag** — `release` is the explicit equivalent and never points at an untagged build. Pin a version by setting `NICOTIND_VERSION=vX.Y.Z` in a `.env` file next to the compose file. Upgrade with `docker compose pull && docker compose up -d`; roll back by pinning the previous version (data is forward-migrated on boot — treat downgrades as best-effort and keep backups). To build from source instead (development, forks), add a `build: .` override — see `docker-compose.override.example.yml`. Details: [docs/deployment.md](docs/deployment.md).

### Volumes

| Volume | Purpose |
|--------|---------|
| `music` | Shared music directory (slskd writes, NicotinD scans and streams) |
| `nicotind-data` | NicotinD SQLite database, secrets, and artist-overrides |
| `slskd-data` | slskd application directory (`/app`, including config and state) |
| `lidarr-config` | Lidarr database and config (metadata optimization) |

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

---

## Local Development (without Docker)

### Requirements

- [Bun](https://bun.sh/) >= 1.1
- Node >= 22.22.3 (for `ng build`)

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
bun run typecheck        # TypeScript type checking
bun run lint             # ESLint
bun run format           # Prettier
bun run test             # Run all source tests (ignores dist artifacts)
bun run test:tdd         # Watch mode + bail fast for red/green loop
bun run test:api         # Run API package tests only
bun run test:web         # Run web package tests only
bun run test:coverage    # Generate text + lcov coverage report
bun run dev              # Dev mode (concurrent services)
```

### TDD workflow

1. Write a failing test close to the behavior (`*.test.ts` for API/core/packages, `*.spec.ts` for web).
2. Run `bun run test:tdd` and keep the scope focused (`bun run test:api` or `bun run test:web` when useful).
3. Implement the smallest change to make the test pass.
4. Refactor with tests still green.
5. Before merging, run `bun run test` and `bun run test:coverage`.

Conventions: keep unit tests deterministic (in-memory fakes for network/process-heavy deps), add a regression test before fixing any reported bug, and avoid testing build output.

---

## Releases — how they work and how to run one

One release = one `vX.Y.Z` git tag. Everything ships from that tag: the production server deploy **and** the app artifacts (Android APK, iOS IPA, desktop packages) attached to its GitHub Release. You never build a release by hand — you land commits and the pipeline does the rest.

### The day-to-day flow (this is the whole job)

1. **Land your work on `master` through a PR**, with [Conventional Commit](https://www.conventionalcommits.org/) messages (commitlint-enforced): `feat` → minor bump, `fix`/`perf` → patch, `!`/`BREAKING CHANGE:` → major. `chore`/`docs`/`refactor`/`test`/`ci` don't bump and won't appear in the changelog. Full table in [CLAUDE.md](CLAUDE.md#commit-conventions).
2. **Do nothing else.** When `ci.yml` goes green on the master push, its `release` job bumps the version from the commit history, regenerates `CHANGELOG.md`, commits `chore(release): X.Y.Z`, tags `vX.Y.Z`, and pushes the tag.
3. **The tag triggers `deploy.yml`**, which deploys the server and builds only the apps whose inputs actually changed since the previous release (a `changes` job diffs tag-to-tag) — an API-only release won't rebuild the APK or the desktop packages.
4. **Verify** (takes a minute):
   - Actions: `ci.yml` → release job pushed the tag; `deploy.yml` run for the tag is green.
   - The tag's **GitHub Release page** carries the expected artifacts.
   - The production server reports the new version (`GET /api/health` → `{ ok, version }`, Settings footer, or `GET /api/system/status`), and the in-app changelog modal (click the version string) shows the new entry.

If a merge contained only non-bumping types, no release is cut — that's by design, not a failure. The release job is also **idempotent**: it skips itself on `chore(release)` pushes and exits early if the computed tag already exists, so re-runs are always safe.

### What each release ships, and how it reaches people

| Artifact | Built when | How it reaches users |
|---|---|---|
| **Server image** | every tag | multi-arch image published to `ghcr.io/kevinch3/nicotind` (`vX.Y.Z` + `vX` + `release` tags); self-hosters `docker compose pull` |
| **Server (production host)** | every tag | auto-deployed over Tailscale SSH: pulls the just-published image — nothing to do |
| **Android APK** | mobile/web inputs changed | download from the GitHub Release and sideload ([details](#android-app)); signed when `ANDROID_KEYSTORE_*` secrets are present |
| **iOS IPA** (unsigned) | mobile/web inputs changed | re-sign + install via AltStore/Sideloadly ([details](#ios-app)) |
| **Desktop** Linux AppImage/deb + macOS dmg | desktop inputs changed | GitHub Release download; **existing installs auto-update** via electron-updater — Linux applies updates itself, macOS only notifies (ad-hoc signing) |

### When you need more than the default

- **Force a bigger bump** (e.g. a milestone minor with only fixes landed): on a clean, up-to-date `master` checkout run `bun run release:minor` (or `release:major`), then `git push --follow-tags origin master`. This is the same tool CI runs (`bun run release` = auto-detected bump), so the tag flows through `deploy.yml` identically.
- **Re-deploy the server without a new version** (e.g. after a deploy-host hiccup): Actions → `deploy.yml` → *Run workflow* — a manual dispatch checks out the tip of `master` on the host (compose files, scripts) but re-runs the current **`release` image** (no image is published from an untagged tip) and skips the app builds.
- **A deploy job failed but the tag exists**: fix the cause, then re-run the failed `deploy.yml` jobs from the Actions UI — don't re-tag.
- **Never hand-edit** `CHANGELOG.md` or the `package.json` version — both are generated; hand edits get overwritten by the next release and can break the version detection.

---

## Distribution

### Server
`docker compose up -d` on any Linux host — pulls `ghcr.io/kevinch3/nicotind:release` (amd64/arm64). CI (`.github/workflows/deploy.yml`) publishes the image on every `v*` tag (`docker` + `docker-merge` jobs) and then ships the production host via Tailscale SSH (`deploy` job). See [docs/deployment.md](docs/deployment.md).

### Android app
- CI builds the signed APK on every tag push (uses `ANDROID_KEYSTORE_*` secrets when present, otherwise an unsigned APK).
- The APK is attached to the **GitHub Release** of the tag — download and install directly on Android (you may need to allow "Install from unknown sources").
- Local build: `cd packages/mobile && bunx cap sync android && cd android && ./gradlew assembleRelease`.

### iOS app
- CI builds an **unsigned** `.ipa` on a `macos-14` runner (`ios` job) on every tag push.
- The unsigned IPA is attached to the GitHub Release — install via **AltStore** or **Sideloadly** (re-signs with your own Apple ID; 7-day expiry on a free ID, 1 year on a paid developer account).
- Future: when an Apple Developer Program is acquired, flip the CI to a signed build by adding signing secrets.

---

## Configuration

Configuration is loaded from `config/default.yml` and can be overridden with environment variables. See `.env.example` for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `NICOTIND_PORT` | `8484` | API server port |
| `NICOTIND_DATA_DIR` | `~/.nicotind` | Data directory (SQLite DB, secrets, artist-overrides) |
| `NICOTIND_MUSIC_DIR` | `~/Music` | Shared music folder |
| `NICOTIND_MODE` | `embedded` | `embedded` (manage sub-services) or `external` (connect to existing) |
| `NICOTIND_METADATA_FIX_ENABLED` | `true` | Auto-repair missing MP3 tags after download |
| `NICOTIND_METADATA_FIX_MIN_SCORE` | `85` | Minimum MusicBrainz match score (0-100) for auto-fill |
| `NICOTIND_TRANSCODE_LOSSLESS_ENABLED` | `true` | Transcode FLAC → Opus in place after download |
| `NICOTIND_TRANSCODE_LOSSLESS_BITRATE` | `192` | Opus bitrate in kbps |
| `SOULSEEK_USERNAME` | — | Your Soulseek account username |
| `SOULSEEK_PASSWORD` | — | Your Soulseek account password |
| `SLSKD_USERNAME` | `slskd` | slskd web login username |
| `SLSKD_PASSWORD` | `slskd` | slskd web login password |
| `NICOTIND_SLSKD_URL` | `http://localhost:5030` | slskd URL (external mode only) |

---

## API Routes

Public routes (no JWT): `/api/setup/*` (locked after first user), `/api/auth/*`, `/api/health`, `/api/ws/playback` (token in query), `/share/:token` (link preview), `/openapi.json`, `/doc`.

All other `/api/*` routes require a `Bearer` JWT (30-day sliding session, silent refresh on boot) or a read-only share token.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/setup/status` | Check if initial setup is needed |
| `POST` | `/api/setup/complete` | Complete initial setup (create admin, configure services) |
| `POST` | `/api/auth/register` | Register a new user |
| `POST` | `/api/auth/login` | Login, returns JWT |
| `POST` | `/api/auth/refresh` | Sliding-window refresh |
| `GET` | `/api/search?q=` | Unified search (local library + parallel network sources) |
| `GET` | `/api/search/:id/network` | Poll for Soulseek results |
| `POST` | `/api/acquire` | Acquire from a URL (YouTube/Spotify/archive.org) via plugins |
| `GET` | `/api/catalog/search` | Lidarr/MusicBrainz catalog search |
| `GET` | `/api/album-hunt/:id` | Score + candidates for a catalog album |
| `POST` | `/api/album-hunt/:id/hunt` | Two-phase hunt (base + skew queries) |
| `POST` | `/api/downloads` | Enqueue a download from Soulseek |
| `GET` | `/api/downloads` | Active downloads feed (slskd groups + URL jobs, normalized) |
| `GET` | `/api/acquire/jobs` | URL acquire jobs |
| `GET` | `/api/library/artists` | Browse artists |
| `GET` | `/api/library/albums` | Browse albums (excludes in-flight downloads) |
| `GET` | `/api/library/singles` | Browse singles & EPs |
| `GET` | `/api/library/recent-songs` | Recently added songs |
| `GET` | `/api/library/genres` | Browse by genre |
| `GET` | `/api/library/songs/:id/similar` | Similar songs (BPM/key/genre scoring) |
| `GET` | `/api/library/songs/:id/acquisition` | Acquisition provenance (how/where/when) |
| `GET` | `/api/library/songs/:id/lyrics` | Plain + synced lyrics |
| `POST` | `/api/library/songs/:id/lyrics/fetch` | Fetch lyrics from enabled plugins |
| `PUT` | `/api/library/songs/:id/lyrics` | Save custom lyrics (admin) |
| `DELETE` | `/api/library/albums/:id` | Delete album (folder-first) |
| `GET` | `/api/library/untracked` | Downloads with `relative_path IS NULL` (admin) |
| `GET` | `/api/stream/:id` | Stream audio (Range/206 + seekable transcode cache) |
| `GET` | `/api/cover/:id` | Album/artist cover art (override → canonical → folder → embedded) |
| `GET` | `/api/radio/next` | Smart radio — next track by metadata similarity |
| `GET` | `/api/playlists` | List user's playlists (+ curated for all users) |
| `POST` | `/api/playlists` | Create playlist |
| `GET` | `/api/playlists/:id` | Get playlist (songs) |
| `POST` | `/api/playlists/:id/songs` | Add songs (idempotent) |
| `DELETE` | `/api/playlists/:id/songs/:songId` | Remove a song |
| `GET` | `/api/share/:token` | Read-only share view (album/playlist) |
| `POST` | `/api/share` | Mint a share token (short-lived, read-only) |
| `GET` | `/api/watchlist` | Watchlist entries |
| `POST` | `/api/watchlist` | Toggle watch on a catalog album |
| `GET` | `/api/plugins` | List plugins + capability status |
| `POST` | `/api/plugins/:id/enable` | Enable a plugin (admin) |
| `POST` | `/api/plugins/:id/disable` | Disable a plugin (admin) |
| `GET` | `/api/system/status` | Service health status |
| `POST` | `/api/system/scan` | Trigger library rescan |
| `GET` | `/api/system/logs/stream` | SSE stream of Docker logs (admin) |
| `GET` | `/api/admin/transcode-library` | Lossless → Opus library migration (admin) |
| `GET` | `/api/ws/playback` | Remote-playback WebSocket |

---

## Project Structure

```
packages/
  core/                    # Shared types, Zod schemas, logger, crypto utils
  slskd-client/            # Typed HTTP client for slskd REST API
  lidarr-client/           # Typed HTTP client for Lidarr REST API
  service-manager/         # Sub-service lifecycle management (strategy pattern)
  api/                     # Hono API server, routes, JWT auth, native library scanner + streaming, SQLite DB, WebSocket
  web/                     # Angular v22 web UI (standalone components, signals, Tailwind)
  cli/                     # Commander.js CLI
  mobile/                  # Capacitor Android + iOS shell
  capacitor-now-playing/   # Swift plugin: iOS MPNowPlayingInfoCenter + AVAudioSession
  e2e/                     # Playwright end-to-end suite
src/
  main.ts                  # Entry point — loads config, starts services, serves API
config/
  default.yml              # Default configuration
docs/                      # Per-feature design + docs (see CLAUDE.md index)
```

---

## End-to-end tests

`packages/e2e` is a Playwright suite that boots the real server against a throwaway DB + silent-FLAC fixtures and drives the SPA in Chromium. Acquisition is default-off so no slskd/Lidarr is needed. Selectors are `data-testid` attributes — adding a `data-testid` is the standard for new e2e-targeted elements. See [docs/e2e.md](docs/e2e.md).

---

## License

MIT
