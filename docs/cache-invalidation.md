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
- **…but they accumulate, so the regenerable ones are pruned on a grace period** (issue #259,
  `services/orphan-prune.ts`). Prod measurement before building anything:

  | table                            |   rows | orphans |         |
  | -------------------------------- | -----: | ------: | ------- |
  | `library_embeddings`             | 15,456 |   1,057 | 5.16 MB |
  | `library_song_analysis_failures` | 19,399 |     233 |         |
  | `library_lyrics`                 |    839 |      35 |         |
  | `library_song_genres`            | 31,623 |   **0** |         |
  | `library_song_artists`           | 15,198 |   **0** |         |
  | `library_genre_overrides` (song) |    311 |   **0** |         |

  **The numbers dissolve the apparent retention tension.** The tables the no-cascade design exists
  to protect — genres, artists, overrides — carry *zero* orphans, because the scanner rebuilds them
  rather than accumulating. The tables that actually grow are the regenerable ones. So `ORPHAN_TABLES`
  covers exactly `library_embeddings` (46% of the whole prod DB is embedding blobs; the sidecar can
  recompute them) and `library_song_analysis_failures` (a ledger, meaningless without its song).
  `library_lyrics` is **deliberately excluded** despite having orphans: a lyrics document is
  network-sourced and user-editable — precisely the curator data the design protects — and 35 rows
  don't justify trading that away.

  The pass is **mark → unmark → sweep**, guarded to one run per calendar day off the same
  processor-tick hook as the daily backup. `orphaned_at` (additive column) is stamped when a row is
  first seen with no owner, **cleared when its song comes back** — that unmark is what preserves the
  delete-then-re-download restore — and the row is deleted only once it has been orphaned longer
  than `DEFAULT_ORPHAN_GRACE_MS` (30 days). `updated_at` cannot stand in for `orphaned_at`: an
  embedding computed 60 days ago and orphaned today would be swept immediately, destroying exactly
  the property the grace period exists to keep.

  Two safety valves, because the cost of being wrong is deleting the whole embedding cache: an
  **empty `library_songs` aborts the pass** (a truncated or mid-rebuild library is not a reason to
  drop everything), and a table whose orphan ratio exceeds 50% is skipped with a warning. Neither
  can fire today — the scanner upserts inside a transaction and prunes by stale `synced_at`, so it
  never transiently empties `library_songs` — they're insurance against that ever changing.
  `countOrphanRows` feeds a `orphanRows` slice on `GET /api/admin/review`, rendered in the Admin
  panel (hidden at zero) so the prune is observable rather than silent.
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
| `library_embeddings`                      | `(song_id, model)` + `file_size` | content-addressed since issue #258: song ids are path-derived, so a file replaced **in place** kept its id and the Radio scorer went on matching against a vector describing audio that was no longer there — silently, indefinitely. `loadEmbeddings` joins `library_songs` and treats a size mismatch as a miss. A NULL `file_size` (written before the column) still matches, so an upgrade doesn't discard every embedding at once. The common lossless→Opus rewrite changes the *extension*, hence the path, hence the id, so it was never the exposed case |
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

## Playlist membership survives a song-id change (scanner prune)

Song ids are `sha1(path)`, so **any** move re-mints the id — a folder rename from
an artist-alias fix, an organizer consolidation, a repair script. The scanner then
prunes the old row (`DELETE FROM library_songs WHERE synced_at < …`) and inserts a
new one. Every `playlist_songs` row pointing at the old id is instantly dead, and
because there is no FK and playlist reads `INNER JOIN library_songs`, **nothing
errors — the playlist just silently renders one song shorter.**

Measured on prod: **17 dangling rows across 11 user playlists** (1-3 each), plus 62
in curated shelves. The curated ones self-heal on the weekly refresh; the user ones
never do.

The transcode path already solved this for its own id change (`library-transcode.ts`
re-points `playlist_songs` when lossless→opus re-mints the id). The scanner prune was
the one id-changing path that didn't.

`repointPlaylistsBeforePrune` (`services/playlist-repoint.ts`) runs **inside the prune,
before the delete**. That ordering is not incidental: `playlist_songs` stores only
`song_id`, so once the row is gone there is nothing left to identify what the entry
was — no title, no path. **Recovery after the fact is impossible, which is why this
cannot be a repair script.**

**Identity is `(title, artist, duration)`, and the match must be unique.** A wrong
re-point silently puts a *different* song in someone's playlist, which is worse than
the dangling entry it replaces — so ambiguity is left to dangle exactly as before.
Measured against the real library (14,580 songs):

| | count | |
| --- | --- | --- |
| unique triples | ~96.4 % | re-pointable |
| rows in ambiguous groups | 528 (3.6 %) | left alone, by design |
| title+artist pairs with differing durations | 248 | what duration saves us from (live cuts, remixes) |

Only songs a playlist actually references are considered, so a normal prune does no
extra work. `UPDATE OR IGNORE` handles the case where the playlist already contains
the survivor — `(playlist_id, song_id)` is unique, and a plain `UPDATE` would abort
the entire scan.

## Cover cache eviction (issue #311)

`<dataDir>/cover-cache` had **no eviction at all**. The only removal was
`artwork-store.ts`'s targeted purge when one album's canonical URL changes — no size or age policy,
unlike the transcode cache which does prune. Measured on prod: **3.6 GB**, the largest consumer in
the data dir.

`pruneCoverCache` sweeps entity-keyed files whose owning album/artist/song is gone, from the daily
processor-tick hook alongside the backup and the #259 row prune (`NICOTIND_COVER_CACHE_PRUNE=off`
disables it).

**Only entity-keyed files are touched, and that distinction is the whole trap.** Keys come in two
shapes: `<sha1>`/`<sha1>@<size>` keyed on a row id, and `c_<hash>`/`r_<hash>` which are
**content-addressed** (the source image or remote URL, the latter from issue #263). The second kind
has no owning row, so it can never be judged orphaned by an id lookup. A first measurement that
missed this reported **51 % / 2.3 GB** orphaned by counting all 9,455 content-addressed files as
orphans; deleting on that basis would have thrown away live entries. The corrected entity-keyed
figure is **28 % / 1.6 GB**.

**Grace period, for the same reason as #259**: ids are deterministic, so deleting a song and
re-downloading the same file reuses its id — and should reuse its cached cover rather than
re-fetching and re-encoding. The orphan clock is the file's **mtime**, which the cache already
maintains.

**Two sanity valves.** An empty library refuses the sweep outright. Above a minimum sample the
sweep also refuses when >90 % of entity-keyed files look orphaned (a mid-rebuild library). The
minimum sample matters: over a handful of files the ratio is noise, and a cache holding one orphan
is 100 % orphaned — without it a small cache would trip the valve forever and never reclaim
anything. That was found by a test, not by review.

Dry-run against the live prod cache: 19,733 entity-keyed + 9,455 content-addressed, 5,530 orphaned,
**4,803 past grace → 1,566 MB reclaimed**, 727 recent orphans spared, valve correctly silent at a
0.28 ratio.
