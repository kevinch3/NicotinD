# Import music from a folder or archive

An admin points NicotinD at a server-side **folder or `.zip` archive** of music files and they are
brought into the library through **the same pipeline a download takes** — tag sanitize, canonical
`<Artist>/<Album>` organization, cross-edition consolidation, duplicate prevention, lossless→Opus
standardization, acquisition provenance, incremental scan, and the quarantine/enrichment gate.
Once landed, imported music is indistinguishable from acquired music.

Surface: **internal / API-only**. `LibraryImportService`
(`packages/api/src/services/library-import.service.ts`) + `routes/import.ts`, mounted at
`/api/admin/import`. There is no web UI.

## Why there is no web UI

The Admin "Import music" card (`ImportCardComponent`) was **removed**: import is an operator
action — a one-off, server-side path walk over a directory the admin already had to arrange for the
server to read (a Docker mount, a staging disk) — not something a user does from a phone. Keeping a
whole card, a polling service, 13 test ids and 26 translated strings per language alive for it cost
more than it returned, and the flow is unchanged behind the HTTP surface, which was already
admin-gated and audit-logged.

What did **not** change: an import still mirrors a `kind='import'` row into `acquisition_jobs`, so
it still renders a Downloads card (with the 📁 **Imported** badge and an *Open in Library* link) and
still reports progress and per-directory failures. Only the trigger moved.

Starting one is a plain authenticated call — the JWT is the same one the web app uses:

```bash
# Dry run first: album folders / files / bytes / disk headroom.
curl -sS -X POST localhost:8484/api/admin/import/preview \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"path":"/mnt/imports/My Music"}'

# Then start it (202 + {jobId}); poll GET /api/admin/import/jobs/<id> for progress.
curl -sS -X POST localhost:8484/api/admin/import \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"path":"/mnt/imports/Album.zip"}'
```

An orphaned per-device `localStorage` key (`nicotind-group-music-import`) lingers on installs that
had expanded the old card. It is inert and needs no cleanup.

## Archives as import sources

The source may be a `.zip` file instead of a folder. Everything after staging is byte-identical to a
folder import, because `scanImportArchive` produces **the same `ImportScanResult` shape** the folder
walk does — same per-directory grouping, same audio-only rule, same file/depth caps, same tallies.
That equality is what lets `planImportChunks`, the resume-by-directory contract and the disk
preflight stay untouched.

**Extraction is the staging step, not a phase before it.** An extract-to-temp-then-import design
would double peak disk and re-walk a tree the archive's central directory already enumerated;
instead `ImportSource.stage()` decompresses each entry straight into
`<dataDir>/staging/import/<jobId>/<entry path>` — exactly where `stageFile` writes for a folder —
and the organizer consumes it from there as usual.

**ZIP only, and hand-rolled** (`packages/api/src/services/import-archive.ts`, ~300 lines over
`node:zlib`). The pure-JS libraries either need the whole archive resident in memory (fflate's sync
API — impossible for a 20 GB dump) or add a dependency for well-specified header parsing; the binary
extractors (`unzip`/`bsdtar`/`7z`) would grow every deploy's image and need registering in
`scripts/dockerfile-runtime-binaries.test.ts`. `.rar` and `.7z` are non-goals: both would require one
of those binaries.

