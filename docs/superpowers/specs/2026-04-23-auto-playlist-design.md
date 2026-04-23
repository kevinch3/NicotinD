# Auto-Playlist on Download Completion

**Date:** 2026-04-23
**Status:** Approved

## Problem

When users download music from Soulseek, completed files land in the shared library but aren't automatically organized into playlists. Users must manually find and playlist their downloads. Single tracks are especially easy to lose — they're not part of any album playlist and get buried in the library over time.

## Goal

Automatically place every completed download into a sensible playlist:
- **Single tracks** (one file from a remote directory) → appended to a global "All Singles" playlist
- **Folder downloads** (multiple files from the same remote directory) → appended to (or created as) a playlist named after the folder

Auto-playlists are owned by the admin user and visible to everyone. The Navidrome client instance is already initialized at startup with admin credentials (used by the Subsonic proxy), so `AutoPlaylistService` uses that same instance with no additional auth setup.

---

## Architecture

### New file: `AutoPlaylistService`

**Location:** `packages/api/src/services/auto-playlist.service.ts`

A stateless service. `DownloadWatcher` passes it a batch of `CompletedDownloadFile[]` after every Navidrome scan settles. It groups, resolves, and playlists — then returns. No new DB tables.

```
DownloadWatcher.check()
  → detects completions
  → records to completed_downloads DB
  → metadata fixer
  → debouncedScan()                    ← already exists (10s debounce)
      └─ after scan settles
          → AutoPlaylistService.processBatch(files, navidrome)
```

`DownloadWatcher` already holds the Navidrome client, so wiring is a one-liner.

---

## AutoPlaylistService Responsibilities

### 1. Name cleaning — `cleanFolderName(raw: string): string`

Takes the raw slskd `directory` value, extracts the leaf segment, and strips audio quality/format tags.

**Examples:**
| Input | Output |
|---|---|
| `Music\Dua Lipa - Future Nostalgia (2020) [FLAC 320kbps]` | `Dua Lipa - Future Nostalgia (2020)` |
| `Artist\EP Name [MP3 V0]` | `EP Name` |
| `Downloads\Some Album (FLAC)` | `Some Album` |
| `Clean Album Name` | `Clean Album Name` |

**Patterns stripped:** `[FLAC ...]`, `[MP3 ...]`, `[320kbps]`, `[V0]`, `(FLAC)`, `(MP3)`, trailing whitespace and empty parens.

### 2. Single vs folder detection

Group `CompletedDownloadFile[]` by `directory`. Groups with **1 file** → "All Singles". Groups with **≥2 files** → named playlist from cleaned folder name.

### 3. Song ID resolution

After scan, match each completed file to a Navidrome song ID:
1. Primary: compare `file.relativePath` against `Song.path` using `navidrome.search.search3()`
2. Fallback: `basename` match if path match fails

Files that cannot be resolved (unsupported format, corrupt, not yet indexed) are logged as warnings and skipped — the rest of the batch continues.

### 4. Playlist find-or-create + append

1. Call `navidrome.playlists.list()` — find by exact name match
2. If not found, call `navidrome.playlists.create(name)`
3. Fetch existing playlist tracks via `navidrome.playlists.get(id)` to get current song IDs
4. Diff: only add IDs not already in the playlist
5. Call `navidrome.playlists.update(id, { songIdsToAdd })` with the diff

---

## Data Flow (end-to-end)

```
Download completes in slskd
  → DownloadWatcher detects (5s poll)
  → file saved to completed_downloads DB
  → Navidrome scan triggered (10s debounce)
  → scan finishes (or 30s timeout)
  → AutoPlaylistService.processBatch([...files])
      → group files by directory
      → for each group:
          name = "All Singles" | cleanFolderName(directory)
          find playlist by name, or create it (admin creds)
          resolve Navidrome song IDs by path match
          fetch existing playlist tracks
          append new song IDs (skip duplicates)
```

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Song not found in Navidrome after scan | Log warning, skip track, continue batch |
| Navidrome playlist API error | Log error, skip that playlist operation |
| Scan exceeds 30s timeout | Proceed anyway — partial matches may succeed |
| Navidrome unavailable | Log error, skip entire batch |

Playlist auto-creation is **best-effort** — failures are non-fatal and never propagate to the download flow.

---

## Testing

**File:** `packages/api/src/services/auto-playlist.service.test.ts`

### Unit tests (no network)

- **`cleanFolderName()`** — table-driven:
  - Strips `[FLAC 320kbps]`, `[MP3 V0]`, `(FLAC)`, `(MP3)` suffixes
  - Preserves year in parens: `Album Name (2020)` stays intact
  - Handles nested paths: extracts leaf segment
  - Already-clean names pass through unchanged
  - Empty/edge-case inputs

- **`groupByDirectory()`** — batching logic:
  - Single file in a directory → tagged as "singles"
  - Multiple files in same directory → tagged as "folder"
  - Mixed batch → correctly split into both groups

- **`processBatch()`** with mocked Navidrome client:
  - Single file → "All Singles" created and track appended
  - Multi-file directory → playlist named after cleaned folder
  - Existing playlist → appended, not duplicated
  - Unresolvable song → skipped, rest of batch succeeds
  - Navidrome API error on one playlist → doesn't abort other playlists

---

## Documentation

- **JSDoc** on `AutoPlaylistService` class and `processBatch()`, `cleanFolderName()` public methods
- **`CLAUDE.md`** — add one line under *Key Design Patterns*:
  > *Auto-playlists: `AutoPlaylistService` runs after each Navidrome scan — singles → "All Singles", folder downloads → playlist named after cleaned folder.*

---

## Files Modified / Created

| File | Change |
|---|---|
| `packages/api/src/services/auto-playlist.service.ts` | **New** — `AutoPlaylistService` class |
| `packages/api/src/services/auto-playlist.service.test.ts` | **New** — unit tests |
| `packages/api/src/services/download-watcher.ts` | **Modified** — inject + call `AutoPlaylistService` after scan |
| `CLAUDE.md` | **Modified** — one-line doc addition |

---

## Known Limitations

**Partial folder batches:** Single vs folder detection is batch-scoped (one poll cycle = one batch). If a 5-file folder download completes across two poll cycles — e.g., 1 file finishes first, then the other 4 — the first file will be added to "All Singles" before the folder playlist is created. This is a known edge case and acceptable for the initial implementation. In practice, Soulseek folder downloads tend to complete close together.

---

## Out of Scope

- UI for managing auto-playlists (they appear in the normal playlist UI)
- Per-user auto-playlists (admin-owned only)
- Retry logic for missed tracks
- Configuring the "All Singles" playlist name
