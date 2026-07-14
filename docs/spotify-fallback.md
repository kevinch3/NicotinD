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
- **Playlist title + current/next track display.** A spotdl job's card shows the playlist name as its label (parsed from spotdl's own `Found N songs in playlist: <name>` log line) and, while downloading, a "Now: / Next:" line for the track currently being matched/downloaded — no spotdl-specific code was needed for either; both ride the generic mechanism in `docs/download-pipeline.md` → "Now: / Next: track display" that also covers yt-dlp and archive.org jobs.
