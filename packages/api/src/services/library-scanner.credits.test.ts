/**
 * Issue #1083: composer and conductor had no column, so classical files filed
 * the composer in `artist` and correcting that deleted it.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { LibraryScanner } from './library-scanner.js';
import { mutateSongMetadata } from './song-metadata-mutate.js';
import { ffmpegAvailable } from './transcode.js';

describe('scan_cache_version 5', () => {
  it('flushes a v4 cache once, so existing files gain composer/conductor', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO scan_cache (path, size, mtime_ms, track_json) VALUES ('a.mp3', 1, 1, '{}')`,
    );
    db.run(`UPDATE library_sync_state SET value = '4' WHERE key = 'scan_cache_version'`);
    applySchema(db);
    expect(db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM scan_cache`).get()!.c).toBe(0);
    db.close();
  });
});

describe('scan_cache_version 6', () => {
  it('flushes a v5 cache once, so existing files gain work/movement (#1369)', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO scan_cache (path, size, mtime_ms, track_json) VALUES ('a.mp3', 1, 1, '{}')`,
    );
    db.run(`UPDATE library_sync_state SET value = '5' WHERE key = 'scan_cache_version'`);
    applySchema(db);
    expect(db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM scan_cache`).get()!.c).toBe(0);
    db.close();
  });
});

describe.if(ffmpegAvailable())('composer and conductor, scanned and retagged', () => {
  let musicDir: string;
  let db: Database;
  beforeEach(() => {
    musicDir = mkdtempSync(join(tmpdir(), 'nicotind-1083-'));
    db = new Database(':memory:');
    applySchema(db);
  });
  afterEach(() => {
    db.close();
    rmSync(musicDir, { recursive: true, force: true });
  });

  function make(rel: string, meta: string[]): void {
    mkdirSync(join(musicDir, rel, '..'), { recursive: true });
    const args = ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono'];
    const gen = spawnSync('ffmpeg', [...args, '-t', '1', ...meta, join(musicDir, rel)]);
    expect(gen.status).toBe(0);
  }

  const row = (rel: string) =>
    db
      .query<{ artist: string; composer: string | null; conductor: string | null }, [string]>(
        'SELECT artist, composer, conductor FROM library_songs WHERE path = ?',
      )
      .get(rel);

  it('reads both credits from an mp3 and a FLAC', async () => {
    const meta = [
      '-metadata', 'artist=Luciano Pavarotti', '-metadata', 'album=Turandot',
      '-metadata', 'composer=Giacomo Puccini',
    ]; // prettier-ignore
    make('Luciano Pavarotti/Turandot/01 - Nessun dorma.mp3', [
      ...meta, '-metadata', 'title=Nessun dorma', '-metadata', 'TPE3=Zubin Mehta',
    ]); // prettier-ignore
    make('Luciano Pavarotti/Turandot/02 - Non piangere, Liù.flac', [
      ...meta, '-metadata', 'title=Non piangere, Liù', '-metadata', 'CONDUCTOR=Zubin Mehta',
    ]); // prettier-ignore

    await new LibraryScanner(musicDir, db).scanFull();

    for (const file of ['01 - Nessun dorma.mp3', '02 - Non piangere, Liù.flac']) {
      expect(row(`Luciano Pavarotti/Turandot/${file}`)).toEqual({
        artist: 'Luciano Pavarotti',
        composer: 'Giacomo Puccini',
        conductor: 'Zubin Mehta',
      });
    }
  });

  it('reads work and movement from a FLAC and an mp3 (#1369)', async () => {
    const meta = [
      '-metadata', 'artist=Wiener Philharmoniker', '-metadata', 'album=Requiem',
      '-metadata', 'WORK=Requiem in D minor', '-metadata', 'MOVEMENTNAME=Lacrimosa',
      '-metadata', 'MOVEMENT=8',
    ]; // prettier-ignore
    make('Wiener/Requiem/08 - Lacrimosa.flac', [...meta, '-metadata', 'title=Lacrimosa']);
    make('Wiener/Requiem/09 - Domine Jesu.mp3', [...meta, '-metadata', 'title=Domine Jesu']);
    await new LibraryScanner(musicDir, db).scanFull();
    const rows = db
      .query<{ work: string | null; movement: string | null; movement_number: number | null }, []>(
        'SELECT work, movement, movement_number FROM library_songs ORDER BY path',
      )
      .all();
    expect(rows).toEqual([
      { work: 'Requiem in D minor', movement: 'Lacrimosa', movement_number: 8 },
      { work: 'Requiem in D minor', movement: 'Lacrimosa', movement_number: 8 },
    ]);
  });

  it('moves a composer filed as the artist into composer, losing nothing', async () => {
    // The People's Tenor shape: the composer in `artist`, the performer only
    // in album_artist. One call sets both, so the composer is moved, not lost.
    const rel = "Luciano Pavarotti/The People's Tenor/03 - Che gelida manina.mp3";
    make(rel, [
      '-metadata', 'title=Che gelida manina', '-metadata', 'artist=Giacomo Puccini',
      '-metadata', 'album_artist=Luciano Pavarotti', '-metadata', "album=The People's Tenor",
    ]); // prettier-ignore
    const scanner = new LibraryScanner(musicDir, db);
    await scanner.scanFull();
    const id = db
      .query<{ id: string }, [string]>('SELECT id FROM library_songs WHERE path = ?')
      .get(rel)!.id;

    const result = await mutateSongMetadata(
      db,
      { musicDir, scanIncremental: (paths) => scanner.scanPaths(paths).then(() => undefined) },
      id,
      { artist: 'Luciano Pavarotti', composer: 'Giacomo Puccini' },
    );

    expect(result).toMatchObject({
      ok: true,
      verified: true,
      applied: { artist: 'Luciano Pavarotti', composer: 'Giacomo Puccini' },
    });
    expect(row(rel)).toEqual({
      artist: 'Luciano Pavarotti',
      composer: 'Giacomo Puccini',
      conductor: null,
    });
  });
});