**Everything is read from the central directory, never the per-entry local headers.** That is not a
style choice — an entry written by a *streaming* zipper (general-purpose bit 3, a "data descriptor")
carries zeroes for its sizes in the local header, and only the central copy is authoritative. It
also means the total uncompressed size is known **before a byte is inflated**, which is what keeps
the disk preflight honest and makes a decompression bomb detectable up front. Only one field pair
(the local header's own name/extra lengths, needed to find where the compressed bytes start) is read
locally.

Guards, each reusing an existing precedent rather than inventing one:

| Risk | Guard |
| --- | --- |
| Path traversal (`../../etc/x`, `/abs/x`, `Album\win.mp3`) — a central directory stores names verbatim | `safeArchivePath` validates every segment and asserts containment with `isUnderMusicDir` before any handle opens. Deliberately **not** `safeIncomingPath`: that one reduces a name to its basename, which would flatten `Album/CD1/01.flac` and destroy the album grouping the pipeline runs on. |
| Symlink entries (a `link → /etc/shadow` body) | Detected from the external attributes' Unix mode and skipped + tallied, exactly as the folder walk skips filesystem symlinks. |
| Encrypted entries | General-purpose bit 0, rejected as `ARCHIVE_ENCRYPTED` before any inflate. |
| Decompression bomb | The declared uncompressed total is checked against `IMPORT_MAX_ARCHIVE_BYTES` and a ratio ceiling, both from the central directory. The ratio is only consulted past a 64 MiB floor: real audio zips at ~1:1, a bomb is 10⁶:1, and a small archive of silence is harmless. |
| Runaway single entry | `MAX_ARCHIVE_ENTRY_BYTES`, checked against the declared size *and* enforced on the write stream, with the partial file removed — the same shape as the addon delivery cap. |
| ZIP64 | Refused (`ARCHIVE_UNSUPPORTED`). Reading its sentinel values as real offsets is a corrupt read; refusing is honest. |

Typed rejection codes (`ImportSourceErrorCode`, all 400s): `ARCHIVE_UNREADABLE` (not a zip /
truncated), `ARCHIVE_ENCRYPTED`, `ARCHIVE_UNSUPPORTED` (ZIP64 or an unusual method),
`ARCHIVE_TOO_LARGE`. Each asks for a different action from the operator, which is why they are
distinct codes rather than one "bad archive".

**Move mode is archive-level and all-or-nothing.** You cannot delete a track out of a zip, so the
unit of removal is the archive file, and it is removed only once every chunk succeeded *and* nothing
was left unconsumed — the disk-truth rule aggregated to the whole source. Two folder-mode routines
are consequently inert for an archive: `rollbackStaging` (its `sourceRoot` would be a *file*, so it
would rename staged files to paths derived from one — it self-guards on `isDirectory`, which also
covers the boot orphan sweep, whose only input is the stored `sourcePath`) and
`pruneEmptySourceDirs` (there is no source tree to tidy). The disk preflight also forces
`sameDevice = false`: extraction always materializes new bytes, so the full uncompressed size must
be free even in move mode on one device.

## Why it is a dedicated flow, not a `file://` resolve plugin

A `file://` scheme would technically ride `POST /api/acquire` unchanged, but that lane inherits
the acquisition kill-switch (`NICOTIND_ACQUISITION=off` hard-404s it) and the `user` role gate —
and **streaming-only installs are the likeliest importers** (they have an existing library and no
acquisition stack). Import is therefore:

- **Admin-only** (`requireAdmin` on every handler): a server-side path walk plus a bulk write into
  the shared library is server-admin territory.
- **Independent of the acquisition kill-switch**: the route group is deliberately *not* behind
  `requireAcquisitionEnabledMiddleware`, so a streaming-only install (which has no `/get` workspace
  at all) can still import.

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

Provenance: one `acquisitions` row per landed file — `method='import'`, `source_ref` = where the
file came from, never the staging path: the original absolute path for a folder import, and
`<archive>!<entry>` for an archive one (the entry has no independent existence on disk, and the
archive path alone would not say which track).

The feed card's title comes from `acquisition_jobs.display_title`, set at creation to the source
folder's name (or the archive's stem — "Bootleg Rips 2019", not `/mnt/in/Bootleg Rips 2019.zip`).
A single-album import clears it once the real album is known, so the card upgrades rather than
staying pinned to the folder name.

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
| `POST /api/admin/import/preview` `{path}` | Read-only dry run: source kind, album folders / files / bytes / unsupported / symlinks / disk numbers. 400 + typed code on an invalid source. |
| `POST /api/admin/import` `{path, removeOriginals?}` | Start; 202 `{jobId}`. 409 while one runs, 507 (+`requiredBytes`/`freeBytes`) when the destination fs is too small. Audited (`library.import.start`, detail `copy`/`move`). |
| `GET /api/admin/import/jobs` · `GET /jobs/:id` | List / detail (detail includes per-directory states). |
| `POST /jobs/:id/cancel` · `POST /jobs/:id/retry` · `DELETE /jobs/:id` | Cancel (audited) / resume / remove a finished job. |

Disk preflight: copy mode (or a cross-device move) requires the source's total bytes + a 500 MiB
margin free on the music filesystem; a same-device move needs only the margin. An **archive** always
counts as cross-device — extraction materializes new bytes regardless of where the file sits. The
preview always reports the numbers.

## Limits & non-goals (v1)

- No web UI and no browser upload lane — the source must be a path the *server* can read
  (Docker: mount it), driven through the admin API.
- `.zip` only. `.rar`/`.7z`/`.tar.gz` are non-goals: the first two need a non-free binary, and a tar
  stream has no central directory, so its uncompressed size — the number the disk preflight and the
  bomb guard both depend on — cannot be known without a full decompression pass.
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
