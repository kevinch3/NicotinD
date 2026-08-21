# API routes

A quick orientation map of the HTTP surface (moved here from the README). The
machine-readable source of truth is the running server itself: `/openapi.json`
and the interactive `/doc` explorer.

Public routes (no JWT): `/api/setup/*` (locked after first user), `/api/auth/*`,
`/api/health`, `/api/ws/playback` (token in query), `/share/:token` (link
preview), `/api/radio-polls/public/*` (the poll token is the credential — see
[radio-eval-polls.md](radio-eval-polls.md)), `/openapi.json`, `/doc`.

All other `/api/*` routes require a `Bearer` JWT (30-day sliding session, silent
refresh on boot) or a read-only share token. The `check:route-auth` CI gate
fails when an `/api` route group is mounted with no auth decision — see
[roles.md](roles.md) for the role ladder each guard enforces.

### Why that gate parses instead of greps

The first version matched `app.route('(/api/...)'` with a regex, which requires
the path literal on the **same line** as the call. Prettier wraps long calls, so
**11 of 35 mounts were invisible** — `/api/auth`, `/api/setup`, `/api/admin`,
`/api/mcp`, `/api/library`, `/api/review`, `/api/system`, `/api/devices`,
`/api/admin/review`, `/api/discography` and the bare `/api` — and the gate
printed `Route auth: 24 /api groups` and exited 0. Whether a route was audited
depended on how long its arguments happened to be. The routes were in fact
protected, so nothing broke; the next wrapped mount would simply have gone
unchecked, silently.

That is the same failure shape as #457 (a `skipped` job read as tolerable),
#606 (a hardcoded image list) and #273/#376 (a CI-only typecheck surface): a
check that measures a convenient proxy instead of the invariant, and therefore
**fails green**. So the script now uses the TypeScript compiler's own parser
(`ts.createSourceFile` + `ts.forEachChild` over `CallExpression` nodes) and,
more importantly, **asserts its own denominator**. It fails — rather than
skipping — when:

- the `app.route(...)` calls it attributed do not add up to the `.route(`
  occurrences in the file (something is going unaudited);
- `.route()` is called on a receiver other than `app` (mounts on another router
  are invisible to the audit);
- a mount's path is not a plain string literal (a computed path cannot be
  checked against the auth list).

The rule generalises to every `check:*` script: **a gate must report how much it
examined, and that number must be independently derived.** A gate that can
quietly inspect a subset and still print a confident summary is worse than no
gate, because it is believed.

Four groups the regex had never seen carry `PUBLIC_ROUTES` entries as a result.
Each was checked against its route file rather than assumed safe: `/api/auth`
(pre-session), `/api/setup` (self-guards on `COUNT(*) FROM users > 0`),
`/api/devices` (applies `auth` per-route; the pairing endpoints are token-
authenticated by design) and the bare `/api` mount for `streamingRoutes`, whose
`/stream/*` and `/cover/*` paths are each covered by their own `app.use`.
**That last entry carries residual risk** and says so: a route added at the
mount root would land on `/api/<name>` and be public. Narrowing the mount is
follow-up work, not part of the gate fix.

