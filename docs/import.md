# Import music from folder

An admin points NicotinD at a server-side folder of music files and they are brought into the
library through **the same pipeline a download takes** — tag sanitize, canonical
`<Artist>/<Album>` organization, cross-edition consolidation, duplicate prevention, lossless→Opus
standardization, acquisition provenance, incremental scan, and the quarantine/enrichment gate.
Once landed, imported music is indistinguishable from acquired music.

Surface: Admin → **Import music** (`ImportCardComponent`). Server: `LibraryImportService`
(`packages/api/src/services/library-import.service.ts`) + `routes/import.ts`, mounted at
`/api/admin/import`.

## Why it is a dedicated flow, not a `file://` resolve plugin

A `file://` scheme would technically ride `POST /api/acquire` unchanged, but that lane inherits
the acquisition kill-switch (`NICOTIND_ACQUISITION=off` hard-404s it) and the `user` role gate —
and **streaming-only installs are the likeliest importers** (they have an existing library and no
acquisition stack). Import is therefore:

- **Admin-only** (`requireAdmin` on every handler): a server-side path walk plus a bulk write into
  the shared library is server-admin territory.
- **Independent of the acquisition kill-switch**: the route group is deliberately *not* behind
  `requireAcquisitionEnabledMiddleware`, and its UI lives on the Admin page (which exists on
  streaming-only installs) rather than the hidden `/get` workspace.

It still reuses the whole ingest machinery: the service is the **fourth caller** of the shared
`CompletedDownloadFile[]` → `sharedOrganizer.organizeBatch()` → `scanIncremental()` seam (after
`AcquireWatcher.ingest`, `AddonJobPoller.ingestReadyItems`, and the download-review retag).

## Why staging-copy is mandatory (even in move mode)

`LibraryOrganizer.organizeBatch` **consumes and mutates its inputs**: it moves staged files
(rename, or copy+unlink across devices), rewrites tags on the placed file, transcodes lossless in
place, and unlinks duplicate-skips. Handing it the user's originals directly would destroy them on
every path — so each chunk is first staged under
`<dataDir>/staging/import/<jobId>/<source-relative-path>` and the organizer only ever sees the
staged copies:

- **Copy mode (default)**: `copyFileSync(src, dst, COPYFILE_FICLONE)` — a reflink where the
  filesystem supports it, silently a full copy elsewhere. Originals are never touched.
- **Move mode** ("Remove originals after import", confirm-gated): same-device sources are
  `renameSync`ed into staging (no double disk); cross-device sources are copied.

## The disk-truth deletion rule (move mode)

An original is deleted **only after its chunk's scan succeeded**, and only when its staged copy
**no longer exists** — i.e. the organizer consumed it: placed it in the library, dup-skipped it
(the content already exists), or filed it to the `<dataDir>/unsorted` bucket (exactly where a
download with unusable metadata goes). A staged copy still present means the organizer failed on
that file: a renamed original is moved back home, a copied one was never touched. Emptied source
directories are pruned, stopping at the source root.

Failure/crash recovery follows the same mapping: staged files deterministically map back to
`<sourceRoot>/<rel>`, so a failed chunk (and the service constructor's boot pass, for jobs
orphaned by a dead process) renames survivors home before removing staging.

## Chunking, scale, progress

`scanImportSource` (pure, `import-scan.ts`) walks the validated source into per-directory audio
groups — symlinks are never followed (only counted), dot-entries skipped, capped at
`IMPORT_MAX_FILES` (100k) / `IMPORT_MAX_DEPTH` (16; past either the preview reports `truncated`
and submit refuses). `planImportChunks` packs whole directories into ~200-file chunks — a
directory is **never split** (the organizer's folder-tag derivation and compilation detection need
the full album group) — so staging disk usage stays bounded and `files_done` gives real progress.
One import runs at a time (409 otherwise); cancel takes effect between chunks (the in-flight chunk
finishes its scan — never a half-organized album); retry reuses the job id and **skips
directories already marked done** (`import_job_dirs`), so an interrupted bulk import resumes.

## Path safety

