# Cache invalidation — the catalogue (issue #237)

Every cache, memo and derived store in the project, with the writers that must invalidate it. This
is the deliverable of the #237 survey, filed after #210 ("artist genre override doesn't invalidate
the cached artists/genres lists") showed the class was recurring rather than a one-off.

Read this before adding a cache **or** a mutation: a new cache owes this table a row, and a new
write path owes every row it touches an invalidation.

## The one confirmed class: cached whole-library reads (web)

`LibraryApiService` caches exactly two reads — `getArtists()` and `getGenres()`, via
`createCachedObservable` (shared + replayed, 30 s TTL). **Everything else hits the network.** So the
invalidation rule is narrow and checkable:

> A `LibraryApiService` write whose server handler mutates `library_artists` or `library_genres`
> must `tap(() => this.invalidateLibraryReads())` on success.

| Mutation                                      | Invalidates? | Why                                        |
| --------------------------------------------- | ------------ | ------------------------------------------ |
| `setArtistGenre` / `clearArtistGenre`          | ✅           | writes `library_genres` (the #210 original) |
| `fixArtistIdentity`                            | ✅           | splits/merges/renames `library_artists`     |
| `applyGenre`                                   | ✅           | added in `7e7e549`                          |
| `applyMetadata`                                | ✅           | can re-point an album's artist              |
| `deleteSongs` / `deleteAlbum`                  | ✅           | `pruneOrphanArtist` + orphan-genre prune    |
| `resyncLibrary`                                | ✅           | full rescan rebuilds both tables            |
| `hideAlbum` / `unhideAlbum`                    | ❌ correct   | `/artists` filters `library_artists.hidden`, not album hidden; the albums list is uncached |
| `reclassifyAlbum` / `clearAlbumOverride`       | ❌ correct   | moves an album between tabs; the albums list is uncached |
| artist-image / album-cover / lyrics / licence  | ❌ correct   | `coverArt` is id-stable; no list membership change |
| `optimizeAlbumMetadata`, `analyze*`, reclassify-genres | ❌ correct | per-id writes, no list impact          |

## Structural findings — classes that cannot occur here

These were on the #237 suspect list and were checked off, not skipped. Each is load-bearing: change
the design and the class comes back.

- **The service worker never caches API responses.** `ngsw-config.json` declares `assetGroups`
  only — there is no `dataGroups` entry at all, so an `/api/*` response is never served from the SW.
  Cross-layer "server wrote, SW replayed the old body" staleness is structurally impossible.
  (Audio is separately protected: every stream URL carries `ngsw-bypass`.)
- **Per-song side tables deliberately have no FK to `library_songs`.** `library_embeddings`,
  `library_song_genres`, `library_song_artists`, `library_lyrics`,
  `library_song_analysis_failures`, `library_genre_overrides` — none cascade, because the scanner
  rebuilds `library_songs` wholesale on every rescan and a cascade would delete curator data each
  time. The delete paths therefore leave orphan rows on purpose; since song ids are deterministic,
  a delete + re-download **restores** the curator's lyrics/genres/overrides rather than losing them.
- **Dangling side rows are invisible, not broken.** Every playlist read `INNER JOIN`s
  `library_songs` (including the `song_count` subquery), so a deleted song vanishes from playlists
  and their counts without a prune step.
- **The cover negative-cache has a complete writer set.** `noArtCache` (10 min) short-circuits
  `extractCover()` disk IO for artless ids; every path that can give an id art calls
  `clearCoverNegativeCache(id)` — album cover set/upload, artist image upload/from-album/reset,
  `metadata-optimize`, `metadata-fix`, and the `artist-image` enrichment task. Adding a new
  art-writing path without that call is the one way to reintroduce this bug.

## Server-side memos — all TTL-bounded by design

None of these take an explicit invalidation; each trades a bounded staleness window for avoiding
invalidation wiring at every mutation site. That trade is deliberate and documented at each site.

| Cache                                    | Key / TTL                        | Staleness cost                                    |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------- |
| `albumIdsByGroupKey` (`routes/library.ts`) | `WeakMap<Database>`, 4 s        | a rename is a few seconds late; only consulted while a download is active, and downloading albums are excluded regardless |
| `transferKeysCache`                       | module-global, 4 s               | ditto; also caches the slskd-unreachable miss so a dead sidecar isn't retried per request |
| `quarantineCache`                         | `WeakMap<Database>`, 4 s         | a just-landed song appears ≤4 s late              |
| `noArtCache` (`routes/streaming.ts`)      | id → expiry, 10 min              | **explicitly evicted** — see above                |
| `scan-cache` (`scan_cache` table)         | path + size + mtime              | content-addressed: a retag changes mtime → miss. Override tables are applied by `buildLibrary` *after* the raw tags, so an override needs no cache bust |
| `library_song_analysis_failures`          | `file_size` at last failure      | content-addressed: a re-download changes the size → the skip resets |
| `library_embeddings`                      | `(song_id, model)`               | song ids are path-derived, so the lossless→Opus transcode (`.flac` → `.opus`) mints a new id and a new embedding |
| `musicbrainz-client` / `discography` (7 d), `audio-features` health (30 s), `system-metrics` GPU | external data | upstream freshness, not our consistency |
| `transcode-cache`                         | includes source size; ffprobe post-check | see [library-scanner.md](library-scanner.md) "Transcode cache integrity" |

## Adding a cache — the checklist

1. Prefer **content-addressing** (size/mtime in the key) over invalidation wiring. `scan_cache` and
   the failure ledger both do this and consequently have no writer list to keep in sync.
2. If content-addressing doesn't fit, prefer a **short TTL** with the staleness cost written down at
   the declaration, as the four `routes/library.ts` memos do.
3. Only reach for **explicit invalidation** when neither fits — and then add the row to this table
   and the regression test. `invalidateLibraryReads` and `clearCoverNegativeCache` are the two that
   earned it, and both are the shape where a *user action* must be visible *immediately*.
4. Key any `Database`-derived memo by the db instance (`WeakMap<Database>`), never module-global —
   a test suite spins up many throwaway databases and a global memo leaks across them.