| Method   | Path                                     | Description                                                 |
| -------- | ---------------------------------------- | ----------------------------------------------------------- |
| `GET`    | `/api/setup/status`                      | Check if initial setup is needed                            |
| `POST`   | `/api/setup/complete`                    | Complete initial setup (create admin, configure services)   |
| `POST`   | `/api/auth/register`                     | Register a new user                                         |
| `POST`   | `/api/auth/login`                        | Login, returns JWT                                          |
| `POST`   | `/api/auth/refresh`                      | Sliding-window refresh                                      |
| `GET`    | `/api/search?q=`                         | Unified search (local library + parallel network sources)   |
| `GET`    | `/api/search/:id/network`                | Poll for Soulseek results                                   |
| `POST`   | `/api/acquire`                           | Acquire from a URL (YouTube/Spotify/archive.org) via plugins |
| `GET`    | `/api/catalog/search`                    | Lidarr/MusicBrainz catalog search                           |
| `GET`    | `/api/album-hunt/:id`                    | Score + candidates for a catalog album                      |
| `POST`   | `/api/album-hunt/:id/hunt`               | Two-phase hunt (base + skew queries)                        |
| `POST`   | `/api/downloads`                         | Enqueue a download from Soulseek                            |
| `GET`    | `/api/downloads`                         | Active downloads feed (slskd groups + URL jobs, normalized) |
| `GET`    | `/api/acquire/jobs`                      | URL acquire jobs                                            |
| `GET`    | `/api/library/artists`                   | Browse artists                                              |
| `GET`    | `/api/library/albums`                    | Browse albums (excludes in-flight downloads)                |
| `GET`    | `/api/library/singles`                   | Browse singles & EPs                                        |
| `GET`    | `/api/library/songs`                     | Whole-library flat song listing (Library "Songs" tab)       |
| `GET`    | `/api/library/genres`                    | Browse by genre                                             |
| `GET`    | `/api/library/songs/:id/similar`         | Similar songs (BPM/key/genre scoring)                       |
| `GET`    | `/api/library/songs/:id/acquisition`     | Acquisition provenance (how/where/when)                     |
| `GET`    | `/api/library/identify/available`        | Whether an identify (AcoustID) source is configured         |
| `POST`   | `/api/library/songs/:id/identify`        | Fingerprint-identify a song via AcoustID (curator)          |
| `POST`   | `/api/library/songs/:id/identify/apply`  | Write the approved identify tags + rescan (curator)         |
| `GET`    | `/api/library/songs/:id/lyrics`          | Plain + synced lyrics                                       |
| `POST`   | `/api/library/songs/:id/lyrics/fetch`    | Fetch lyrics from enabled plugins                           |
| `PUT`    | `/api/library/songs/:id/lyrics`          | Save custom lyrics (admin)                                  |
| `DELETE` | `/api/library/albums/:id`                | Delete album (folder-first)                                 |
| `GET`    | `/api/library/untracked`                 | Downloads with `relative_path IS NULL` (admin)              |
| `GET`    | `/api/stream/:id`                        | Stream audio (Range/206 + seekable transcode cache)         |
| `GET`    | `/api/cover/:id`                         | Album/artist cover art (override → canonical → folder → embedded) |
| `GET`    | `/api/radio/next`                        | Smart radio — next track by metadata similarity             |
| `GET`    | `/api/history/stats`                     | Listening stats (top songs/artists/albums/genres)           |
| `POST`   | `/api/history/plays`                     | Idempotent batch play-event ingest                          |
| `GET`    | `/api/playlists`                         | List user's playlists (+ curated for all users)             |
| `POST`   | `/api/playlists`                         | Create playlist                                             |
| `GET`    | `/api/playlists/:id`                     | Get playlist (songs)                                        |
| `POST`   | `/api/playlists/:id/songs`               | Add songs (idempotent)                                      |
| `DELETE` | `/api/playlists/:id/songs/:songId`       | Remove a song                                               |
| `GET`    | `/api/share/:token`                      | Read-only share view (album/playlist/artist)                |
| `POST`   | `/api/share`                             | Mint a share token (short-lived, read-only)                 |
| `GET`    | `/api/radio-polls/public/:token`         | Public radio-eval poll view (+ short-lived media JWT)       |
| `POST`   | `/api/radio-polls/public/:token/votes`   | Anonymous poll votes (upsert per rater/candidate)           |
| `POST`   | `/api/admin/radio-polls`                 | Create a poll — freezes scenarios (admin)                   |
| `GET`    | `/api/watchlist`                         | Watchlist entries                                           |
| `POST`   | `/api/watchlist`                         | Toggle watch on a catalog album                             |
| `GET`    | `/api/plugins`                           | List plugins + capability status                            |
| `POST`   | `/api/plugins/:id/enable`                | Enable a plugin (admin)                                     |
| `POST`   | `/api/plugins/:id/disable`               | Disable a plugin (admin)                                    |
| `GET`    | `/api/system/status`                     | Service health status                                       |
| `POST`   | `/api/system/scan`                       | Trigger library rescan                                      |
| `GET`    | `/api/system/logs/stream`                | SSE stream of Docker logs (admin)                           |
| `GET`    | `/api/admin/review`                      | One-shot admin review snapshot (health, metrics, queues)    |
| `GET`    | `/api/admin/transcode-library`           | Lossless → Opus library migration (admin)                   |
| `GET`    | `/api/mcp`                               | MCP endpoint for external agents (agent-token auth)         |
| `GET`    | `/api/ws/playback`                       | Remote-playback WebSocket                                   |

This table is an orientation aid, not an exhaustive contract — new routes land
in `/openapi.json` automatically, and per-feature docs describe their routes in
context (e.g. [radio.md](radio.md), [mcp-agent.md](mcp-agent.md),
[device-pairing.md](device-pairing.md)).
