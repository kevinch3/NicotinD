# Spotify metadata fallback (download via spotDL)

A fallback **metadata lane**: when Soulseek (a unified search or an album hunt)
comes up empty, search the Spotify catalog for the matching album and download it
with **spotDL**. Spotify exposes metadata only (no audio), and spotDL already
downloads from `spotify.com` URLs — so this lane finds the right Spotify URL and
hands it to the existing acquire → spotDL pipeline. It mirrors the
[archive.org lane](album-hunt.md) almost exactly.

## Pieces

| Concern | Where |
| --- | --- |
| Album candidate type | `packages/core/src/types/spotify.ts` (`SpotifyCandidate`) |
| Search service | `packages/api/src/services/spotify-search.service.ts` |
| Plugin (gate + creds) | `packages/api/src/services/plugins/spotify/index.ts` |
| Route | `packages/api/src/routes/spotify.ts` (`GET /api/spotify/search`) |
| Web lanes | search page + album-hunt modal "From Spotify" sections |
| Subtitle helper | `packages/web/src/app/lib/spotify-display.ts` |

## Flow

```
search / album-hunt comes up empty
        │
        ▼
GET /api/spotify/search?q=…            (or ?artist=&album=)   ── gated on plugins.isEnabled('spotify')
        │   SpotifySearchService: client-credentials token (cached) → /v1/search?type=album
        ▼
SpotifyCandidate[]  { url: open.spotify.com/album/<id>, title, artist, year, coverUrl, trackCount, kind }
        │   user taps "Get via spotDL"
        ▼
POST /api/acquire { url }              → registry.getEnabledForUrl(url) → spotdl plugin → ingest
```

The candidate's `url` is the archive lane's `detailsUrl` analogue — there is **no
new acquire-path code**; spotDL's `canHandle = url.includes('spotify.com')`
already routes it.

## Also: artist portraits

`SpotifySearchService.searchArtistImage(name)` (`/v1/search?type=artist&limit=1` →
`pickSpotifyArtistImage`, the widest image) supplies a **fallback artist portrait**
when Lidarr has no poster. It's wired into the `artist-image` enrichment task via
`resolveArtistImageUrl` (Lidarr first, Spotify second — see
[library-scanner.md](library-scanner.md) "Artist images" and
[library-processing.md](library-processing.md)). Unlike album `search`, it **never
throws**: missing creds or an upstream blip just yields `null` and the artist keeps
its neutral placeholder. It reuses the same client-credentials token + retry as the
album lane and reads the admin's live creds through the same `index.ts` accessor.

## Two plugins, two responsibilities

- **`spotify`** (metadata, capability `search`, pure JS, **default-off**) — finds the
  album + holds the Spotify app **client id/secret**. `isAvailable()` is true only
  when enabled **and** both credentials are set, so the admin card shows
  "Unavailable" until configured. It has **no `resolve`/`download`** and never
  competes in `getEnabledForUrl`.
- **`spotdl`** (resolve) — does the actual download. The web gates one-click
  download on `hasSpotdl()` (enabled **and** available/binary present); when spotDL
  isn't ready the lane shows a manual note ("enable the spotDL plugin") and an
  external "Open ↗" link instead of the Get button.

## Credentials

Entered in **Settings → Plugins** via the generic config-field form (see
[plugins.md](plugins.md) → "Generic config-field editor"). The secret is a
write-only `password` field — never returned by `GET /api/plugins`; leaving it
blank on save keeps the stored value (server-side merge in `registry.setConfig`).
For headless/Docker, `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` (or
`acquire.spotify.*` in `config/default.yml`) seed the config; the UI is primary.
The service reads the **current** stored creds live (accessor in `index.ts`), so
an edit takes effect without a restart.

## spotDL inherits these credentials at spawn time

spotDL itself reads its Spotify credentials from the `SPOTIPY_CLIENT_ID` /
`SPOTIPY_CLIENT_SECRET` env vars (the standard spotipy convention). Without
them, spotDL falls back to its built-in shared (rate-limited) client — every
NicotinD install used to land there, and the rate limit surfaces as lower-quality
YouTube matches because spotDL's metadata lookup times out and gives up on the
best audio candidate.

