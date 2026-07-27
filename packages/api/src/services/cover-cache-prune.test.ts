import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../db.js';
import { cacheKeyBase, isContentAddressed, pruneCoverCache } from './cover-cache-prune.js';

let db: Database;
let dir: string;
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function seedAlbum(id: string) {
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES (?, 'A', 'Ar', 'art', 1, 0, 1)`,
    [id],
  );
}
/** Write a cache file and age it by `daysOld`. */
function cacheFile(name: string, daysOld = 100, bytes = 1024) {
  const p = join(dir, name);
  writeFileSync(p, 'x'.repeat(bytes));
  const t = (NOW - daysOld * DAY) / 1000;
  utimesSync(p, t, t);
}
const remaining = () => readdirSync(dir).sort();

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  dir = mkdtempSync(join(tmpdir(), 'covercache-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('cacheKeyBase / isContentAddressed', () => {
  it('strips the size suffix and extension', () => {
    expect(cacheKeyBase('abc123@320.webp')).toBe('abc123');
    expect(cacheKeyBase('abc123.jpg')).toBe('abc123');
  });

  it('recognises both content-addressed prefixes', () => {
    // These are hashes of the source image / remote URL — there is no owning
    // row, so they can never be judged orphaned by an id lookup.
    expect(isContentAddressed('c_deadbeef')).toBe(true);
    expect(isContentAddressed('r_deadbeef')).toBe(true);
    expect(isContentAddressed('deadbeef')).toBe(false);
  });
});

describe('pruneCoverCache (#311)', () => {
  it('deletes an aged orphan and reports the bytes', () => {
    seedAlbum('live');
    cacheFile('gone@320.webp', 100, 2048);

    const r = pruneCoverCache(db, dir, { now: NOW });
    expect(r).toMatchObject({ orphaned: 1, deleted: 1, bytesReclaimed: 2048 });
    expect(remaining()).toEqual([]);
  });

  it('keeps a cover whose entity still exists', () => {
    seedAlbum('live');
    cacheFile('live@320.webp');
    cacheFile('live.jpg');

    expect(pruneCoverCache(db, dir, { now: NOW }).deleted).toBe(0);
    expect(remaining()).toEqual(['live.jpg', 'live@320.webp']);
  });

  /**
   * The whole point of the grace period: ids are deterministic, so deleting a
   * song and re-downloading the same file reuses its id — and should reuse the
   * cached cover rather than re-fetching and re-encoding it.
   */
  it('spares an orphan inside the grace window', () => {
    seedAlbum('live');
    cacheFile('recent@320.webp', 3);

    const r = pruneCoverCache(db, dir, { now: NOW, graceMs: 30 * DAY });
    expect(r).toMatchObject({ orphaned: 1, deleted: 0 });
    expect(remaining()).toEqual(['recent@320.webp']);
  });

  /**
   * The trap this function exists to avoid. A first measurement counted all
   * 9,455 content-addressed files as orphans and claimed 2.3 GB was reclaimable;
   * deleting on that basis would have thrown away live entries.
   */
  it('never touches content-addressed entries, however old', () => {
    seedAlbum('live');
    cacheFile('c_abc@320.webp', 999);
    cacheFile('r_def.jpg', 999);

    const r = pruneCoverCache(db, dir, { now: NOW });
    expect(r).toMatchObject({ contentAddressed: 2, orphaned: 0, deleted: 0 });
    expect(remaining()).toEqual(['c_abc@320.webp', 'r_def.jpg']);
  });

  it('matches artist and song ids too, not just albums', () => {
    db.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('artist1','A',1,1)`,
    );
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
       VALUES ('song1','al','T','Ar','art',0,'p.opus',1,'2024-01-01',1)`,
    );
    cacheFile('artist1.jpg');
    cacheFile('song1@80.webp');

    expect(pruneCoverCache(db, dir, { now: NOW }).deleted).toBe(0);
  });

  it('refuses to sweep an empty library rather than deleting everything', () => {
    cacheFile('anything@320.webp', 999);
    const r = pruneCoverCache(db, dir, { now: NOW });
    expect(r.abortedReason).toMatch(/no rows/i);
    expect(remaining()).toEqual(['anything@320.webp']);
  });

  it('refuses when almost everything looks orphaned (a mid-rebuild library)', () => {
    seedAlbum('live');
    // Above SANITY_MIN_SAMPLE, so the ratio is meaningful.
    for (let i = 0; i < 25; i++) cacheFile(`ghost${i}.jpg`, 999);

    const r = pruneCoverCache(db, dir, { now: NOW });
    expect(r.abortedReason).toMatch(/refusing to sweep/i);
    expect(r.deleted).toBe(0);
    expect(remaining()).toHaveLength(25);
  });

  it('still sweeps a small cache, where an orphan ratio would be noise', () => {
    // 1 of 1 orphaned is 100%, but over one file that means nothing — the valve
    // must not lock a small cache out of ever reclaiming anything.
    seedAlbum('live');
    cacheFile('gone.jpg', 100);
    expect(pruneCoverCache(db, dir, { now: NOW }).deleted).toBe(1);
  });

  it('is a no-op when the cache directory does not exist', () => {
    seedAlbum('live');
    const r = pruneCoverCache(db, join(dir, 'nope'), { now: NOW });
    expect(r).toMatchObject({ scanned: 0, deleted: 0 });
  });
});
