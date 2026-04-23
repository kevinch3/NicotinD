# Auto-Playlist on Download Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After each completed Soulseek download, automatically add single-file downloads to an "All Singles" playlist and multi-file folder downloads to a playlist named after the cleaned folder.

**Architecture:** A new stateless `AutoPlaylistService` handles all playlist logic. `DownloadWatcher` accumulates completed files across poll cycles in `pendingPlaylistFiles[]`, drains it when the Navidrome scan debounce fires, and delegates to `AutoPlaylistService.processBatch()` after `startScan()` returns. Auto-playlists are owned by the admin Navidrome user (the existing client instance already carries admin credentials).

**Tech Stack:** Bun, TypeScript, `@nicotind/navidrome-client` (playlists + search + system APIs), `bun:test`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/api/src/services/auto-playlist.service.ts` | **Create** | `cleanFolderName`, `groupByDirectory`, `AutoPlaylistService` |
| `packages/api/src/services/auto-playlist.service.test.ts` | **Create** | Unit tests for all exported symbols |
| `packages/api/src/services/download-watcher.ts` | **Modify** | Import service, accumulate `pendingPlaylistFiles`, drain + call after scan |
| `packages/api/src/services/download-watcher.test.ts` | **Modify** | Inject mock `autoPlaylist`, add test verifying `processBatch` is called |
| `CLAUDE.md` | **Modify** | One-line doc under Key Design Patterns |

---

## Task 1: Pure helpers — `cleanFolderName` and `groupByDirectory`

**Files:**
- Create: `packages/api/src/services/auto-playlist.service.ts`
- Create: `packages/api/src/services/auto-playlist.service.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/api/src/services/auto-playlist.service.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test';
import { cleanFolderName, groupByDirectory, ALL_SINGLES } from './auto-playlist.service.js';
import type { CompletedDownloadFile } from './metadata-fixer.js';

describe('cleanFolderName', () => {
  it('strips bracketed quality tags', () => {
    expect(cleanFolderName('Dua Lipa - Future Nostalgia (2020) [FLAC 320kbps]'))
      .toBe('Dua Lipa - Future Nostalgia (2020)');
  });

  it('strips [MP3 V0] tag and extracts leaf from backslash path', () => {
    expect(cleanFolderName('Artist\\EP Name [MP3 V0]')).toBe('EP Name');
  });

  it('strips standalone (FLAC) parens but preserves year parens', () => {
    expect(cleanFolderName('Downloads\\Some Album (2019) (FLAC)')).toBe('Some Album (2019)');
  });

  it('strips standalone (MP3) parens', () => {
    expect(cleanFolderName('Downloads\\Some Album (MP3)')).toBe('Some Album');
  });

  it('extracts leaf segment from a forward-slash path', () => {
    expect(cleanFolderName('Music/Artist/Album Name [WEB]')).toBe('Album Name');
  });

  it('passes through an already-clean name unchanged', () => {
    expect(cleanFolderName('Clean Album Name')).toBe('Clean Album Name');
  });

  it('falls back to raw input when result would be empty', () => {
    expect(cleanFolderName('[FLAC]')).toBe('[FLAC]');
  });
});

