# Library UX restructure

## Context

NicotinD's library presentation is a thin mirror of what Navidrome scans off disk. That works only if the on-disk layout and tags are already clean — which, given slskd's output (phantom `<file>/<file>` dirs, single-file downloads with no album context, peer-side junk tags), they aren't. Iterations of in-place tag fixing and folder reorganization have hit diminishing returns: any normalization done at the file level still leaves the UI showing `[Unknown Album]` mega-buckets, single-track "albums" by the thousand, and filename-shaped album names.

The next step is not another pass of "fix the files harder." It's to **decouple storage from presentation**: NicotinD owns library *curation* (classification, hiding, virtual collections), Navidrome (or eventually a replacement) is reduced to a backend that scans bytes and serves streams. The UI reads from a NicotinD-owned canonical DB, never directly from Navidrome.

This also makes Navidrome swappable later — once the canonical DB is the source of truth for the UI, replacing Navidrome's scanner is a contained sub-project, not a rewrite of the whole app.

The user does not use the Subsonic mobile ecosystem (DSub, Symfonium, etc.), so the "must keep Navidrome for compatibility" constraint that normally pins this kind of system does not apply here. Navidrome stays for now because rewriting its scanner has a real bug-discovery tax, not because we need its Subsonic surface.

## Goals

1. UI shows a coherent, curated library — no `[Unknown Album]` buckets, no thousand-singletons grid, virtual groupings where natural.
2. New downloads land normalized; the staging→library boundary is real.
3. Files that can't be salvaged are hidden from the UI without being deleted from disk.
4. The architecture leaves Navidrome swappable behind a stable internal API.

## Non-goals

- Replacing Navidrome in this iteration. (Tracked as a follow-on; the design must not block it.)
- Subsonic API compatibility — confirmed not in use, deprioritized.
- Touching the player / playback / preserve (offline cache) layers.

## Architecture shift

