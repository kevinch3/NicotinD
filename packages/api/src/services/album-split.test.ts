import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { LibraryScanner, albumIdFor, songId } from './library-scanner.js';
import { splitAlbum, validateSplit } from './album-split.js';
import { carrySongCuration } from './song-curation-carry.js';
import { getReleaseType } from './release-meta-store.js';

// Real scanner over 8-byte placeholder files: no readable tags, so identity comes
// from the path (`NN - Artist - Title`, album = folder), as for a bare rip.
let musicDir: string;
let db: Database;
let scanner: LibraryScanner;

const ARTIST = 'Grover Washington Jr';
const COMBINED = 'Winelight - The Best Is Yet to Come';
const WINELIGHT = ['Winelight', 'Let It Flow', 'In the Name of Love'];
const BEST = ['The Best Is Yet to Come', 'Brivio', 'Can You Dig It'];

function rel(n: number, title: string): string {
  return `${ARTIST}/${COMBINED}/${String(n).padStart(2, '0')} - ${ARTIST} - ${title}.mp3`;
}

beforeEach(async () => {
  musicDir = mkdtempSync(join(tmpdir(), 'album-split-'));
  db = new Database(':memory:');
  applySchema(db);
  [...WINELIGHT, ...BEST].forEach((title, i) => {
    const abs = join(musicDir, rel(i + 1, title));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.alloc(8));
  });
  scanner = new LibraryScanner(musicDir, db);
  await scanner.scanFull();
});

afterEach(() => {
  db.close();
  rmSync(musicDir, { recursive: true, force: true });
});

const combinedId = () => albumIdFor(ARTIST, COMBINED);
const idsOf = (titles: string[], offset: number) =>
  titles.map((t, i) => songId(rel(i + 1 + offset, t)));

function albumOf(id: string): string | undefined {
  return db
    .query<{ album_id: string }, [string]>('SELECT album_id FROM library_songs WHERE id = ?')
    .get(id)?.album_id;
}

function albumRow(id: string) {
  return db
    .query<{ name: string; year: number | null; song_count: number }, [string]>(
      'SELECT name, year, song_count FROM library_albums WHERE id = ?',
    )
    .get(id);
}

async function split() {
  return splitAlbum(
    db,
    { musicDir, scanIncremental: (paths) => scanner.scanPaths(paths) },
    combinedId(),
    [
      { songIds: idsOf(WINELIGHT, 0), album: 'Winelight', year: 1980, releaseType: 'album' },
      { songIds: idsOf(BEST, 3), album: 'The Best Is Yet to Come', year: 1982 },
    ],
  );
}

describe('splitAlbum (#1866)', () => {
  it('splits a two-release row into two albums with their own songs and years', async () => {
    expect(albumRow(combinedId())?.song_count).toBe(6);
    const r = await split();
    if (!r.ok) throw new Error(r.error);
    expect(r.notApplied).toEqual([]);
    expect(r.remaining).toBe(0);

    const winelight = albumIdFor(ARTIST, 'Winelight');
    const best = albumIdFor(ARTIST, 'The Best Is Yet to Come');
    expect(r.albums.map((a) => a.albumId)).toEqual([winelight, best]);
    for (const id of idsOf(WINELIGHT, 0)) expect(albumOf(id)).toBe(winelight);
    for (const id of idsOf(BEST, 3)) expect(albumOf(id)).toBe(best);
    expect(albumRow(winelight)).toMatchObject({ name: 'Winelight', year: 1980, song_count: 3 });
    expect(albumRow(best)).toMatchObject({ year: 1982, song_count: 3 });
    expect(albumRow(combinedId())).toBeNull();
    expect(getReleaseType(db, winelight)).toBe('album');
  });

  it('survives a full rescan', async () => {
    await split();
    await new LibraryScanner(musicDir, db).scanFull();
    const best = albumIdFor(ARTIST, 'The Best Is Yet to Come');
    for (const id of idsOf(BEST, 3)) expect(albumOf(id)).toBe(best);
    expect(albumRow(best)).toMatchObject({ year: 1982, song_count: 3 });
    expect(albumRow(combinedId())).toBeNull();
  });

  it('survives a re-land: the song id is re-minted and the carry moves the override', async () => {
    await split();
    const oldRel = rel(4, BEST[0]!);
    const newRel = `${ARTIST}/Relanded/04 - ${ARTIST} - ${BEST[0]}.mp3`;
    mkdirSync(dirname(join(musicDir, newRel)), { recursive: true });
    renameSync(join(musicDir, oldRel), join(musicDir, newRel));
    carrySongCuration(db, { fromId: songId(oldRel), toId: songId(newRel) });
    await new LibraryScanner(musicDir, db).scanFull();
    expect(albumOf(songId(newRel))).toBe(albumIdFor(ARTIST, 'The Best Is Yet to Come'));
  });

  it('refuses an empty group, a foreign song and a song in two groups', () => {
    const own = new Set(['a', 'b']);
    expect(validateSplit(own, [{ songIds: [], album: 'X' }])).toContain('empty album');
    expect(validateSplit(own, [{ songIds: ['z'], album: 'X' }])).toContain('not on this album');
    expect(
      validateSplit(own, [
        { songIds: ['a'], album: 'X' },
        { songIds: ['a'], album: 'Y' },
      ]),
    ).toContain('more than one group');
    expect(validateSplit(own, [{ songIds: ['a'], album: ' ' }])).toContain('no album title');
    expect(validateSplit(own, [{ songIds: ['a'], album: 'X' }])).toBeNull();
  });

  it('keeps the songs no group names on the source album', async () => {
    const r = await splitAlbum(
      db,
      { musicDir, scanIncremental: (paths) => scanner.scanPaths(paths) },
      combinedId(),
      [{ songIds: idsOf(BEST, 3), album: 'The Best Is Yet to Come', year: 1982 }],
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.remaining).toBe(3);
    expect(albumRow(combinedId())?.song_count).toBe(3);
  });
});
