# Clean-cut download→library reconciliation (kill post-Hunt duplicates)

**Date:** 2026-07-02
**Status:** Approved (design) — pending spec review

## Problem

Albums that go through the Hunt flow can show **duplicate tracks** in the library
for a while, then "fix themselves" later with no user action. Example the user
hit: `/library/albums/ae9314b7632cd68efa27e4ce0585df3f9f6c9b2f`.

Root cause is a structural asymmetry between the two scan paths in
`packages/api/src/services/library-scanner.ts`:

| | Files it sees | Dedup scope | Prunes stale rows? |
|---|---|---|---|
| **Incremental** `scanPaths` (batch after each download wave) | only the just-completed batch | `selectAlbumTracks` runs on that batch alone | **No** (`persist(..., false)`) |
| **Full** `scanFull` (boot / scheduled) | every file on disk | `selectAlbumTracks` across the whole album | **Yes** (`persist(..., true)`) |

A Hunt lands files in **multiple waves** (primary folder, then
`AlbumFallbackService` recovery sweeps, re-hunts, watchlist). Each wave triggers
an incremental `scanPaths` over only its own files, so cross-wave duplicates of
the same track are never compared, and incremental scan never prunes. Two
concrete failure mechanisms:

1. **Weak disk dedupe.** `dedupeFolder` (`album-dedupe.ts`) *does* read the whole
   folder from disk, but it groups by `dupKey`, which is **filename-based**
   (strips leading track number, a trailing `(N)` collision suffix, extension,
   punctuation). Two rips of the same track with genuinely different filenames
   (`Circus.flac` vs `05_circus.flac`, or a `(Radio Edit)` variant) get different
   keys and both survive. The scanner's `selectAlbumTracks` (tag/title-based,
   canonical-aware) *would* collapse them — but it only runs in the scanner, not
   at organize time.
2. **Orphan DB rows.** When `dedupeFolder` deletes a file, the watcher drops its
   `completed_downloads` row (`download-watcher.ts:237`) but **not** its
   `library_songs` row. A cross-wave deletion therefore leaves a `library_songs`
   row pointing at a **deleted path** — a phantom duplicate track until the next
   full scan prunes it.

So the duplicate "self-heals" only because a later full scan (which reads all
files and prunes) reconciles it. That delay is the bug.

## Goal

Make the **download→library transition** the single, deterministic
reconciliation point, so the library only ever reflects a clean,
one-copy-per-track album. A later full scan should find nothing to fix.

Plus a UX ask: **download cards must show the destination album** (the wrapper
the songs land in), and once done, deep-link to that album's library page.

## Design — two-stage clean cut

Responsibility is split exactly along the seam:

### Stage 1 — Download stage owns a clean disk (`LibraryOrganizer`)

Today `organizeBatch` runs `dedupeFolder(dir, { apply: true })` over each
`touchedAlbumDirs` entry and returns `dedupedBasenames`. We **upgrade the
per-folder dedupe from filename-based to tag/title-based**:

- New pure helper `reconcileAlbumFolder(dir, canonicalTitles?)` in a new module
  `services/album-reconcile.ts` (keeps the filename-only `album-dedupe.ts`
  intact for the manual repair script; the reconciler is the stronger,
  tag-aware path). It:
  1. reads every audio file currently in `dir` (whole folder — sees all prior
     waves already on disk);
  2. reads each file's resolved **title** (via `music-metadata`, falling back to
     path inference — reuse the scanner's title resolution so identity matches
     the library's) and **format/bitrate**;
  3. groups by the **same identity `selectAlbumTracks` uses** — canonical Lidarr
     title match when `canonicalTitles` is provided (from
     `album_jobs.canonical_tracks_json` via the existing `jobLookup`), else
     normalized title;
  4. keeps one best copy per track (existing FLAC > lossy > bitrate rule, i.e.
     `formatQuality` / `pickKeeper` semantics), **deletes the losers** on disk;
  5. returns the **deleted relative paths** (not just basenames) and the folder's
     surviving files.
- **Guards preserved:** never run on `Singles`/unsorted buckets; never delete the
  last surviving copy of a track (guaranteed because grouping keeps exactly one
  keeper per key).
- **Foreign-drop only with canonical titles.** Without a canonical tracklist
  (direct/non-hunt downloads) we only collapse format/title duplicates; we never
  drop a file as "foreign" (no authority on what belongs) — mirrors
  `selectAlbumTracks`.

`OrganizeResult` gains:
- `deletedRelPaths: string[]` — every file removed (relative to music dir), for
  DB cleanup.
- `affectedAlbumDirs: string[]` — the canonical album folders touched, for
  album-scoped rescan.

(`dedupedBasenames` can be derived from `deletedRelPaths` for back-compat, or the
callers switch to the new fields.)

### Stage 2 — Library stage owns a faithful DB (`LibraryScanner`)

`scanPaths` becomes **album-scoped instead of batch-scoped**: it internally
expands the incoming paths to their album folders, rescans each whole folder,
and prunes album-scoped. (No new public method — the two watcher callers keep
calling `scan(...)`; only the internal behavior changes.) Concretely:

1. Expand incoming paths/dirs to their affected **album folders**.
2. Read **all** current files in those folders (not just the batch).
3. `buildLibrary` over that union (already runs `selectLibraryTracks` →
   `selectAlbumTracks`).
