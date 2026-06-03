# Download Pipeline

## Singles vs album classification

`LibraryOrganizer` places tracks at `<Artist>/<Album>/<Track>` when an album is known, or `<Artist>/Singles/` as fallback.

- **Multi-file downloads**: `classifyFolder` in `compilation-tagger.ts` derives the album from the peer folder name (single-artist consolidation path).
- **Single-file downloads**: `deriveFolderTags` in `library-organizer.ts` calls `inferFolderAlbum` (`path-inference.ts`) to derive the album from the peer directory's leaf segment when the ID3 album tag is missing — a common situation with Soulseek peers. Generic folder names ("downloads", "src", "music", etc.) and folders that just echo the artist name are blocked by `looksLikeGenericFolder` so they don't become fake albums.

Files mislabeled as Singles before this fix can be repaired with `bun run packages/api/src/scripts/repair-singles.ts`.

---

## Duplicate prevention (two layers)

Shared logic lives in `packages/api/src/services/album-dedupe.ts` (`dupKey`/`pickKeeper`/`dedupeFolder`), reused by the manual `repair-album-dupes.ts` script.

1. **Format preference** — when config `downloads.preferFlacSkipMp3` is on, `LibraryOrganizer.placeFile` drops an incoming MP3 (and removes its source) if a same-title FLAC already sits in the destination album folder.
2. **Auto-dedupe** — after each batch, `organizeBatch` runs `dedupeFolder` on every real `<Artist>/<Album>` dir it touched (never `Singles`/unsorted), removing collision-suffix/mixed-format true copies and returning `dedupedBasenames` so `DownloadWatcher` prunes the matching `completed_downloads` rows. On by default (`autoDedupe`).

---

## Album deletion (reliability)

`DELETE /api/library/albums/:id` (`packages/api/src/routes/library.ts`) is **folder-first**: `tryDeleteAlbumFolder` recursively removes the album's `<Artist>/<Album>` directory in one `rmSync` (taking cover art + sidecars with it) when all tracks share one album-specific folder, guarded against the music root, bare `<Artist>` roots, shared `Singles` folders, and folders holding foreign audio. Otherwise it falls back to the per-file `deleteOne` chain (which sources the path from `library_songs`, with stale-path/renamed-folder fuzzy recovery).

It then **synchronously** deletes the canonical rows (`library_songs`, `library_albums`, `completed_downloads`) in one transaction. No tombstone/async-scan reconciliation needed: the native scanner reads disk directly and the files are gone, so a later rescan can't resurrect the album.

---

## Untracked downloads (legacy `relative_path`)

Rows predating the organizer have `relative_path IS NULL` and are invisible to deletion/tombstoning. `backfillRelativePaths` (`packages/api/src/services/untracked-backfill.ts`, CLI `scripts/backfill-untracked.ts`, dry-run unless `--apply`) indexes the music dir by basename and fills in unambiguous matches. `GET /api/library/untracked` (admin) lists rows still lacking a path.

---

## URL acquisition (yt-dlp / spotdl)

`AcquireWatcher` (`packages/api/src/services/acquire-watcher.ts`) + `YtdlpService` (`ytdlp.service.ts`) download audio from a pasted/shared URL (`POST /api/acquire`, backend auto-detected: `spotify.com` → spotdl, else yt-dlp), stage it, then run it through the **same shared `LibraryOrganizer` + incremental scan** as Soulseek downloads.

Availability is gated by **both** the `acquire.{ytdlp,spotdl}.enabled` config flag **and** the binary being present on PATH (`isBinaryAvailable`, cached) — the route returns 503 otherwise. Both default **on** (`config/default.yml`); the production **Dockerfile installs `yt-dlp` + `spotdl`** via pip.

Historical gotcha: the `enabled` flag used to be dead config — only binary presence was checked — and the image shipped neither binary, so acquisition always 503'd; both are fixed.

---

## Download list metadata (`AlbumJobMeta`)

`GET /api/downloads` annotates each in-flight folder whose `(username, peer directory)` matches an **active `album_jobs`** row with `albumJob: { artistName, albumTitle, canonicalTrackCount }` (`enrichWithAlbumJobs` in `routes/downloads.ts`; type in `@nicotind/core`). This lets the Downloads UI show "Artist — Album · N of M tracks" instead of the noisy peer folder name (e.g. "(1995) Toque").

The web groups transfers via the pure `lib/download-groups.ts` (`groupByAlbum`/`albumGroupTitle`/`albumGroupTotal`), which prefers the hunt metadata and falls back to the peer folder name + file count for **direct (non-hunt)** downloads that have no job.