describe('groupByDirectory', () => {
  it('puts a single file in its own group', () => {
    const files: CompletedDownloadFile[] = [
      { username: 'u', directory: 'dir1', filename: 'song.mp3' },
    ];
    const groups = groupByDirectory(files);
    expect(groups.size).toBe(1);
    expect(groups.get('dir1')).toHaveLength(1);
  });

  it('groups multiple files from the same directory together', () => {
    const files: CompletedDownloadFile[] = [
      { username: 'u', directory: 'dir1', filename: 'a.mp3' },
      { username: 'u', directory: 'dir1', filename: 'b.mp3' },
    ];
    const groups = groupByDirectory(files);
    expect(groups.size).toBe(1);
    expect(groups.get('dir1')).toHaveLength(2);
  });

  it('splits a mixed batch into separate groups', () => {
    const files: CompletedDownloadFile[] = [
      { username: 'u', directory: 'dir1', filename: 'a.mp3' },
      { username: 'u', directory: 'dir2', filename: 'b.mp3' },
      { username: 'u', directory: 'dir2', filename: 'c.mp3' },
    ];
    const groups = groupByDirectory(files);
    expect(groups.size).toBe(2);
    expect(groups.get('dir1')).toHaveLength(1);
    expect(groups.get('dir2')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test packages/api/src/services/auto-playlist.service.test.ts
```

Expected: error — module not found (file doesn't exist yet).

- [ ] **Step 3: Create the service file with the helpers**

Create `packages/api/src/services/auto-playlist.service.ts`:

```typescript
import { basename } from 'node:path';
import { createLogger } from '@nicotind/core';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { Playlist } from '@nicotind/core';
import type { CompletedDownloadFile } from './metadata-fixer.js';

const log = createLogger('auto-playlist');

export const ALL_SINGLES = 'All Singles';

/** Extracts the leaf folder name and strips audio quality/format tags. */
export function cleanFolderName(raw: string): string {
  // Extract leaf segment (handles both \ and / separators)
  const leaf = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? raw;

  // Strip bracketed tags: [FLAC 320kbps], [MP3 V0], [WEB], [CDRip], etc.
  let cleaned = leaf.replace(/\s*\[[^\]]*\]/g, '');

  // Strip parenthesized audio format names — but NOT years like (2020)
  cleaned = cleaned.replace(
    /\s*\((FLAC|MP3|WAV|AAC|OGG|OPUS|AIFF|ALAC|WMA|APE|LOSSLESS)\)/gi,
    '',
  );

  // Trim trailing whitespace and stray punctuation
  cleaned = cleaned.trim().replace(/[\s\-_]+$/, '').trim();

  return cleaned || leaf;
}

/** Groups completed files by their slskd directory field. */
export function groupByDirectory(
  files: CompletedDownloadFile[],
): Map<string, CompletedDownloadFile[]> {
  const groups = new Map<string, CompletedDownloadFile[]>();
  for (const file of files) {
    const group = groups.get(file.directory) ?? [];
    group.push(file);
    groups.set(file.directory, group);
  }
  return groups;
}

/**
 * Automatically places completed downloads into Navidrome playlists.
 * Single-file downloads go to "All Singles"; multi-file folder downloads
 * go to a playlist named after the cleaned folder. All playlists are owned
 * by the admin Navidrome user (the `navidrome` client instance carries admin credentials).
 */
export class AutoPlaylistService {
  constructor(
    private navidrome: Navidrome,
    private scanTimeoutMs = 30_000,
  ) {}

  async processBatch(_files: CompletedDownloadFile[]): Promise<void> {
    // Implemented in Task 2
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test packages/api/src/services/auto-playlist.service.test.ts
```

Expected: all `cleanFolderName` and `groupByDirectory` tests PASS. `processBatch` tests not yet written.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/auto-playlist.service.ts packages/api/src/services/auto-playlist.service.test.ts
git commit -m "feat(api): add AutoPlaylistService with cleanFolderName and groupByDirectory helpers"
```

---

## Task 2: `AutoPlaylistService.processBatch()` — full implementation

**Files:**
- Modify: `packages/api/src/services/auto-playlist.service.ts`
- Modify: `packages/api/src/services/auto-playlist.service.test.ts`

- [ ] **Step 1: Add `processBatch` tests to the test file**

Append to `packages/api/src/services/auto-playlist.service.test.ts`:

```typescript
import { mock, beforeEach } from 'bun:test';

// Helper: build a minimal Song-shaped object for mocks
function makeSong(id: string, path: string) {
  return {
    id,
    path,
    title: id,
    artist: '',
    album: '',
    albumId: '',
    artistId: '',
    size: 0,
    contentType: '',
    suffix: '',
    duration: 0,
    bitRate: 0,
    created: '',
  };
}

describe('AutoPlaylistService.processBatch', () => {
  let navidromeMock: any;
  let service: AutoPlaylistService;

  beforeEach(() => {
    navidromeMock = {
      system: {
        getScanStatus: mock(() => Promise.resolve({ scanning: false, count: 0 })),
      },
      playlists: {
        list: mock(() => Promise.resolve([])),
        create: mock((name: string) =>
          Promise.resolve({ id: `id-${name}`, name, songCount: 0, entry: [] }),
        ),
        get: mock((id: string) => Promise.resolve({ id, name: '', entry: [] })),
        update: mock(() => Promise.resolve()),
      },
      search: {
        search3: mock(() => Promise.resolve({ song: [], artist: [], album: [] })),
      },
    };
    // Pass scanTimeoutMs=0 so waitForScan returns immediately in tests
    service = new AutoPlaylistService(navidromeMock, 0);
  });

  it('does nothing for an empty batch', async () => {
    await service.processBatch([]);
    expect(navidromeMock.playlists.list).not.toHaveBeenCalled();
  });

  it('adds a single-file download to "All Singles"', async () => {
    navidromeMock.search.search3.mockReturnValue(
      Promise.resolve({ song: [makeSong('song-1', 'dir1/song.mp3')], artist: [], album: [] }),
    );

    await service.processBatch([{ username: 'u', directory: 'dir1', filename: 'song.mp3' }]);

    expect(navidromeMock.playlists.create).toHaveBeenCalledWith(ALL_SINGLES);
    expect(navidromeMock.playlists.update).toHaveBeenCalledWith(`id-${ALL_SINGLES}`, {
      songIdsToAdd: ['song-1'],
    });
  });

  it('creates a named playlist (with cleaned name) for a multi-file directory', async () => {
    navidromeMock.search.search3
      .mockReturnValueOnce(
        Promise.resolve({ song: [makeSong('s1', 'dir/a.mp3')], artist: [], album: [] }),
      )
      .mockReturnValueOnce(
        Promise.resolve({ song: [makeSong('s2', 'dir/b.mp3')], artist: [], album: [] }),
      );

    await service.processBatch([
      { username: 'u', directory: 'Music\\Artist - Album [FLAC]', filename: 'a.mp3' },
      { username: 'u', directory: 'Music\\Artist - Album [FLAC]', filename: 'b.mp3' },
    ]);

    expect(navidromeMock.playlists.create).toHaveBeenCalledWith('Artist - Album');
    expect(navidromeMock.playlists.update).toHaveBeenCalledWith('id-Artist - Album', {
      songIdsToAdd: ['s1', 's2'],
    });
  });

  it('appends to an existing playlist without re-adding duplicates', async () => {
    navidromeMock.playlists.list.mockReturnValue(
      Promise.resolve([{ id: 'existing-id', name: ALL_SINGLES, songCount: 1 }]),
    );
    // Playlist already contains 'old-song'
    navidromeMock.playlists.get.mockReturnValue(
      Promise.resolve({ id: 'existing-id', name: ALL_SINGLES, entry: [makeSong('old-song', 'x.mp3')] }),
    );
    // New file resolves to a different song ID
    navidromeMock.search.search3.mockReturnValue(
      Promise.resolve({ song: [makeSong('new-song', 'dir/new.mp3')], artist: [], album: [] }),
    );

    await service.processBatch([{ username: 'u', directory: 'dir', filename: 'new.mp3' }]);

    expect(navidromeMock.playlists.create).not.toHaveBeenCalled();
    expect(navidromeMock.playlists.update).toHaveBeenCalledWith('existing-id', {
      songIdsToAdd: ['new-song'],
    });
  });

  it('does not call update when resolved song is already in the playlist', async () => {
    navidromeMock.playlists.list.mockReturnValue(
      Promise.resolve([{ id: 'pl-id', name: ALL_SINGLES, songCount: 1 }]),
    );
    navidromeMock.playlists.get.mockReturnValue(
      Promise.resolve({ id: 'pl-id', name: ALL_SINGLES, entry: [makeSong('already-here', 'dir/song.mp3')] }),
    );
    navidromeMock.search.search3.mockReturnValue(
      Promise.resolve({ song: [makeSong('already-here', 'dir/song.mp3')], artist: [], album: [] }),
    );

    await service.processBatch([{ username: 'u', directory: 'dir', filename: 'song.mp3' }]);

    expect(navidromeMock.playlists.update).not.toHaveBeenCalled();
  });

  it('skips unresolvable tracks but continues processing the rest', async () => {
    navidromeMock.search.search3
      .mockReturnValueOnce(Promise.resolve({ song: [], artist: [], album: [] })) // a.mp3 not found
      .mockReturnValueOnce(
        Promise.resolve({ song: [makeSong('s2', 'dir/b.mp3')], artist: [], album: [] }),
      );

    await service.processBatch([
      { username: 'u', directory: 'dir', filename: 'a.mp3' },
      { username: 'u', directory: 'dir', filename: 'b.mp3' },
    ]);

    // Only b.mp3 found — should still be added
    expect(navidromeMock.playlists.update).toHaveBeenCalledWith(expect.any(String), {
      songIdsToAdd: ['s2'],
    });
  });

  it('aborts the batch if listing playlists fails', async () => {
    navidromeMock.playlists.list.mockReturnValue(Promise.reject(new Error('API down')));

    await expect(
      service.processBatch([{ username: 'u', directory: 'dir', filename: 'song.mp3' }]),
    ).resolves.toBeUndefined(); // must not throw

    expect(navidromeMock.playlists.create).not.toHaveBeenCalled();
  });

  it('skips a group when playlist creation fails but continues other groups', async () => {
    // All Singles create fails; Good Album create succeeds
    navidromeMock.playlists.create
      .mockReturnValueOnce(Promise.reject(new Error('quota exceeded')))
      .mockReturnValueOnce(
        Promise.resolve({ id: 'folder-id', name: 'Good Album', songCount: 0, entry: [] }),
      );
    // The single-dir group fails at create() before any search3 call, so only
    // the two folder-group files trigger search3.
    navidromeMock.search.search3
      .mockReturnValueOnce(
        Promise.resolve({ song: [makeSong('s1', 'folder/a.mp3')], artist: [], album: [] }),
      )
      .mockReturnValueOnce(
        Promise.resolve({ song: [makeSong('s2', 'folder/b.mp3')], artist: [], album: [] }),
      );

    await expect(
      service.processBatch([
        { username: 'u', directory: 'single-dir', filename: 'single.mp3' },
        { username: 'u', directory: 'folder', filename: 'a.mp3' },
        { username: 'u', directory: 'folder', filename: 'b.mp3' },
      ]),
    ).resolves.toBeUndefined();

    // The folder group should still be processed despite All Singles failing
    expect(navidromeMock.playlists.create).toHaveBeenCalledWith('Good Album');
    expect(navidromeMock.playlists.update).toHaveBeenCalledWith('folder-id', {
      songIdsToAdd: ['s1', 's2'],
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm the new ones fail**

```bash
bun test packages/api/src/services/auto-playlist.service.test.ts
```

Expected: `processBatch` tests FAIL (stub always returns immediately without doing anything).

- [ ] **Step 3: Implement `processBatch` and private methods**

Replace the `AutoPlaylistService` class in `packages/api/src/services/auto-playlist.service.ts` with the full implementation:

```typescript
export class AutoPlaylistService {
  constructor(
    private navidrome: Navidrome,
    private scanTimeoutMs = 30_000,
  ) {}

  /**
   * Groups `files` by directory, determines playlist names, and creates or
   * appends to Navidrome playlists. Best-effort — errors are logged, not thrown.
   */
  async processBatch(files: CompletedDownloadFile[]): Promise<void> {
    if (files.length === 0) return;

    await this.waitForScan();

    let allPlaylists: Playlist[];
    try {
      allPlaylists = await this.navidrome.playlists.list();
    } catch (err) {
      log.error({ err }, 'Failed to list playlists, aborting auto-playlist batch');
      return;
    }

    const groups = groupByDirectory(files);
    for (const [directory, groupFiles] of groups) {
      const name = groupFiles.length === 1 ? ALL_SINGLES : cleanFolderName(directory);
      await this.processGroup(name, groupFiles, allPlaylists);
    }
  }

  /** Polls getScanStatus until the scan finishes or the timeout is reached. */
  private async waitForScan(): Promise<void> {
    const deadline = Date.now() + this.scanTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const status = await this.navidrome.system.getScanStatus();
        if (!status.scanning) return;
      } catch {
        return; // If we can't query status, proceed anyway
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** Finds or creates a playlist by name, then appends new song IDs. */
  private async processGroup(
    name: string,
    files: CompletedDownloadFile[],
    allPlaylists: Playlist[],
  ): Promise<void> {
    let playlist = allPlaylists.find((p) => p.name === name);
    if (!playlist) {
      try {
        playlist = await this.navidrome.playlists.create(name);
        allPlaylists.push(playlist); // keep local cache in sync for subsequent groups
      } catch (err) {
        log.error({ err, name }, 'Failed to create playlist');
        return;
      }
    }

    let existingSongIds = new Set<string>();
    try {
      const full = await this.navidrome.playlists.get(playlist.id);
      existingSongIds = new Set(full.entry?.map((s) => s.id) ?? []);
    } catch (err) {
      log.warn({ err, name }, 'Failed to fetch existing playlist tracks, proceeding without dedup');
    }

    const songIdsToAdd: string[] = [];
    for (const file of files) {
      const id = await this.resolveSongId(file);
      if (!id) {
        log.warn({ filename: file.filename }, 'Could not resolve Navidrome song ID, skipping');
        continue;
      }
      if (!existingSongIds.has(id)) {
        songIdsToAdd.push(id);
      }
    }

    if (songIdsToAdd.length === 0) return;

    try {
      await this.navidrome.playlists.update(playlist.id, { songIdsToAdd });
      log.info({ name, added: songIdsToAdd.length }, 'Auto-playlist updated');
    } catch (err) {
      log.error({ err, name }, 'Failed to update playlist');
    }
  }

  /**
   * Searches Navidrome for a song matching the file's basename.
   * Returns the song ID or null if not found.
   */
  private async resolveSongId(file: CompletedDownloadFile): Promise<string | null> {
    const fileBasename = basename(file.filename.replace(/\\/g, '/')).toLowerCase();
    const nameWithoutExt = fileBasename.replace(/\.[^.]+$/, '');

    try {
      const results = await this.navidrome.search.search3(nameWithoutExt, {
        songCount: 10,
        artistCount: 0,
        albumCount: 0,
      });
      const match = results.song.find(
        (s) => basename(s.path).toLowerCase() === fileBasename,
      );
      return match?.id ?? null;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Run the full test file to confirm all tests pass**

```bash
bun test packages/api/src/services/auto-playlist.service.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/auto-playlist.service.ts packages/api/src/services/auto-playlist.service.test.ts
git commit -m "feat(api): implement AutoPlaylistService.processBatch with song resolution and dedup"
```

---

## Task 3: Wire `AutoPlaylistService` into `DownloadWatcher`

**Files:**
- Modify: `packages/api/src/services/download-watcher.ts`
- Modify: `packages/api/src/services/download-watcher.test.ts`

- [ ] **Step 1: Add the wiring test to `download-watcher.test.ts`**

Open `packages/api/src/services/download-watcher.test.ts`. 

First, add `autoPlaylistMock` to `beforeEach` and the existing `DownloadWatcher` constructor calls. Find the `beforeEach` block and add `autoPlaylistMock`:

```typescript
// Add this to the top-level variable declarations (alongside slskdMock, navidromeMock, etc.):
let autoPlaylistMock: any;

// Inside beforeEach, add:
autoPlaylistMock = {
  processBatch: mock(() => Promise.resolve()),
};

// Change the existing DownloadWatcher constructor call to inject the mock:
watcher = new DownloadWatcher(slskdMock, navidromeMock, {
  intervalMs: 10,
  scanDebounceMs: 10,
  metadataFixer: metadataFixerMock,
  autoPlaylist: autoPlaylistMock,   // ← add this
});
```

Then add a new test at the end of the `describe` block:

```typescript
it('calls autoPlaylist.processBatch with completed files after scan debounce', async () => {
  slskdMock.transfers.getDownloads.mockReturnValue(
    Promise.resolve([
      {
        username: 'user1',
        directories: [
          {
            directory: 'Artist - Album',
            files: [
              { filename: 'a.mp3', state: 'Completed, Succeeded' },
              { filename: 'b.mp3', state: 'Completed, Succeeded' },
            ],
          },
        ],
      },
    ]),
  );

  await (watcher as any).check();
  await new Promise((r) => setTimeout(r, 50)); // wait for debounce

  expect(autoPlaylistMock.processBatch).toHaveBeenCalledTimes(1);
  expect(autoPlaylistMock.processBatch).toHaveBeenCalledWith([
    { username: 'user1', directory: 'Artist - Album', filename: 'a.mp3' },
    { username: 'user1', directory: 'Artist - Album', filename: 'b.mp3' },
  ]);
});
```

- [ ] **Step 2: Run the updated test file to confirm the new test fails**

```bash
bun test packages/api/src/services/download-watcher.test.ts
```

Expected: new test FAILS (DownloadWatcher doesn't accept/call `autoPlaylist` yet). Existing tests should still pass.

- [ ] **Step 3: Update `download-watcher.ts`**

Make these four changes to `packages/api/src/services/download-watcher.ts`:

**3a. Add import at the top (after existing imports):**

```typescript
import { AutoPlaylistService } from './auto-playlist.service.js';
```

**3b. Extend `DownloadWatcherOptions` interface (add one field):**

```typescript
interface DownloadWatcherOptions {
  intervalMs?: number;
  scanDebounceMs?: number;
  musicDir?: string;
  metadataFixEnabled?: boolean;
  metadataFixMinScore?: number;
  metadataFixer?: { processCompletedDownloads: (files: CompletedDownloadFile[]) => Promise<void> };
  autoPlaylist?: { processBatch: (files: CompletedDownloadFile[]) => Promise<void> };  // ← add
}
```

**3c. Add two new private fields to the class (after `private checking = false;`):**

```typescript
private pendingPlaylistFiles: CompletedDownloadFile[] = [];
private autoPlaylist: { processBatch: (files: CompletedDownloadFile[]) => Promise<void> };
```

**3d. Wire it up in the constructor (add after the `this.metadataFixer = ...` block):**

```typescript
this.autoPlaylist = options.autoPlaylist ?? new AutoPlaylistService(navidrome);
```

**3e. Accumulate files in `check()` — change the `completedFiles.push(...)` block:**

```typescript
const fileData: CompletedDownloadFile = {
  username: group.username,
  directory: dir.directory,
  filename: file.filename,
};
completedFiles.push(fileData);
this.pendingPlaylistFiles.push(fileData);
```

(Remove the old inline object literal from `completedFiles.push()`.)

**3f. Drain pending files and call `processBatch` in `debouncedScan()`:**

Replace the existing `debouncedScan` method body with:

```typescript
private debouncedScan(): void {
  if (this.scanDebounceTimer) {
    clearTimeout(this.scanDebounceTimer);
  }

  this.scanDebounceTimer = setTimeout(async () => {
    const filesToProcess = this.pendingPlaylistFiles.splice(0);
    try {
      log.info('Triggering Navidrome library scan');
      await this.navidrome.system.startScan();
    } catch (err) {
      log.error({ err }, 'Failed to trigger scan');
    }
    try {
      await this.autoPlaylist.processBatch(filesToProcess);
    } catch (err) {
      log.error({ err }, 'Auto-playlist processing failed');
    }
  }, this.scanDebounceMs);
}
```

- [ ] **Step 4: Run both test files to confirm everything passes**

```bash
bun test packages/api/src/services/download-watcher.test.ts packages/api/src/services/auto-playlist.service.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Run the full type check**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/services/download-watcher.ts packages/api/src/services/download-watcher.test.ts
git commit -m "feat(api): wire AutoPlaylistService into DownloadWatcher after scan debounce"
```

---

## Task 4: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add one line under Key Design Patterns in `CLAUDE.md`**

Find the **Key Design Patterns** section. After the last bullet in that section, add:

```markdown
- **Auto-playlists**: `AutoPlaylistService` (`packages/api/src/services/auto-playlist.service.ts`) runs after each Navidrome scan — single-file downloads → "All Singles", multi-file folder downloads → playlist named after the cleaned folder. Owned by the admin Navidrome user.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document AutoPlaylistService in CLAUDE.md"
```

---

## Verification

Run the complete test suite to confirm no regressions:

```bash
bun test
bun run typecheck
```

Expected: all tests pass, no type errors.

To do a manual end-to-end check:
1. Start NicotinD with `bun run src/main.ts`
2. Trigger a single-file download from Soulseek
3. After ~15 seconds (5s poll + 10s scan debounce), open the Playlists tab — "All Singles" should appear with the track
4. Trigger a folder download (2+ files from the same remote directory)
5. After ~15 seconds, a new playlist named after the cleaned folder should appear with those tracks
