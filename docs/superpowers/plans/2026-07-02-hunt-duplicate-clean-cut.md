# Clean-cut download→library dedupe reconciliation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the download→library transition the single reconciliation point so hunted albums never show duplicate tracks (not even transiently), and surface the destination album on download cards with a deep link.

**Architecture:** Two-stage clean cut. The **Download stage** (`LibraryOrganizer`) produces a genuinely clean folder on disk via a new tag/title-aware `reconcileAlbumFolder` (stronger than today's filename-only `dedupeFolder`). The **Library stage** (`LibraryScanner`) reflects it faithfully via an album-scoped rescan + orphan-row prune. Both slskd and URL-acquire ingests share the same seam, so one change fixes both.

**Tech Stack:** Bun + TypeScript, SQLite (`bun:sqlite`), Hono API, `music-metadata`, Angular v22 (web), vitest (api + web unit), Playwright (e2e).

## Global Constraints

- Test typing: no `no-explicit-any`; use `ReturnType<typeof makeX>` / typed JSON responses (see `[[feedback_test_typing_conventions]]`).
- Web build/test require Node **>=22.22.3** (`nvm use 22.22.3`) — see `[[project_web_build_node_version]]`.
- New shared types used by the web package must be re-exported in `packages/web/src/types/core.ts` (`[[project_web_core_type_shim]]`).
- Never mock node builtins in api tests; use real temp dirs (`[[project_flaky_parallel_api_tests]]`).
- Web JIT vitest can't drive `input()` signals — push logic into DI-free helpers, test those (`[[project_web_jit_input_test_limitation]]`).
- Commits: Conventional Commits; **no** Claude attribution/footers (`[[feedback_no_commit_attribution]]`).
- Docs updated in the same PR as code (Quality Gate 3); every change tested and CI-covered (Gates 1 & 2).
- `bun run format` dirties the whole repo — stage only files you changed (`[[project_windowed_library_processing]]`).

---

## File Structure

- **Create** `packages/api/src/services/album-reconcile.ts` — pure tag/title-aware folder reconciler (`reconcileAlbumFolder`) + the file-reading adapter (`readFolderTracks`).
- **Create** `packages/api/src/services/album-reconcile.test.ts` — unit tests for the reconciler.
- **Modify** `packages/api/src/services/library-organizer.ts` — call the reconciler instead of `dedupeFolder`; extend `OrganizeResult` with `deletedRelPaths` + `affectedAlbumDirs`; add `canonicalTitlesLookup` option.
- **Modify** `packages/api/src/services/library-scanner.ts` — add `reconcileAlbums(albumDirs)` (album-scoped scan) + `pruneAlbumOrphans(albumIds)`.
- **Create** `packages/api/src/services/library-scanner.reconcile.test.ts` — album-scoped prune unit test.
- **Modify** `packages/api/src/services/download-watcher.ts` — feed `affectedAlbumDirs` to the scanner, delete `completed_downloads` by `deletedRelPaths`.
- **Modify** `packages/api/src/services/acquire-watcher.ts` — same seam for URL acquires.
- **Create** `packages/api/src/services/reconcile-integration.test.ts` — two-wave regression test (organize+scan twice → one clean album, no phantom rows).
- **Modify** `packages/api/src/index.ts` — wire `canonicalTitlesLookup`; pass `affectedAlbumDirs` through the watcher scan callbacks.
- **Modify** `packages/api/src/routes/downloads.ts` — attach `albumId` to enriched slskd downloads.
- **Modify** `packages/api/src/routes/acquire.ts` (job read model) — attach destination `albumId`/artist/album.
- **Create** `packages/web/src/app/lib/download-destination.ts` + `.spec.ts` — pure `albumLinkFor`.
- **Modify** `packages/web/src/app/lib/download-groups.ts` — `DownloadItem.albumId`; populate in both adapters.
- **Modify** `packages/web/src/app/components/download-item/*` — destination wrapper + "Open in Library" deep link + `data-testid`s.
- **Modify** docs: `docs/download-pipeline.md`, `docs/album-hunt.md`, `docs/web-ui.md`, `CLAUDE.md`.

---

## Task 1: Pure tag/title-aware folder reconciler

**Files:**
- Create: `packages/api/src/services/album-reconcile.ts`
- Test: `packages/api/src/services/album-reconcile.test.ts`

**Interfaces:**
- Consumes: `selectAlbumTracks`, `SelectableTrack`, `formatQuality` from `./library-track-select.js`.
- Produces:
  - `interface ReconcileResult { deletedNames: string[]; keptNames: string[] }`
  - `function chooseFolderKeepers(files: ReconcileFile[], canonicalTitles?: readonly string[] | null): ReconcileResult` — pure, no IO.
  - `interface ReconcileFile { name: string; title: string; suffix: string; bitRate: number }`
  - `function reconcileAlbumFolder(dir: string, canonicalTitles: readonly string[] | null, opts?: { apply?: boolean }): ReconcileResult` — reads the folder, deletes losers when `apply`.
  - `const SINGLES_DIR_RE = /(^|\/)Singles$/i`

- [ ] **Step 1: Write the failing test for `chooseFolderKeepers`**

```ts
// packages/api/src/services/album-reconcile.test.ts
import { describe, it, expect } from 'vitest';
import { chooseFolderKeepers, type ReconcileFile } from './album-reconcile.js';

const f = (name: string, title: string, suffix: string, bitRate: number): ReconcileFile => ({
  name, title, suffix, bitRate,
});

describe('chooseFolderKeepers', () => {
  it('collapses same-track different-filename copies, keeping FLAC', () => {
    const files = [
      f('05_circus.flac', 'Circus', 'flac', 900),
      f('02 - Circus.mp3', 'Circus', 'mp3', 320),
    ];
    const { deletedNames, keptNames } = chooseFolderKeepers(files);
    expect(keptNames).toEqual(['05_circus.flac']);
    expect(deletedNames).toEqual(['02 - Circus.mp3']);
  });

  it('within one format keeps the higher bitrate', () => {
    const files = [f('a.mp3', 'Toxic', 'mp3', 192), f('b.mp3', 'Toxic', 'mp3', 320)];
    const { keptNames } = chooseFolderKeepers(files);
    expect(keptNames).toEqual(['b.mp3']);
  });

  it('drops foreign rips when canonical titles are provided', () => {
    const files = [f('01 Circus.mp3', 'Circus', 'mp3', 320), f('bonus.mp3', 'DJ Drop', 'mp3', 320)];
    const { deletedNames } = chooseFolderKeepers(files, ['Circus', 'Womanizer']);
    expect(deletedNames).toEqual(['bonus.mp3']);
  });

  it('never deletes the last copy of a distinct track', () => {
    const files = [f('a.mp3', 'Circus', 'mp3', 320), f('b.mp3', 'Womanizer', 'mp3', 320)];
    const { deletedNames } = chooseFolderKeepers(files);
    expect(deletedNames).toEqual([]);
  });

  it('breaks equal-quality ties by lexicographically smallest name (deterministic)', () => {
    const files = [f('z.mp3', 'Circus', 'mp3', 320), f('a.mp3', 'Circus', 'mp3', 320)];
    const { keptNames } = chooseFolderKeepers(files);
    expect(keptNames).toEqual(['a.mp3']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && bun run vitest run src/services/album-reconcile.test.ts`
Expected: FAIL — `Cannot find module './album-reconcile.js'`.

- [ ] **Step 3: Implement `album-reconcile.ts`**

```ts
// packages/api/src/services/album-reconcile.ts
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { AUDIO_EXTS } from './audio-tags.js';
import { getMusicMetadata } from './music-metadata-loader.js';
import { selectAlbumTracks, type SelectableTrack } from './library-track-select.js';

/** Album folders that must never be collapsed as one album (each loose track is its own single). */
export const SINGLES_DIR_RE = /(^|[/\\])Singles$/i;

export interface ReconcileFile {
  name: string;
  title: string;
  suffix: string;
  bitRate: number;
}

export interface ReconcileResult {
  deletedNames: string[];
  keptNames: string[];
}

/**
 * Pure keeper-selection for one album folder. Uses the SAME identity + quality
 * ranking as the library scanner (`selectAlbumTracks`): canonical-title match
 * (dropping foreign rips) when `canonicalTitles` is given, else normalized title,
 * FLAC > lossy > bitrate, ties on smallest name. Returns which files to keep vs
 * delete. No IO — directly unit-testable.
 */
export function chooseFolderKeepers(
  files: ReconcileFile[],
  canonicalTitles?: readonly string[] | null,
): ReconcileResult {
  // relPath === name here so selectAlbumTracks' deterministic tiebreak sorts by name.
  const selectable: (SelectableTrack & { name: string })[] = files.map((x) => ({
    relPath: x.name,
    name: x.name,
    title: x.title,
    suffix: x.suffix,
    bitRate: x.bitRate,
  }));
  const kept = new Set(selectAlbumTracks(selectable, canonicalTitles).map((t) => t.name));
  const keptNames: string[] = [];
  const deletedNames: string[] = [];
  for (const x of files) (kept.has(x.name) ? keptNames : deletedNames).push(x.name);
  return { keptNames, deletedNames };
}

/** Read a folder's audio files into ReconcileFile[] (title via tag, fallback filename stem). */
export async function readFolderTracks(dir: string): Promise<ReconcileFile[]> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const mm = await getMusicMetadata();
  const out: ReconcileFile[] = [];
  for (const name of entries) {
    const ext = extname(name).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) continue;
    const abs = join(dir, name);
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    let title = name.slice(0, name.length - ext.length);
    let bitRate = 0;
    try {
      const meta = mm ? await mm.parseFile(abs, { duration: false, skipCovers: true }) : undefined;
      if (meta?.common?.title) title = meta.common.title;
      if (meta?.format?.bitrate) bitRate = Math.round(meta.format.bitrate / 1000);
    } catch {
      // unreadable — fall back to filename stem + 0 bitrate
    }
    out.push({ name, title, suffix: ext.slice(1), bitRate });
  }
  return out;
}

/**
 * Reconcile one album folder on disk: keep one best copy per track, delete the
 * rest. `canonicalTitles` (from a matching album_jobs row) enables foreign-rip
 * dropping. Skips the shared `Singles` bucket. Deletes only when `apply`.
 */
export async function reconcileAlbumFolder(
  dir: string,
  canonicalTitles: readonly string[] | null,
  opts: { apply?: boolean } = {},
): Promise<ReconcileResult> {
  if (SINGLES_DIR_RE.test(dir)) return { deletedNames: [], keptNames: [] };
  const files = await readFolderTracks(dir);
  const result = chooseFolderKeepers(files, canonicalTitles);
  if (opts.apply) {
    for (const name of result.deletedNames) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // leave it; the scanner's existence-based prune will not remove a live file
      }
    }
  }
  return result;
}
```

> Note: confirm the music-metadata loader import path (`grep -rn "getMusicMetadata" packages/api/src/services/library-scanner.ts`); use whatever module the scanner imports. If it's a private method, extract `getMusicMetadata` to a small shared loader module first (see the scanner's `getMusicMetadata` usage at `library-scanner.ts:607`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && bun run vitest run src/services/album-reconcile.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/album-reconcile.ts packages/api/src/services/album-reconcile.test.ts
git commit -m "feat(library): tag/title-aware album-folder reconciler (pure core)"
```

---

## Task 2: Wire the reconciler into `LibraryOrganizer`

**Files:**
- Modify: `packages/api/src/services/library-organizer.ts`
- Test: `packages/api/src/services/library-organizer.test.ts` (extend; confirm exact filename with `ls packages/api/src/services/library-organizer*.test.ts`)

**Interfaces:**
- Consumes: `reconcileAlbumFolder` from Task 1.
- Produces (extended `OrganizeResult`):
  - `deletedRelPaths: string[]` — music-dir-relative paths deleted this batch.
  - `affectedAlbumDirs: string[]` — absolute canonical album dirs touched this batch.
  - New option `canonicalTitlesLookup?: (dir: string) => readonly string[] | null` on `LibraryOrganizerOptions`.

- [ ] **Step 1: Write the failing test** (two rips of the same track, different filenames, same touched dir → one deleted, reported in `deletedRelPaths`; dir in `affectedAlbumDirs`).

```ts
// in library-organizer.test.ts — new describe block
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('reconcile deletes a cross-name duplicate and reports rel path + album dir', async () => {
  const music = mkdtempSync(join(tmpdir(), 'recon-'));
  const albumDir = join(music, 'Britney Spears', 'Circus');
  mkdirSync(albumDir, { recursive: true });
  // Two title-identical MP3s with different filenames dedupeFolder would MISS:
  writeFileSync(join(albumDir, '02 - Circus.mp3'), fakeMp3('Circus', 128));
  writeFileSync(join(albumDir, 'circus_radio.mp3'), fakeMp3('Circus', 320));
  const org = new LibraryOrganizer({ musicDir: music, autoDedupe: true });
  // Simulate a touched dir directly (organizeBatch normally fills this):
  const res = await org.reconcileTouched([albumDir], () => null);
  expect(res.deletedRelPaths.length).toBe(1);
  expect(res.affectedAlbumDirs).toContain(albumDir);
});
```

> `fakeMp3(title, kbps)` = a helper writing a minimal ID3-tagged buffer; reuse the fixture helper the existing organizer/scanner tests already use (grep `writeFileSync.*mp3` in the api test suite). If none exists, assert on `deletedRelPaths.length` using filename-only titles (pass `title` via the mock `readFolderTracks`) — but prefer the real fixture for fidelity.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/api && bun run vitest run src/services/library-organizer.test.ts -t reconcile`
Expected: FAIL — `reconcileTouched` / new fields not defined.

- [ ] **Step 3: Implement**

Add to `LibraryOrganizerOptions`:

```ts
  /** Canonical Lidarr track titles for a folder (enables foreign-rip dropping). */
  canonicalTitlesLookup?: (dir: string) => readonly string[] | null;
```

Extend `OrganizeResult`:

```ts
  /** Music-dir-relative paths of files removed by reconciliation this batch. */
  deletedRelPaths: string[];
  /** Absolute canonical album dirs touched this batch (for album-scoped rescan). */
  affectedAlbumDirs: string[];
```

Store the option in the constructor (`this.canonicalTitlesLookup = opts.canonicalTitlesLookup;`), init the new result fields (`deletedRelPaths: [], affectedAlbumDirs: []`), and replace the `autoDedupe` block in `organizeBatch`:

```ts
    if (this.autoDedupe) {
      const r = await this.reconcileTouched([...this.touchedAlbumDirs], this.canonicalTitlesLookup);
      result.deletedRelPaths = r.deletedRelPaths;
      result.affectedAlbumDirs = r.affectedAlbumDirs;
      result.dedupedBasenames = r.deletedRelPaths.map((p) => basename(p).toLowerCase());
    } else {
      result.affectedAlbumDirs = [...this.touchedAlbumDirs];
    }
```

Add the method:

```ts
  /** Reconcile each touched album folder on disk; returns removed rel paths + dirs. */
  async reconcileTouched(
    dirs: string[],
    canonicalTitlesLookup?: (dir: string) => readonly string[] | null,
  ): Promise<{ deletedRelPaths: string[]; affectedAlbumDirs: string[] }> {
    const deletedRelPaths: string[] = [];
    for (const dir of dirs) {
      const canonical = canonicalTitlesLookup?.(dir) ?? null;
      const { deletedNames } = await reconcileAlbumFolder(dir, canonical, { apply: true });
      for (const name of deletedNames) {
        const rel = relative(this.musicDir, join(dir, name)).split(sep).join('/');
        deletedRelPaths.push(rel);
        log.info({ dir, dropped: name }, 'Reconcile removed a duplicate copy');
      }
    }
    return { deletedRelPaths, affectedAlbumDirs: dirs };
  }
```

Add the import: `import { reconcileAlbumFolder } from './album-reconcile.js';` and ensure `relative`, `sep` are imported from `node:path`.

- [ ] **Step 4: Run tests**

Run: `cd packages/api && bun run vitest run src/services/library-organizer.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/library-organizer.ts packages/api/src/services/library-organizer.test.ts
git commit -m "feat(library): organizer runs tag-aware reconcile, reports deleted paths + album dirs"
```

---

## Task 3: Album-scoped rescan + orphan prune in `LibraryScanner`

**Files:**
- Modify: `packages/api/src/services/library-scanner.ts`
- Test: `packages/api/src/services/library-scanner.reconcile.test.ts`

**Interfaces:**
- Consumes: existing `buildLibrary`, `persist`, `canonicalByAlbum`, `walk`, `readTracks`, `pruneOrphanArtist` (from `./library-aggregates.js`).
- Produces:
  - `async reconcileAlbums(albumDirs: string[]): Promise<void>` — rescans whole folders + prunes orphan rows for the affected albums.
  - `pruneAlbumOrphans(albumIds: string[], syncedAt: number): void` (private).

- [ ] **Step 1: Write the failing test** — seed two song rows in one album, one pointing at a real file, one at a deleted path; call `reconcileAlbums` on the album dir; assert the orphan row is gone and the live row + album aggregate remain.

```ts
// packages/api/src/services/library-scanner.reconcile.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../db.js';               // confirm exact export
import { LibraryScanner } from './library-scanner.js';

describe('reconcileAlbums prunes orphan song rows', () => {
  it('removes a library_songs row whose file no longer exists', async () => {
    const music = mkdtempSync(join(tmpdir(), 'scan-'));
    const albumDir = join(music, 'Artist', 'Album');
    mkdirSync(albumDir, { recursive: true });
    writeFileSync(join(albumDir, '01 - Kept.mp3'), fakeMp3('Kept', 320));
    const db = new Database(':memory:');
    runMigrations(db);
    const scanner = new LibraryScanner(db, music);
    // First scan indexes the live file:
    await scanner.reconcileAlbums([albumDir]);
    const albumId = db.query<{ id: string }, []>('SELECT id FROM library_albums LIMIT 1').get()!.id;
    // Inject an orphan row (a phantom cross-wave duplicate) pointing at a deleted path:
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, path, synced_at)
       VALUES ('orphan', ?, 'Kept', 'Artist', 'Artist/Album/ghost.mp3', 1)`,
      [albumId],
    );
    await scanner.reconcileAlbums([albumDir]);
    const rows = db.query('SELECT id FROM library_songs WHERE album_id = ?', [albumId]).all();
    expect(rows.map((r: any) => r.id)).not.toContain('orphan');
    expect(rows.length).toBe(1);
  });
});
```

> Confirm the `LibraryScanner` constructor signature and migration entry point by reading the top of `library-scanner.ts` and `db.ts`; adapt the two lines above to the real API. The seed columns must match the real `library_songs` schema (add NOT NULL columns as needed).

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/api && bun run vitest run src/services/library-scanner.reconcile.test.ts`
Expected: FAIL — `reconcileAlbums` not a function.