4. **Album-scoped prune:** for each affected `albumId`, delete any `library_songs`
   row whose `path` is not among the just-scanned surviving files (and correct
   the album aggregate / prune orphan artist via the existing
   `pruneOrphanArtist` / `library-aggregates.ts`). This is the targeted analogue
   of `scanFull`'s global prune — it removes the orphan rows from Stage 1's
   deletions and any stale cross-wave rows, without a full-disk walk.

The watcher wiring (`download-watcher.ts` `runScan`, `acquire-watcher.ts`
`ingest`) both already call `scan(relPaths)` — they switch to feeding the
affected album dirs, so **both ingest paths get the fix from one change**.
Watcher also deletes `completed_downloads` rows for `deletedRelPaths` (superset
of today's `dedupedBasenames` behavior).

### Why not put disk-deletion in the scanner?

Rejected: it muddies the seam. Disk mutation belongs to the Download stage
(produce a clean folder); DB reflection + prune belongs to the Library stage.
This split is the "clean cut" the user asked for and keeps each unit
independently testable.

### Out of scope (documented, not silently dropped)

Cross-**folder** divergent-`albumId` duplicates (two editions that never got
consolidated into one physical folder, each keeping its own album-tag) are the
existing "Deferred: unify the hunt engines" item in `docs/album-hunt.md`. Folder
consolidation (`findCanonicalAlbumFolder`) already funnels hunted files into one
folder, so this reconciler covers the dominant case. We will not force-rewrite
album tags here.

## Design — download-card album wrapper

### Server

Attach a resolved destination to each enriched download in
`routes/downloads.ts` and the acquire-job read model:
- slskd group with an `album_jobs` match → `albumId = albumIdFor(artist_name,
  album_title)`, plus existing `artistName`/`albumTitle`.
- acquire job → derive artist/album from `storage_path` (leaf = album, parent =
  artist) → `albumIdFor`.

Computed **server-side** so the web bundle doesn't reimplement the SHA1 id
minting. Exposed as `albumId?` (and the already-present title/artist) on the
payloads the unified feed reads.

### Web

- `DownloadItem` (`lib/download-groups.ts`) gains `albumId?: string`.
  `groupToDownloadItem` / `acquireJobToDownloadItem` populate it.
- The card (`components/download-item/`) shows **"Artist — Album"** as the
  destination wrapper (in-flight and done — falls back to today's label when
  album is unknown).
- When `stage === 'done'` && `albumId` present, the primary action becomes
  **"Open in Library"** routing to `/library/albums/:albumId` (route exists at
  `app.routes.ts:46`). Unknown album → current generic behavior.
- New `data-testid`s: `download-item-destination`, `download-item-open-album`.

Deep-link derivation lives in a **DI-free pure helper**
(`lib/download-destination.ts` — `albumLinkFor(item)`), unit-testable without the
Angular `input()`-signal limitation (see `[[project_web_jit_input_test_limitation]]`).

## Testing plan (Quality Gate 1 + 2)

- **Unit — `album-reconcile.ts` (pure):** cross-wave dup with different filenames
  collapses; canonical-title foreign-drop; keeper = FLAC/higher bitrate; Singles
  bucket skipped; never deletes last copy; returns correct `deletedRelPaths`.
- **Unit — scanner album-scoped prune:** orphan row for a deleted path is removed;
  rows for other albums untouched; album aggregate/artist corrected.
- **Integration (API, temp dir + temp DB):** simulate **two organize+scan waves**
  into the same album → assert exactly one row per track, no phantom (deleted-
  path) rows, storage folder holds one file per track. This is the regression
  test for the reported bug and does **not** need slskd/Lidarr.
- **Unit — web `download-destination.ts`:** `albumId` present → correct
  `/library/albums/:id`; absent → fallback. Card behavior via instance
  outputs / `triggerEventHandler` per the JIT limitation.
- **CI:** new API test files are picked up by the existing `packages/api` vitest
  glob in `ci.yml`; new web spec by `ng test`. Verify the workflow actually runs
  them (Quality Gate 2) before closing out.

## Docs to update in the same PR (Quality Gate 3)

- `docs/download-pipeline.md` — "Duplicate prevention" section: add the
  reconciliation-at-the-seam layer; correct the implication that duplicates only
  resolve on a full scan.
- `docs/album-hunt.md` — qualify the mechanism; note the remaining cross-folder
  divergent-id case still deferred.
- `CLAUDE.md` — update the "Duplicate prevention" and "Download list metadata"
  index lines; add the card-wrapper behavior where downloads UI is indexed.
- `docs/web-ui.md` — download card destination wrapper + deep link.

## Rollout / safety

- No schema migration required (reuses `album_jobs`, `library_songs`,
  `acquisitions`; adds only in-memory result fields + one web field).
- Disk deletion reuses the battle-tested `pickKeeper` ordering and the existing
  Singles/last-copy guards; behavior is a strict superset of today's
  `dedupeFolder` (catches more, deletes nothing today's rules wouldn't already
  allow, minus the last-copy protection).
- The periodic full scan remains as the ultimate safety net; this change just
  makes it a no-op for freshly hunted albums.
