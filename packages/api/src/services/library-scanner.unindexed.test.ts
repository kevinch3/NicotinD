import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { LibraryScanner, findSameAlbumKeepers, type ScannedTrack } from './library-scanner.js';
import { saveScanCache } from './scan-cache.js';
import { pruneOrphanRows } from './orphan-prune.js';

// The health report's `disk.wronglyOrphaned` (#1479): files on disk that the
// full scan left without a song row, excluding exact duplicates the selector
// collapsed into a same-album keeper on purpose.

let musicDir: string;
let db: Database;

beforeEach(() => {
  musicDir = mkdtempSync(join(tmpdir(), 'scan-unindexed-test-'));
  db = new Database(':memory:');
  applySchema(db);
});

afterEach(() => {
  db.close();
  rmSync(musicDir, { recursive: true, force: true });
});

/** A file on disk whose tags come from a pre-seeded scan-cache row. */
function putTagged(rel: string, tags: Partial<ScannedTrack>): void {
  const abs = join(musicDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(8));
  const st = statSync(abs);
  saveScanCache(db, [
    {
      relPath: rel,
      size: st.size,
      mtimeMs: st.mtimeMs,
      suffix: 'opus',
      contentType: 'audio/opus',
      duration: 205,
      bitRate: 205,
      ...tags,
    },
  ]);
}

function put(rel: string): void {
  const abs = join(musicDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(8));
}

function metric(): number {
  const row = db
    .query<{ value: string }, []>(
      "SELECT value FROM library_sync_state WHERE key = 'scan_cache_wrongly_orphaned'",
    )
    .get();
  return Number(row?.value);
}

function songPaths(): string[] {
  return db
    .query<{ path: string }, []>('SELECT path FROM library_songs ORDER BY path')
    .all()
    .map((r) => r.path);
}

const SOBREMESA = {
  artist: 'C. Tangana',
  albumArtist: 'C. Tangana',
  album: 'El Madrileño (La Sobremesa)',
  title: 'Yate',
  track: 17,
  disc: 1,
};

describe('scanFull unindexed-file metric', () => {
  it('does not count a same-title duplicate of one album kept from another folder', async () => {
    // Prod, 2026-09-30: one album across two folders, identical rips, quality
    // tie — the smaller relPath keeps, the other copy is dropped by design.
    putTagged('C. Tangana/El Madrileño (La Sobremesa)/17 - Yate.opus', SOBREMESA);
    putTagged('Various Artists/El Madrileño (La Sobremesa)/17 - Yate.opus', SOBREMESA);

    const scanner = new LibraryScanner(musicDir, db);
    await scanner.scanFull();

    expect(songPaths()).toEqual(['C. Tangana/El Madrileño (La Sobremesa)/17 - Yate.opus']);
    expect(metric()).toBe(0);

    // The nightly prune stamps the dropped copy's cache row; the next scan
    // must read the same level, not the stamp.
    pruneOrphanRows(db);
    await scanner.scanFull();
    expect(metric()).toBe(0);
  });

  it('counts a file dropped by a fuzzy canonical binding, on every scan', async () => {
    // Two different recordings bound to one canonical entry (#1034's residual
    // limit): the loser is a real loss, not a duplicate.
    put('Artist/Album/01 Real Song.mp3');
    put('Artist/Album/02 Real Song (Live).mp3');
    db.run(
      `INSERT INTO acquisition_jobs (id, kind, method, state, stage, artist_name, album_title, canonical_tracks_json, created_at, updated_at)
       VALUES ('acq1', 'track-search', 'slskd', 'done', 'done', 'Unknown Artist', 'Album', ?, 1, 1)`,
      [JSON.stringify(['Real Song'])],
    );

    const scanner = new LibraryScanner(musicDir, db);
    await scanner.scanFull();
    expect(songPaths()).toHaveLength(1);
    expect(metric()).toBe(1);

    // Stable across repeated scans, whether or not a prune ran in between —
    // the old stamp-based count read 1, then 0 on the same state.
    await scanner.scanFull();
    expect(metric()).toBe(1);
    pruneOrphanRows(db);
    await scanner.scanFull();
    expect(metric()).toBe(1);
  });
});

describe('findSameAlbumKeepers', () => {
  it('maps a dropped copy to the indexed keeper of its album in another folder', async () => {
    putTagged('C. Tangana/El Madrileño (La Sobremesa)/17 - Yate.opus', SOBREMESA);
    putTagged('Various Artists/El Madrileño (La Sobremesa)/17 - Yate.opus', SOBREMESA);
    await new LibraryScanner(musicDir, db).scanFull();

    const keepers = findSameAlbumKeepers(db, [
      'Various Artists/El Madrileño (La Sobremesa)/17 - Yate.opus',
    ]);
    expect([...keepers]).toEqual([
      [
        'Various Artists/El Madrileño (La Sobremesa)/17 - Yate.opus',
        'C. Tangana/El Madrileño (La Sobremesa)/17 - Yate.opus',
      ],
    ]);
  });

  it('does not map a file whose title differs from every indexed track of its album', async () => {
    putTagged('Artist/Album/01 - Song.opus', {
      albumArtist: 'Artist',
      album: 'Album',
      title: 'Song',
      track: 1,
    });
    putTagged('Other/Album/02 - Song (Live).opus', {
      albumArtist: 'Artist',
      album: 'Album',
      title: 'Song (Live)',
      track: 2,
    });
    await new LibraryScanner(musicDir, db).scanFull();
    // Force the second out of the index to model a lost row.
    db.run("DELETE FROM library_songs WHERE path = 'Other/Album/02 - Song (Live).opus'");

    expect(findSameAlbumKeepers(db, ['Other/Album/02 - Song (Live).opus']).size).toBe(0);
  });
});