- [ ] **Step 3: Implement**

Add imports at top: `import { existsSync } from 'node:fs';` and `import { pruneOrphanArtist } from './library-aggregates.js';` (confirm not already imported). Then:

```ts
  /**
   * Album-scoped reconcile: rescan the WHOLE of each affected album folder (so
   * every surviving on-disk file is re-indexed with a fresh synced_at), then
   * prune any library_songs row for those albums whose file no longer exists on
   * disk. This is the incremental analogue of scanFull's global prune — it kills
   * cross-wave orphan rows (files the organizer just deleted) without a full walk.
   */
  async reconcileAlbums(albumDirs: string[]): Promise<void> {
    const dirs = [...new Set(albumDirs)];
    if (dirs.length === 0) return;
    const abs: string[] = [];
    for (const d of dirs) abs.push(...(await this.walk(d)));
    const syncedAt = Date.now();
    const tracks = await this.readTracks(abs);
    if (tracks.length > 0) {
      const built = buildLibrary(tracks, this.canonicalByAlbum(), loadOverrides(this.db));
      this.persist(built, syncedAt, false);
      this.pruneAlbumOrphans(built.albums.map((a) => a.id), syncedAt);
    }
    log.info({ dirs: dirs.length, files: abs.length }, 'Album-scoped reconcile complete');
  }

  /** Delete library_songs rows for the given albums whose file is gone from disk. */
  private pruneAlbumOrphans(albumIds: string[], _syncedAt: number): void {
    for (const albumId of [...new Set(albumIds)]) {
      const rows = this.db
        .query<{ id: string; path: string; artist_id: string | null }, [string]>(
          'SELECT id, path, artist_id FROM library_songs WHERE album_id = ?',
        )
        .all(albumId);
      let removed = 0;
      for (const r of rows) {
        if (r.path && existsSync(join(this.musicDir, r.path))) continue;
        this.db.run('DELETE FROM library_songs WHERE id = ?', [r.id]);
        this.db.run('DELETE FROM library_song_artists WHERE song_id = ?', [r.id]);
        removed++;
      }
      if (removed > 0) {
        // Recompute the album aggregate from its surviving songs.
        this.db.run(
          `UPDATE library_albums SET
             song_count = (SELECT COUNT(*) FROM library_songs WHERE album_id = ?),
             duration   = (SELECT COALESCE(SUM(duration),0) FROM library_songs WHERE album_id = ?)
           WHERE id = ?`,
          [albumId, albumId, albumId],
        );
        // Drop an album row that lost all songs, and prune a now-orphan artist.
        const count = this.db
          .query<{ n: number }, [string]>('SELECT COUNT(*) n FROM library_songs WHERE album_id = ?')
          .get(albumId)!.n;
        if (count === 0) {
          const artistId = this.db
            .query<{ artist_id: string | null }, [string]>(
              'SELECT artist_id FROM library_albums WHERE id = ?',
            )
            .get(albumId)?.artist_id;
          this.db.run('DELETE FROM library_albums WHERE id = ?', [albumId]);
          this.db.run('DELETE FROM library_album_artists WHERE album_id = ?', [albumId]);
          if (artistId) pruneOrphanArtist(this.db, artistId);
        }
      }
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `cd packages/api && bun run vitest run src/services/library-scanner.reconcile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/library-scanner.ts packages/api/src/services/library-scanner.reconcile.test.ts
git commit -m "feat(library): album-scoped reconcile scan + orphan-row prune"
```

---

## Task 4: Wire watchers to the seam + two-wave regression test

**Files:**
- Modify: `packages/api/src/services/download-watcher.ts`
- Modify: `packages/api/src/services/acquire-watcher.ts`
- Modify: `packages/api/src/index.ts`
- Test: `packages/api/src/services/reconcile-integration.test.ts`

**Interfaces:**
- Consumes: `OrganizeResult.deletedRelPaths` + `.affectedAlbumDirs` (Task 2); `LibraryScanner.reconcileAlbums` (Task 3).
- Produces: watcher scan callbacks now receive `affectedAlbumDirs` and call `reconcileAlbums`.

- [ ] **Step 1: Write the failing integration test** (the regression for the reported bug).

```ts
// packages/api/src/services/reconcile-integration.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../db.js';
import { LibraryOrganizer } from './library-organizer.js';
import { LibraryScanner } from './library-scanner.js';

