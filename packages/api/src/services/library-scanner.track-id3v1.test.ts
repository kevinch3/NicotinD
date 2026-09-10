/**
 * Issue #1077: `fix_song_metadata({track})` wrote TRCK and the row never took it,
 * because music-metadata lets a stale ID3v1 track (parsed last) override ID3v2.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { LibraryScanner } from './library-scanner.js';
import { writeAudioTags } from './audio-tags.js';
import { trackNoFromParse } from './music-metadata-loader.js';
import { ffmpegAvailable } from './transcode.js';

describe('trackNoFromParse (pure)', () => {
  it('prefers ID3v2 TRCK over an ID3v1 track that music-metadata let win', () => {
    const meta = {
      common: { track: { no: 63 } },
      native: {
        'ID3v2.3': [{ id: 'TRCK', value: '1/14' }],
        ID3v1: [{ id: 'track', value: 63 }],
      },
    };
    expect(trackNoFromParse(meta)).toBe(1);
  });

  it('uses common.track when there is no ID3v1 tag', () => {
    expect(trackNoFromParse({ common: { track: { no: 7 } }, native: { vorbis: [] } })).toBe(7);
  });

  it('falls back to the ID3v1 value when no higher-priority frame carries one', () => {
    const meta = { common: { track: { no: 5 } }, native: { ID3v1: [{ id: 'track', value: 5 }] } };
    expect(trackNoFromParse(meta)).toBe(5);
  });

  it('is undefined for an unparsed file', () => {
    expect(trackNoFromParse(undefined)).toBeUndefined();
  });
});

describe('scan_cache_version 4', () => {
  it('flushes a v3 cache once, so ID3v1-clobbered track numbers are re-read', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO scan_cache (path, size, mtime_ms, track_json) VALUES ('a.mp3', 1, 1, '{}')`,
    );
    db.run(`UPDATE library_sync_state SET value = '3' WHERE key = 'scan_cache_version'`);
    applySchema(db);
    expect(db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM scan_cache`).get()!.c).toBe(0);
    db.close();
  });
});

describe.if(ffmpegAvailable())('a track retag on an mp3 with an ID3v1 trailer', () => {
  let musicDir: string;
  let db: Database;
  beforeEach(() => {
    musicDir = mkdtempSync(join(tmpdir(), 'nicotind-1077-'));
    db = new Database(':memory:');
    applySchema(db);
  });
  afterEach(() => {
    db.close();
    rmSync(musicDir, { recursive: true, force: true });
  });

  it('reaches library_songs.track on rescan', async () => {
    mkdirSync(join(musicDir, 'The Beatles', 'With the Beatles'), { recursive: true });
    const rel = "The Beatles/With the Beatles/01 - It Won't Be Long.mp3";
    const abs = join(musicDir, rel);
    const gen = spawnSync('ffmpeg', [
      '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1',
      '-metadata', "title=It Won't Be Long", '-metadata', 'artist=The Beatles',
      '-metadata', 'album=With the Beatles', '-metadata', 'track=63',
      '-id3v2_version', '4', '-write_id3v1', '1', abs,
    ]); // prettier-ignore
    expect(gen.status).toBe(0);

    const scanner = new LibraryScanner(musicDir, db);
    await scanner.scanFull();
    const trackOf = () =>
      db
        .query<{ track: number | null }, [string]>('SELECT track FROM library_songs WHERE path = ?')
        .get(rel)?.track;
    expect(trackOf()).toBe(63);

    expect(await writeAudioTags(abs, { trackNumber: 1 })).toBe(true);
    await scanner.scanPaths([rel]);
    expect(trackOf()).toBe(1);
  });
});