`validateImportSource` realpaths both sides and rejects, with typed codes: a missing path, a
file, a source **inside** the music dir or data dir, and a source that **contains** either
(importing `/` would re-ingest the library plus the data dir). Symlinked sources resolving into
the library are caught by the realpath; symlinks inside the walk are skipped entirely.

## Job model: `import_jobs` + an item-less mirror row

`import_jobs` (+ per-directory `import_job_dirs`) is authoritative — `acquire_jobs` was not reused
because it is URL-shaped (`url NOT NULL`, a state CHECK, and `AcquireWatcher`'s orphan sweep and
retry assume URL jobs). Each job also mirrors an **item-less** row into the unified
`acquisition_jobs` table (same id, `kind='import'`, `method='import'`), so the Downloads feed
renders it as a normal card when acquisition is on — with an "Imported" badge, and artist/album
stamped on the mirror after a single-album import so "Open in Library" lights up. No
`acquisition_job_items` rows are written (a 20k-file import would bloat every feed poll);
`listJobFeed` reads the mirror's progress from `import_jobs.files_total/files_done` instead, and
`recomputeStage` ignores zero-item jobs by construction. Boot hygiene mirrors `AcquireWatcher`:
orphaned queued/running jobs are failed with a Retry hint, finished jobs are pruned after 7 days.

Provenance: one `acquisitions` row per landed file — `method='import'`, `source_ref` = the file's
**original** absolute path (not the staging path).

## Review-hold bypass (quarantine kept)

Imports go through the quarantine/enrichment gate like every download — that is the point of the
feature. But a bulk import while `holdForReview` is armed would flood the review inbox with albums
the admin just chose to import. So after organize and **before** the scan, when
`reviewHoldActive(db, holdForReview && acquisitionEnabled())`, the service writes
`recordReviewDecision(albumId, 'approved', 'import:<adminId>')` for each destination album.
Pre-approving *before* the scan mints the song rows keeps the `reviewed_at >= created` predicate
true with zero changes to the landing gate; a later real download into the same album still pends
(its rows are created after this decision).

## API

| Route | Purpose |
| --- | --- |
| `POST /api/admin/import/preview` `{path}` | Read-only dry run: album folders / files / bytes / unsupported / symlinks / disk numbers. 400 + typed code on an invalid source. |
| `POST /api/admin/import` `{path, removeOriginals?}` | Start; 202 `{jobId}`. 409 while one runs, 507 (+`requiredBytes`/`freeBytes`) when the destination fs is too small. Audited (`library.import.start`, detail `copy`/`move`). |
| `GET /api/admin/import/jobs` · `GET /jobs/:id` | List / detail (detail includes per-directory states). |
| `POST /jobs/:id/cancel` · `POST /jobs/:id/retry` · `DELETE /jobs/:id` | Cancel (audited) / resume / remove a finished job. |

Disk preflight: copy mode (or a cross-device move) requires the source's total bytes + a 500 MiB
margin free on the music filesystem; a same-device move needs only the margin. The preview always
reports the numbers.

## Limits & non-goals (v1)

- No browser upload lane — the source must be a path the *server* can read (Docker: mount it).
- No per-file preview listing; the dry run reports counts.
- The organizer's semantics are surfaced, not changed: what a download would dup-skip or file to
  `unsorted`, an import does too (the summary reports `imported` / `skippedDuplicate` /
  `unsorted` / `failed` / `removedOriginals`).

## Future: generalizing the ingest core

`AcquireWatcher.ingest()` and the import chunk loop share the ingest *shape*, but the genuinely
common portion is ~30 lines and acquire's copy is entangled with acquire-jobs-only concerns
(bitrate chip, tracks_json, playlist materialization, partial warnings); the pure pieces
(`deriveAcquireAlbum`, `recordAcquisition`, `CompletedDownloadFile`) are already shared imports.
When a **third** consumer of the shape appears, extract a `services/ingest-core.ts`
`ingestStagedFiles({files, method, sourceRefFor, organizeBatch, scanIncremental, db})` with each
flow keeping its own job bookkeeping — not before.