describe('two-wave hunt lands one clean album (regression)', () => {
  it('no duplicate rows and one file per track after a second wave', async () => {
    const music = mkdtempSync(join(tmpdir(), 'ingest-'));
    const staging = join(music, '_incoming');
    const db = new Database(':memory:');
    runMigrations(db);
    const organizer = new LibraryOrganizer({ musicDir: music, stagingDir: staging, autoDedupe: true });
    const scanner = new LibraryScanner(db, music);

    const wave = async (fname: string, kbps: number) => {
      const peer = join(staging, 'Artist - Album');
      mkdirSync(peer, { recursive: true });
      writeFileSync(join(peer, fname), fakeMp3('Circus', kbps));
      const files = [{ username: 'u', directory: 'Artist - Album', filename: join(peer, fname) }];
      const res = await organizer.organizeBatch(files as any);
      await scanner.reconcileAlbums(res.affectedAlbumDirs);
      return res;
    };

    await wave('01 - Circus.mp3', 192);
    await wave('circus (radio).mp3', 320); // same track, different name, higher bitrate

    const songs = db.query('SELECT title, path FROM library_songs').all() as any[];
    expect(songs.length).toBe(1);                       // no duplicate row
    expect(existsSync(join(music, songs[0].path))).toBe(true); // row points at a real file
  });
});
```

> Adapt `fakeMp3`, the `LibraryScanner`/`LibraryOrganizer` constructors, and `CompletedDownloadFile` shape to the real signatures. Keep acquisition default-off — no slskd/Lidarr needed.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/api && bun run vitest run src/services/reconcile-integration.test.ts`
Expected: FAIL — likely 2 rows (the pre-fix duplicate) or a missing-file path.

