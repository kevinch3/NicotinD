import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { partitionByCache, loadScanCache, saveScanCache, type FileStat } from './scan-cache.js';
import type { ScannedTrack } from './library-scanner.js';

function track(p: Partial<ScannedTrack> & { relPath: string }): ScannedTrack {
  return {
    size: 1000,
    mtimeMs: 111,
    suffix: 'mp3',
    contentType: 'audio/mpeg',
    duration: 200,
    bitRate: 320,
    ...p,
  };
}

function stat(relPath: string, size: number, mtimeMs: number): FileStat {
  return { abs: '/music/' + relPath, relPath, size, mtimeMs };
}

describe('partitionByCache (pure)', () => {
  it('treats an unchanged file (matching size + mtime) as a hit — no re-parse', () => {
    const cached = track({ relPath: 'a.mp3', size: 1000, mtimeMs: 111, title: 'A' });
    const cache = new Map([['a.mp3', { size: 1000, mtimeMs: 111, track: cached }]]);

    const { hits, misses } = partitionByCache([stat('a.mp3', 1000, 111)], cache);

    expect(misses).toHaveLength(0);
    expect(hits).toEqual([cached]);
  });

  it('treats a changed mtime as a miss (must re-parse)', () => {
    const cache = new Map([
      ['a.mp3', { size: 1000, mtimeMs: 111, track: track({ relPath: 'a.mp3' }) }],
    ]);
    const { hits, misses } = partitionByCache([stat('a.mp3', 1000, 222)], cache);
    expect(hits).toHaveLength(0);
    expect(misses.map((m) => m.relPath)).toEqual(['a.mp3']);
  });

  it('treats a changed size as a miss even if mtime matches', () => {
    const cache = new Map([
      ['a.mp3', { size: 1000, mtimeMs: 111, track: track({ relPath: 'a.mp3' }) }],
    ]);
    const { misses } = partitionByCache([stat('a.mp3', 2000, 111)], cache);
    expect(misses.map((m) => m.relPath)).toEqual(['a.mp3']);
  });

  it('treats an unseen file as a miss', () => {
    const { hits, misses } = partitionByCache([stat('new.mp3', 500, 1)], new Map());
    expect(hits).toHaveLength(0);
    expect(misses.map((m) => m.relPath)).toEqual(['new.mp3']);
  });
});

describe('scan cache persistence', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('round-trips raw ScannedTrack rows so a second scan skips all unchanged files', () => {
    const t1 = track({ relPath: 'x/1.mp3', size: 10, mtimeMs: 5, title: 'One', album: 'Alb' });
    const t2 = track({ relPath: 'x/2.flac', size: 20, mtimeMs: 6, title: 'Two', suffix: 'flac' });
    saveScanCache(db, [t1, t2]);

    const cache = loadScanCache(db);
    const files = [stat('x/1.mp3', 10, 5), stat('x/2.flac', 20, 6)];
    const { hits, misses } = partitionByCache(files, cache);

    expect(misses).toHaveLength(0);
    expect(hits).toHaveLength(2);
    expect(hits.find((h) => h.relPath === 'x/1.mp3')?.title).toBe('One');
  });

  it('upserts on re-save so a re-tagged file replaces its cached tags', () => {
    saveScanCache(db, [track({ relPath: 'a.mp3', size: 1, mtimeMs: 1, title: 'Old' })]);
    saveScanCache(db, [track({ relPath: 'a.mp3', size: 1, mtimeMs: 2, title: 'New' })]);

    const cache = loadScanCache(db);
    expect(cache.size).toBe(1);
    expect(cache.get('a.mp3')?.track.title).toBe('New');
    expect(cache.get('a.mp3')?.mtimeMs).toBe(2);
  });
});