`SpotdlPlugin` (`packages/api/src/services/plugins/spotdl/index.ts`) reads the
spotify plugin's stored config live via `PluginRegistry.getConfig('spotify')`
and forwards the pair as `SPOTIPY_CLIENT_ID` / `SPOTIPY_CLIENT_SECRET` on the
spawn env. The forward is **opt-out by absence**: when the user hasn't filled in
the spotify card, the layer is omitted entirely and spotDL keeps the default
behavior. Reading live (no cache) means an admin editing the spotify card
takes effect on the next `run()` call — no re-init required.

**One source of truth.** The user enters their Client ID/Secret in the spotify
card once. That single input gates both lanes: the metadata search lane and the
spotDL download lane. The spotdl card itself stays minimal (binary path +
cookies file); a one-line hint under the spotdl card points at the spotify card
(`data-testid="spotdl-uses-spotify-credentials"`).

## Better audio quality: `--bitrate disable`

The Spotify credentials above improve the **metadata match** (which YouTube
candidate spotDL picks), not the bytes it writes. The audio-quality lever is the
encode step. With no `--bitrate` flag, spotDL re-encodes every track to
auto-bitrate MP3 — a second lossy pass over an already-lossy YouTube stream that
throws away audio for nothing. `SpotdlPlugin.run()` therefore always passes
**`--bitrate disable`**, which skips ffmpeg's bitrate conversion and copies the
source stream through untouched: YouTube Music matches keep their native ~256
kbps AAC, plain-YouTube matches keep their Opus. The download pipeline's own
lossless→Opus standardization (`docs/download-pipeline.md` → "Lossless → Opus
standardization") then re-encodes at one known, controlled bitrate when needed,
instead of stacking two uncontrolled lossy encodes.

Further quality levers, deliberately **not** wired yet (single-purpose PR):
`--format`/`--audio` provider ordering (e.g. prefer `youtube-music` for its
higher-bitrate AAC, then fall back), and surfacing `--bitrate` as an
admin-editable field on the spotdl card. These are additive and can follow.

## Notes / limits

- **Metadata only** — Spotify provides no audio; the lane is useless without
  spotDL enabled. Search + artist-albums are unaffected by Spotify's Nov-2024
  endpoint deprecations (related-artists / recommendations / audio-features are
  gone for new apps, but we don't use those).
- **Auth** is OAuth client-credentials (app token, no user context), cached in
  memory until expiry; a 401 drops the cached token so the next call re-auths.
- An unreachable/non-OK upstream or missing creds throws `ServiceUnavailableError`
  → the route returns **503** (so the UI shows "unavailable", not a misleading
  empty result). One retry covers a transient blip.
- Default-off for every install (not seeded by `seedLegacyAcquisitionPlugins`),
  matching the compliance posture.
- **Retry resumes truncated downloads.** A failed acquire job (server restart mid-download, network blip, etc.) keeps its staged files on disk instead of having them deleted; clicking **Retry** re-invokes spotdl against that same staging directory with `--overwrite skip`, so it skips tracks already downloaded and only fetches what's missing. See `docs/download-pipeline.md` → "Resume after truncation" for the full mechanism.
- **Playlist title display.** A spotdl job's card shows the playlist name as its label (parsed from spotdl's own `Found N songs in playlist: <name>` log line) — no spotdl-specific code was needed; it rides the generic mechanism in `docs/download-pipeline.md` → "Now: / Next: track display" that also covers yt-dlp and archive.org jobs.
- **Spotify playlist URLs auto-generate a native per-user playlist.** A `https://open.spotify.com/playlist/<id>` submission is classified as a playlist at submit time (`classifyAcquireUrl` → `kind: 'playlist'`); after the post-ingest pipeline, the host materializes a `kind='user'` playlist from the landed tracks in download order, scoped to the submitter. See `docs/playlist-from-acquisition.md` for the full flow + the route's `userId` / `as` contract.
- **No live "Now:" line for spotdl.** Unlike yt-dlp/archive.org, spotdl's plain-log output only reports a track as `Downloaded "Title"` or `Skipping "Title"` — there is no "track starting" line to parse. `parseSpotdlTrackEvent` therefore only ever produces `'done'`/`'skipped'` events, never `'downloading'`, so `currentAndNextTracks()` (which looks for the last `'downloading'` entry, deliberately with no fallback) never has anything to show for a spotdl job. This is a known, accepted limitation of this PR, not a bug — a code fix for spotdl track-start detection was considered and explicitly deferred.