> If it *passes* before the watcher wiring, that's fine — it validates Tasks 2+3 end-to-end. The watcher edits below make the real ingest paths use them.

- [ ] **Step 3: Implement — download-watcher**

In `download-watcher.ts`, change the `organizeBatch` result handling (around line 232-258): capture `affectedAlbumDirs` + `deletedRelPaths`, delete `completed_downloads` for deleted files, and pass the dirs to the scan callback.

```ts
        const orgResult = (await this.libraryOrganizer.organizeBatch(completedFiles)) as
          | { deletedRelPaths?: string[]; affectedAlbumDirs?: string[]; dedupedBasenames?: string[] }
          | undefined;
        for (const rel of orgResult?.deletedRelPaths ?? []) {
          this.getDb().run('DELETE FROM completed_downloads WHERE relative_path = ?', [rel]);
        }
        // ... existing updateRelativePath / recordSlskdAcquisition loop unchanged ...
        this.pendingAlbumDirs.push(...(orgResult?.affectedAlbumDirs ?? []));
        this.debouncedScan();
```

Change `debouncedScan`/`runScan` to flush `pendingAlbumDirs` and call `this.scanAlbums(dirs)` (the injected album-scoped callback). Add a `pendingAlbumDirs: string[] = []` field and a `scanAlbums?: (dirs: string[]) => Promise<void>` constructor option alongside the existing `scan`. Keep `scan` for any legacy caller; prefer `scanAlbums` when set.