```
                 ┌─────────────────────────────────────────────┐
                 │              NicotinD canonical DB           │   ← source of truth for UI
                 │   library_items, classifications, hides,     │
                 │   virtual_collections, acoustid_cache, …     │
                 └────────────▲────────────────▲────────────────┘
                              │ sync            │ writes
                ┌─────────────┴────────┐   ┌────┴─────────────────┐
                │  NavidromeSyncer     │   │  LibraryOrganizer +  │
                │  (post-scan pull)    │   │  ingest pipeline     │
                └─────────────▲────────┘   └────▲─────────────────┘
                              │                  │
                       Navidrome scan         slskd downloads
                              │                  │
                              └──── shared musicDir ─────────┘

API routes (`/api/library/*`) read **only** from the canonical DB.
The `/rest/*` Subsonic proxy is retired (or kept gated for emergency use).
```

Key inversion: today `api/routes/library.ts` proxies Navidrome live; after this change it queries NicotinD sqlite. Navidrome's scan triggers a sync into NicotinD's tables, not a direct UI refresh.

## Phases

### Phase 1 — Canonical library DB + sync (foundation)

Goal: make NicotinD's sqlite the source of truth for what the UI sees. No behavioral change yet.

Tables to add (`packages/api/src/db.ts`):

- `library_albums` — `id` (Navidrome album id, kept for now), `name`, `album_artist`, `artist`, `year`, `genre`, `song_count`, `duration`, `created_at`, `path_hint`, `cover_art_id`, plus curation columns: `classification` (`album|single|compilation|unknown`), `hidden` (bool), `virtual_collection_id` (FK, nullable).
- `library_songs` — `id`, `album_id` (FK), `title`, `artist`, `track_number`, `disc_number`, `duration`, `path`, `acoustid_id` (nullable), `mb_recording_id` (nullable), `bitrate`, `hidden` (bool).
- `library_artists` — `id`, `name`, `album_count`, `song_count`, `hidden`.
- `virtual_collections` — `id`, `kind` (`singles_by_artist|recent_downloads|from_peer|…`), `name`, `key` (e.g. artist id for singles), `cover_strategy`.
- `acoustid_cache` — `fingerprint_sha`, `acoustid_id`, `mb_recording_id`, `mb_release_id`, `looked_up_at`. (Replaces in-tag negative-caching as the source of truth.)
- `sync_state` — last full sync timestamp, last incremental sync cursor.

New service: `packages/api/src/services/navidrome-syncer.ts`

- `syncFull()` — paginates `getAlbumList2` + `getArtists` + per-album `getAlbum` (for songs), upserts into the canonical tables. Idempotent.
- `syncIncremental(sinceMs)` — same shape, scoped by Navidrome's `lastScan` timestamp where available; falls back to a recently-modified slice.
- Called by `DownloadWatcher` after scan completes (replaces the auto-playlist call site; auto-playlist moves to consume canonical DB later).

Rewrite `packages/api/src/routes/library.ts`:

- All endpoints (`/albums`, `/artists`, `/genres`, `/albums/:id`, `/recent-songs`, etc.) read from the canonical tables.
- Cover art proxy: `GET /api/library/cover/:id` continues to forward to Navidrome's `getCoverArt` (no caching change in this phase).
- Streaming: `GET /api/library/stream/:id` continues to proxy Navidrome's `stream`. Keep this as the single integration point to swap later.

Verification:

- Cold start → first sync populates canonical DB. Confirm row counts match Navidrome's getAlbumList counts.
- UI looks identical to today (proves the sync is faithful).
- New download → debounce + scan + sync → album appears in `/api/library/albums?type=newest` without restart.
- Drop the `/rest/*` Subsonic proxy route from `api/src/index.ts` and verify nothing else in the app uses it.

### Phase 2 — Curation layer (hide + classify)

Goal: hide the junk, classify what's left.

Classification job (`packages/api/src/services/library-curator.ts`), runs after every sync:

- `unknown` → `hidden = true` automatically when `(album, album_artist, artist)` are all `isUnknownLike()` AND song_count ≤ 1. These are the `[Unknown Album]` mega-bucket entries.
- `single` → song_count == 1 AND folder contains exactly that one audio file (use `library_organizer`'s metadata where available).
- `compilation` → existing `compilation-tagger` signals (TCMP, various-artists folder name regex) — promoted out of the tagger into the curator.
- `album` → everything else.

API surface:

- `/api/library/albums` accepts `?includeHidden=false` (default), filters `hidden = true` and `classification = 'unknown'` server-side.
- Admin endpoint `POST /api/library/albums/:id/hide` / `unhide` for manual overrides.
- Admin endpoint `POST /api/library/albums/:id/reclassify` with body `{classification}`.

UI:

- `library.component.ts` gets a "Show hidden" toggle in `ListControlsService` (admin only). Off by default.
- Long-press / right-click on an album card → "Hide" / "Reclassify as Single|Compilation|Album".

Verification:

- The `[Unknown Album]` 18 818-track bucket disappears from the default view.
- Toggle "Show hidden" → bucket reappears, marked with a muted style.
- Manual reclassify persists across rescans (curator respects manual overrides via a `manual_override` column).

### Phase 3 — Virtual collections (the "albumize" goal)

Goal: turn the orphan-singles wasteland into navigable surfaces.

Built-in virtual collections, computed in `library-curator`:

- **Singles by `<Artist>`** — one collection per artist that has ≥ 2 singles. Cover art = composite of contained singles' covers, or first song's cover.
- **Recently Completed** — last 30 days of `completed_downloads`, joined to `library_songs.id`. Already half-built in `routes/library.ts:197-214`; promote to a first-class virtual collection.
- **From `<peer-folder>`** — when a multi-file slskd download landed but the tag-derived album is unknown, expose the source folder as a virtual album. Uses `completed_downloads.directory`.

Tables: `virtual_collections` + `virtual_collection_songs` (song_id, position).

API:

- `/api/library/collections` — list virtual collections.
- `/api/library/collections/:id` — collection + songs.
- Collections surface inside the existing Albums grid (one card per collection) with a small badge ("Singles", "Recent", "Folder") to distinguish them from real albums.

UI:

- New library tab "Collections" alongside Albums / Artists / Genres, OR mix them into the Albums grid (decide during implementation).
- Reuse `cover-art.component.ts` gradient fallback.

Verification:

- Pick an artist with many singletons in the current library — confirm they collapse into one "Singles by X" card.
- A multi-file download with junk tags shows up as a "From <folder>" collection rather than as a `[Unknown Album]`.
- Toggling a song's `hidden = true` removes it from any collection it was part of.

### Phase 4 — Real staging → library boundary (stop new bleeding)

Goal: new downloads only enter the library after normalization.

- Move slskd's `directories.downloads` from `<musicDir>` to `<dataDir>/slskd/downloads` (config templating in `packages/service-manager/src/services/slskd.ts`).
- `LibraryOrganizer` (existing) becomes the gatekeeper: invoked by `DownloadWatcher` on completion, it normalizes (phantom flatten + tag sanitize + AcoustID enrich) and **then** moves into `<musicDir>`. Failures route to `<dataDir>/unsorted/` (already supported).
- Navidrome only scans `<musicDir>`; staging is invisible to it.
- Optional: a `/api/staging` admin endpoint that lists files currently sitting in staging/unsorted with their detected problems, for hand-resolution.

Verification:

- A single-track Soulseek download lands in `<dataDir>/slskd/downloads/<filename>/<filename>.mp3`, gets flattened, tagged via AcoustID, moved to `<musicDir>/<Artist>/Singles/<NN - Title>.mp3` — never sits in `<musicDir>` in its raw form.
- Stop NicotinD mid-download → no half-files leak into `<musicDir>`.

### Phase 5 — Optional: replace Navidrome's scanner

Out of scope for now, but the architecture from Phase 1 makes this a contained project:

- Replace `NavidromeSyncer` with `LocalScanner` writing to the same canonical tables.
- Replace `/api/library/stream/:id` proxy with a Hono handler that opens the file and streams with range support; spawn ffmpeg for transcoding when needed.
- Replace `/api/library/cover/:id` proxy with embedded-art extraction (music-metadata supports this) + folder-art fallback + a small on-disk cache.
- Decommission Navidrome from `service-manager`.

Everything in Phases 1–4 keeps working unchanged when this lands.

## Critical files

| File | Role in this plan |
|---|---|
| `packages/api/src/db.ts` | Add canonical library tables + curation columns |
| `packages/api/src/services/navidrome-syncer.ts` | NEW — populates canonical DB from Navidrome |
| `packages/api/src/services/library-curator.ts` | NEW — classification, hide, virtual collections |
| `packages/api/src/routes/library.ts` | Rewrite to read from canonical DB |
| `packages/api/src/services/download-watcher.ts` | Call syncer after each scan |
| `packages/api/src/services/auto-playlist.service.ts` | Migrate to consume canonical DB; eventually merge into curator |
| `packages/api/src/services/library-organizer.ts` | Stays as-is, becomes the Phase 4 gatekeeper |
| `packages/service-manager/src/services/slskd.ts` | Phase 4 — staging directory swap |
| `packages/web/src/app/pages/library/library.component.ts` | Hidden toggle, collections surfaces |
| `packages/web/src/app/services/list-controls.service.ts` | Hidden toggle plumbing |
| `packages/web/src/app/components/cover-art/cover-art.component.ts` | Reuse for collection covers |

## Verification (end-to-end, post-implementation)

1. Cold-start NicotinD → `library_albums` populated, row count matches `SELECT COUNT(*) FROM album` in `navidrome.db`.
2. Default `/library` view shows zero `[Unknown Album]` entries; song count visible in UI drops by the size of the mega-bucket.
3. An artist with N singleton tracks shows up with one "Singles by <Artist>" card; opening it lists all N.
4. Trigger a slskd single-track download → file never appears in `<musicDir>` in its phantom form; ends up in `<Artist>/Singles/` with album="Singles", AcoustID + MBID written.
5. Manually hide an album → disappears from default grid, reappears with "Show hidden" toggle, persists across scans.
6. `/rest/*` route returns 404 (or is gated behind a feature flag).
7. Phase 5 readiness: a one-paragraph audit confirms that `routes/library.ts` does not import the Navidrome client outside the streaming/cover endpoints.

## Sequencing notes

- Phases 1 and 2 unblock the biggest visible UX win and should land together if possible.
- Phase 3 is the "creative" payoff and depends on Phase 2's classifier output.
- Phase 4 is independent of 1–3 in principle but lower priority — the existing library is the larger pain than new downloads.
- Phase 5 is opportunistic; revisit once 1–4 have been running for a while.
