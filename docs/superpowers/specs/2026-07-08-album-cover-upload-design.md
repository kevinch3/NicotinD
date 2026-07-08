# Album cover upload — Design

**Date:** 2026-07-08
**Branch:** `fix/track-number-artist-leak` (or a new branch off it)
**Status:** Approved (design)

## Problem

The Fix-metadata modal's cover picker (`docs/metadata-optimize.md` "Cover picker") lets
an admin apply a cover from a Lidarr alternative, a pasted URL, or one of the album's
own track's embedded images — but there is no way to upload an arbitrary local image
file as the album cover. Users who have a cover image on hand (e.g. scanned artwork, a
higher-res version) currently have to host it somewhere and paste a URL.

## Goals

- Let an admin upload an image file directly as an album's cover from the Fix-metadata
  modal.
- Normalize whatever is uploaded (format, size, aspect ratio) to match how the rest of
  the library's covers behave, rather than storing arbitrary source bytes.
- Ship with the same regression coverage this session added for the cover-apply
  negative-cache bug (`routes/library.cover.test.ts`) — the new write path must also
  clear `noArtCache` so the uploaded cover shows immediately.

## Design

### 1. Backend — `PUT /api/library/albums/:id/cover`

New route in `routes/library.ts`, sibling verb to the existing
`POST /albums/:id/cover` (which takes a JSON `{ coverUrl }` or `{ songId }`). `PUT`
takes multipart form-data with an `image` file field, mirroring the existing
`PUT /artists/:id/image` artist-portrait upload:

1. `requireAdmin`; 503 if `musicDir` isn't configured (needed to locate the album's
   folder, same precondition as the `songId` branch today).
2. 404 if the album doesn't exist.
3. Parse `formData()`; 400 if no `image` file part.
4. Validate `file.type` against the existing `ALLOWED_OVERRIDE_TYPES` (JPEG/PNG/WebP)
   → 415 otherwise. Validate `file.size` against a shared max-upload constant (the
   existing `MAX_ARTIST_IMAGE_BYTES` local const in `library.ts`, renamed to
   `MAX_IMAGE_UPLOAD_BYTES` and reused by both routes — same 8 MB cap, no behavior
   change for the artist route) → 413 otherwise. 400 if the decoded bytes are empty.
5. Resolve the album's representative track path (same
   `ORDER BY COALESCE(disc,1), COALESCE(track,999999), path LIMIT 1` query already
   used by `POST /artists/:id/image/from-album`) → 404 `"Album has no track files to
   store a cover next to"` if the album has no songs on disk.
6. Convert: `resizeCover(bytes, 1200)` (existing function in `cover-thumbnail.ts`,
   already used for thumbnails — `sharp(...).resize(1200, 1200, { fit: 'cover',
   position: 'centre' }).webp({ quality: 80 })`). No new image-processing code; this
   reuses the exact function, just requesting 1200px instead of a thumbnail bucket.
   1200px comfortably exceeds the largest existing thumbnail bucket (640px) so
   re-thumbnailing from it never upscales.
7. `writeFolderCover(dirname(abs), { data, contentType: 'image/webp' })` → writes
   `cover.webp` into the album's folder (same helper the `songId` branch uses).
8. `deleteArtwork(db, id, coverCacheDir)` (clears any canonical override so the new
   folder file wins) + `purgeDiskArtCache(coverCacheDir, id)` +
   `clearCoverNegativeCache(id)` — identical cleanup triptych to the `songId` branch,
   with the negative-cache clear this session's bug fix added.
9. `200 { ok: true }`.

No new service/module — everything reuses existing exports (`resizeCover`,
`writeFolderCover`, `deleteArtwork`, `purgeDiskArtCache`, `clearCoverNegativeCache`,
`ALLOWED_OVERRIDE_TYPES`).

### 2. Frontend

- `LibraryApiService.uploadAlbumCover(id, file)`: `PUT` + `FormData`, mirroring
  `uploadArtistImage` line-for-line.
- `MetadataFixModalComponent`: the private `applyCover(req: ApplyCoverRequest)` becomes
  a lower-level `runCoverApply(action: () => Observable<{ ok: boolean }>)` that owns
  the shared `coverApplying`/`msg`/`coverChanged`/`loadCovers()` scaffolding. The three
  public entry points become:
  - `selectCover(c)` → `runCoverApply(() => this.api.applyCover(this.albumId(), req))`
  - `applyCustomCover()` → same, with the URL-derived request
  - `applyCoverFile(file: File)` (new) → `runCoverApply(() =>
    this.api.uploadAlbumCover(this.albumId(), file))`
- `triggerCoverUpload()` clicks a hidden `<input type=file>` (viewChild ref, same
  pattern as `artist-detail.component.ts`'s `triggerImageUpload`/`imageFileInput`);
  `onCoverFileSelected(event)` reads `input.files?.[0]`, resets `input.value`, calls
  `applyCoverFile`.
- Template: an "Upload image…" button + the hidden file input, placed next to the
  existing custom-URL input/Apply button in the cover section.
  `accept="image/jpeg,image/png,image/webp"`.
  `data-testid="cover-upload-button"` / `data-testid="cover-upload-file"` (per the
  e2e convention: new e2e-targeted elements get a `data-testid`).

### 3. Testing

- **Backend** (`routes/library.cover.test.ts`, extending the suite added by this
  session's negative-cache regression fix, which already mounts `libraryRoutes` +
  `streamingRoutes` with a real temp `dataDir`/music dir):
  - Happy path: upload a real non-square PNG fixture → 200; assert the written
    `cover.webp` is ≤1200×1200 and square (via `sharp(...).metadata()` on the written
    file); assert `GET /api/cover/:id` immediately returns the new image (same
    negative-cache-cleared assertion pattern as the bug-fix regression test) even when
    the album was 404-cached first.
  - 415 for a disallowed content type (e.g. `text/plain` posing as an image).
  - 413 for a file over the 8 MB cap.
  - 400 for a missing `image` part.
  - 404 for an unknown album id.
  - 404 for an album with no songs / no resolvable track file on disk.
  - 503 when no music dir is configured.
  - 403 for a non-admin.
- **Frontend**: a spec for `MetadataFixModalComponent` covering
  `triggerCoverUpload`/`onCoverFileSelected` → `uploadAlbumCover` call → `coverChanged`
  emit + `loadCovers()` refresh, following this repo's DI-free instance-method testing
  convention (`project_web_jit_input_test_limitation` memory).

### 4. Docs (same-commit, per Quality Gate 3)

- `docs/metadata-optimize.md` — Cover picker section: add the `PUT` endpoint next to
  the existing `POST` bullet, describing the resize/convert step and the shared
  `MAX_IMAGE_UPLOAD_BYTES` constant.
- `CLAUDE.md` — the existing "User-driven metadata fix" index line already says
  "multi-source cover picker"; extend it to mention upload, still pointing at
  `docs/metadata-optimize.md`.

## Out of scope

- HEIC/AVIF upload support (JPEG/PNG/WebP only, per the allow-list decision).
- A dedicated album-cover "override" storage layer distinct from the on-disk folder
  file (rejected in favor of reusing the existing folder-cover mechanism the `songId`
  branch already uses).
- Drag-and-drop dropzone UI (a single button + hidden file input is sufficient; no new
  layout region).