```ts
  private async runScan(albumDirs: string[]): Promise<void> {
    if (albumDirs.length === 0) return;
    try {
      log.info({ dirs: albumDirs.length }, 'Album-scoped reconcile after download');
      await this.scanAlbums(albumDirs);
    } catch (err) {
      log.error({ err }, 'Reconcile after download failed');
    }
  }
```

- [ ] **Step 4: Implement — acquire-watcher**

In `acquire-watcher.ts` `ingest`, capture the organize result and call an album-scoped scan:

```ts
      const orgResult = (await this.options.organizeBatch(files)) as
        | { deletedRelPaths?: string[]; affectedAlbumDirs?: string[] }
        | undefined;
      const relPaths = files.map((f) => f.relativePath).filter((p): p is string => Boolean(p));
      // ... existing recordAcquisition loop + setStoragePath unchanged ...
      if (relPaths.length > 0) {
        this.setStage(id, 'scanning');
        await this.options.reconcileAlbums(orgResult?.affectedAlbumDirs ?? []);
        if (this.options.enrichSingles) await this.options.enrichSingles(relPaths);
      }
```

Add `reconcileAlbums: (dirs: string[]) => Promise<void>` to the acquire-watcher options type; keep `scanIncremental` if other callers use it, else replace.

- [ ] **Step 5: Implement — index.ts wiring**

Wire the two callbacks to `scanner.reconcileAlbums(...)`, and add `canonicalTitlesLookup` to the organizer options (query `album_jobs.canonical_tracks_json` by the folder's last-two-segments artist/album, mirroring the existing `jobLookup`):

```ts
    canonicalTitlesLookup: (dir) => {
      const segs = dir.replace(/\\/g, '/').split('/').filter(Boolean);
      if (segs.length < 2) return null;
      const album = segs[segs.length - 1]!;
      const artist = segs[segs.length - 2]!;
      const row = db
        .query<{ canonical_tracks_json: string }, [string, string]>(
          `SELECT canonical_tracks_json FROM album_jobs
           WHERE artist_name = ? AND album_title = ? AND canonical_tracks_json IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(artist, album);
      if (!row) return null;
      try {
        const t = JSON.parse(row.canonical_tracks_json);
        return Array.isArray(t) && t.length ? (t as string[]) : null;
      } catch {
        return null;
      }
    },
```

Update the `DownloadWatcher` / `AcquireWatcher` construction to pass `scanAlbums: (dirs) => scanner.reconcileAlbums(dirs)` / `reconcileAlbums: (dirs) => scanner.reconcileAlbums(dirs)`.

- [ ] **Step 6: Run the integration test + full api suite**

Run: `cd packages/api && bun run vitest run src/services/reconcile-integration.test.ts && bun run vitest run`
Expected: PASS (integration + no regressions). Also `bun run typecheck` from repo root.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/services/download-watcher.ts packages/api/src/services/acquire-watcher.ts packages/api/src/index.ts packages/api/src/services/reconcile-integration.test.ts
git commit -m "feat(library): reconcile at download→library seam for slskd + URL acquires"
```

---

## Task 5: Server — attach destination `albumId` to downloads

**Files:**
- Modify: `packages/api/src/routes/downloads.ts`
- Modify: `packages/api/src/routes/acquire.ts` (job read model — confirm the file mapping `AcquireJob`; grep `mapRow` / `storage_path`)
- Test: `packages/api/src/routes/downloads.test.ts` (extend) + acquire jobs test

**Interfaces:**
- Consumes: `albumIdFor` from the scanner module (confirm export path: `grep -rn "export function albumIdFor" packages/api/src`).
- Produces: `albumJob.albumId` (slskd) and `AcquireJob.albumId`/`.albumArtist`/`.albumTitle` (URL).

- [ ] **Step 1: Write failing tests** — an enriched slskd folder with an active `album_jobs` row includes `albumJob.albumId === albumIdFor(artist, album)`; an acquire job with a `storage_path` of `.../Artist/Album` includes `albumId === albumIdFor('Artist','Album')`.

```ts
// downloads.test.ts (sketch — adapt to the suite's harness)
it('enrichWithAlbumJobs attaches a resolved albumId', () => {
  // seed album_jobs (directory, artist_name, album_title, canonical_tracks_json, state=active)
  // call the handler / enrichWithAlbumJobs, assert response[i].albumJob.albumId === albumIdFor(artist, album)
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/api && bun run vitest run src/routes/downloads.test.ts -t albumId`
Expected: FAIL — `albumId` undefined.

- [ ] **Step 3: Implement**

In `downloads.ts` `enrichWithAlbumJobs`, extend the meta object:

```ts
import { albumIdFor } from '../services/library-scanner.js'; // confirm export location
// ...
      const meta = {
        artistName: r.artist_name,
        albumTitle: r.album_title,
        canonicalTrackCount: trackCount,
        albumId: albumIdFor(r.artist_name, r.album_title),
      };
```

Update the `AlbumJobMeta` type in `@nicotind/core` to add `albumId: string` (and re-export in the web shim per Global Constraints).

In the acquire job read model (`mapRow`), derive from `storage_path`:

```ts
      const segs = (row.storage_path ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
      const albumTitle = segs.at(-1);
      const albumArtist = segs.at(-2);
      const albumId = albumArtist && albumTitle ? albumIdFor(albumArtist, albumTitle) : undefined;
      // include albumId, albumArtist, albumTitle on the returned AcquireJob
```

Add those optional fields to the `AcquireJob` type in `@nicotind/core` + web shim.

- [ ] **Step 4: Run tests**

Run: `cd packages/api && bun run vitest run src/routes/downloads.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/downloads.ts packages/api/src/routes/acquire.ts packages/core/src/**  packages/web/src/types/core.ts
git commit -m "feat(downloads): resolve destination albumId on slskd + acquire download rows"
```

---

## Task 6: Web — destination wrapper + deep link

**Files:**
- Create: `packages/web/src/app/lib/download-destination.ts` + `download-destination.spec.ts`
- Modify: `packages/web/src/app/lib/download-groups.ts`
- Modify: `packages/web/src/app/components/download-item/download-item.component.ts` (+ template)
- Test: extend the download-item spec if present.

**Interfaces:**
- Consumes: `DownloadItem` (+ new `albumId`).
- Produces: `function albumLinkFor(item: DownloadItem): string[] | null` (Angular routerLink array or null).

- [ ] **Step 1: Write the failing spec**

```ts
// download-destination.spec.ts
import { describe, it, expect } from 'vitest';
import { albumLinkFor } from './download-destination';
import type { DownloadItem } from './download-groups';

const base = (over: Partial<DownloadItem>): DownloadItem =>
  ({ key: 'k', kind: 'slskd', title: 'Album', method: 'slskd', stage: 'done',
     canRetry: false, canCancel: false, canRemove: true, ...over } as DownloadItem);

describe('albumLinkFor', () => {
  it('links to the album page when done and albumId is known', () => {
    expect(albumLinkFor(base({ albumId: 'abc123' }))).toEqual(['/library/albums', 'abc123']);
  });
  it('returns null when albumId is missing', () => {
    expect(albumLinkFor(base({ albumId: undefined }))).toBeNull();
  });
  it('returns null while still in flight', () => {
    expect(albumLinkFor(base({ albumId: 'abc123', stage: 'downloading' }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/web && nvm use 22.22.3 && npx vitest run src/app/lib/download-destination.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement helper**

```ts
// download-destination.ts
import type { DownloadItem } from './download-groups';

/** RouterLink to the destination album once it's in the library, else null. */
export function albumLinkFor(item: DownloadItem): string[] | null {
  if (item.stage !== 'done' || !item.albumId) return null;
  return ['/library/albums', item.albumId];
}
```

Add `albumId?: string;` to `DownloadItem` in `download-groups.ts`, and populate it in `groupToDownloadItem` (from `group.albumJob?.albumId`) and `acquireJobToDownloadItem` (from `job.albumId`).

- [ ] **Step 4: Implement the card**

In `download-item.component.ts`: import `albumLinkFor`, expose a computed/getter `albumLink = albumLinkFor(this.item())`. In the template:
- Destination wrapper (always, when title/subtitle known): `<span data-testid="download-item-destination">{{ item().subtitle }} — {{ item().title }}</span>`.
- Done action: when `albumLink` is non-null, render `<a [routerLink]="albumLink" data-testid="download-item-open-album">Open in Library</a>`; else keep the existing generic control. Ensure `RouterLink` is imported in the standalone component.

- [ ] **Step 5: Run tests + build**

Run: `cd packages/web && npx vitest run src/app/lib/download-destination.spec.ts && npx ng build`
Expected: PASS + clean build (Node 22.22.3).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/app/lib/download-destination.ts packages/web/src/app/lib/download-destination.spec.ts packages/web/src/app/lib/download-groups.ts packages/web/src/app/components/download-item/
git commit -m "feat(web): download card shows destination album + deep link to library"
```

---

## Task 7: Docs + CI verification (Quality Gates 2 & 3)

**Files:** `docs/download-pipeline.md`, `docs/album-hunt.md`, `docs/web-ui.md`, `CLAUDE.md`, `.github/workflows/ci.yml` (verify only).

- [ ] **Step 1: `docs/download-pipeline.md`** — in "Duplicate prevention (three layers)", add a **layer 4: reconciliation at the download→library seam** — the organizer's tag/title-aware `reconcileAlbumFolder` (stronger than filename `dupKey`) + the scanner's album-scoped orphan prune; correct any wording implying duplicates only resolve on a full scan.

- [ ] **Step 2: `docs/album-hunt.md`** — under "Deferred: unify the hunt engines", note that the transient post-hunt duplicate is now closed at ingest; the remaining item is only cross-*folder* divergent-`albumId` editions.

- [ ] **Step 3: `docs/web-ui.md`** — document the download-card destination wrapper + "Open in Library" deep link and the `data-testid`s.

- [ ] **Step 4: `CLAUDE.md`** — update the "Duplicate prevention" index line to mention seam-time reconciliation; update the download-feed line to mention the destination album link. One line each, pointing at the docs.

- [ ] **Step 5: Verify CI runs the new tests.** Confirm `ci.yml`'s api job runs `vitest` over `packages/api/src/**/*.test.ts` (the new `album-reconcile.test.ts`, `library-scanner.reconcile.test.ts`, `reconcile-integration.test.ts` match the existing glob) and the web job runs `ng test`/`vitest` over `*.spec.ts`. If any new file sits outside the picked-up glob, adjust the config.

Run: `git grep -n "vitest\|ng test\|test" .github/workflows/ci.yml`
Expected: confirm globs cover the new files.

- [ ] **Step 6: Full gate run**

Run (repo root): `bun run typecheck && bun run lint && cd packages/api && bun run vitest run`
Then web: `cd packages/web && nvm use 22.22.3 && npx vitest run && npx ng build`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add docs/download-pipeline.md docs/album-hunt.md docs/web-ui.md CLAUDE.md
git commit -m "docs: document seam-time dedupe reconciliation + download destination link"
```

---

## Self-Review (against the spec)

**Spec coverage:**
- Stage 1 (clean disk / tag-aware dedupe) → Tasks 1–2. ✓
- Stage 2 (album-scoped rescan + prune) → Task 3. ✓
- Both ingest paths share the seam → Task 4 (download + acquire watchers). ✓
- Singles guard, never-delete-last-copy, foreign-drop-only-with-canonical, multi-album batch → Task 1 tests + `reconcileTouched` loops over all dirs. ✓
- Card wrapper + server albumId + deep link → Tasks 5–6. ✓
- Two-wave regression test → Task 4. ✓
- Docs + CI → Task 7. ✓
- Out-of-scope cross-folder divergent-id case → documented in Task 2 spec note + Task 7 Step 2. ✓

**Placeholder scan:** No "TBD"/"handle edge cases" — each code step has concrete code. The `> Note:` callouts ask the implementer to confirm exact existing signatures (constructor args, migration export, `albumIdFor` path, fixture helper) rather than guessing; these are verification prompts, not deferred work.

**Type consistency:** `deletedRelPaths`/`affectedAlbumDirs` (Task 2) consumed verbatim in Task 4; `reconcileAlbums(albumDirs: string[])` (Task 3) called with those in Task 4; `albumId` added to `AlbumJobMeta`/`AcquireJob`/`DownloadItem` (Task 5) consumed by `albumLinkFor` (Task 6). `chooseFolderKeepers`/`reconcileAlbumFolder`/`readFolderTracks` names consistent across Tasks 1–2.
