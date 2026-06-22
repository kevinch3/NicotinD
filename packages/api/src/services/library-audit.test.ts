import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  auditLibrary,
  summarize,
  checkMisSplitAlbums,
  selectPollutionTargets,
} from './library-audit.js';

function addArtist(db: Database, id: string, name: string, albumCount = 0): void {
  db.run(
    `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, ?, 1)`,
    [id, name, albumCount],
  );
}

function addAlbum(
  db: Database,
  o: {
    id: string;
    name: string;
    artist: string;
    artistId: string;
    songCount?: number;
    classification?: string;
    hidden?: number;
    year?: number | null;
    cover?: string | null;
  },
): void {
  db.run(
    `INSERT INTO library_albums
      (id, name, artist, artist_id, song_count, classification, hidden, year, cover_art, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      o.id,
      o.name,
      o.artist,
      o.artistId,
      o.songCount ?? 1,
      o.classification ?? 'single',
      o.hidden ?? 0,
      ('year' in o ? o.year : 2000) ?? null,
      ('cover' in o ? o.cover : 'x') ?? null,
    ],
  );
}

function addSong(db: Database, id: string, albumId: string, artistId: string): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at)
     VALUES (?, ?, 't', 'a', ?, ?, 1)`,
    [id, albumId, artistId, `/m/${id}.opus`],
  );
}

/** A clean, finding-free library: one real artist, one real album, matching counts. */
function seedClean(db: Database): void {
  addArtist(db, 'ar1', 'Soda Stereo', 1);
  addAlbum(db, {
    id: 'al1',
    name: 'Dynamo',
    artist: 'Soda Stereo',
    artistId: 'ar1',
    songCount: 2,
    classification: 'album',
    year: 1992,
  });
  addSong(db, 's1', 'al1', 'ar1');
  addSong(db, 's2', 'al1', 'ar1');
  // Mirror library_artwork so render checks pass.
  db.run(`INSERT INTO library_artwork (id, kind, cover_url, updated_at) VALUES ('al1','album','u',1)`);
}

describe('auditLibrary', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('reports no findings on a clean library', () => {
    seedClean(db);
    const report = auditLibrary(db);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.totals).toMatchObject({ artists: 1, albums: 1, songs: 2, visibleSingles: 0 });
  });

  it('flags a watermark artist (ftpdjemilio.com)', () => {
    addArtist(db, 'arw', 'ftpdjemilio.com', 1);
    addAlbum(db, { id: 'alw', name: 'Some Track', artist: 'ftpdjemilio.com', artistId: 'arw' });
    addSong(db, 'sw', 'alw', 'arw');
    const rules = auditLibrary(db).findings.map((f) => f.rule);
    expect(rules).toContain('watermark_artist');
    expect(auditLibrary(db).ok).toBe(false);
  });

  it('flags a numeric artist (101) without flagging the real album title', () => {
    addArtist(db, 'arn', '101', 1);
    addAlbum(db, { id: 'aln', name: '1989', artist: '101', artistId: 'arn', songCount: 10, classification: 'album' });
    for (let i = 0; i < 10; i++) addSong(db, `sn${i}`, 'aln', 'arn');
    const rules = auditLibrary(db).findings.map((f) => f.rule);
    expect(rules).toContain('numeric_artist');
    // "1989" is a multi-track album title — must NOT be flagged as a numeric single.
    expect(rules).not.toContain('numeric_single');
  });

  it('flags a track-number-titled one-track single', () => {
    addArtist(db, 'ar1', 'Real Band', 1);
    addAlbum(db, { id: 'aln', name: '07', artist: 'Real Band', artistId: 'ar1', songCount: 1 });
    addSong(db, 's1', 'aln', 'ar1');
    expect(auditLibrary(db).findings.map((f) => f.rule)).toContain('numeric_single');
  });

  it('detects a mis-split album (>=3 singles sharing a title)', () => {
    addArtist(db, 'a', 'x', 3);
    for (let i = 0; i < 4; i++) {
      addArtist(db, `mart${i}`, `${100 + i}`, 1);
      addAlbum(db, {
        id: `mal${i}`,
        name: 'María de Buenos Aires',
        artist: `${100 + i}`,
        artistId: `mart${i}`,
        songCount: 1,
        classification: 'single',
      });
      addSong(db, `ms${i}`, `mal${i}`, `mart${i}`);
    }
    const missplit = checkMisSplitAlbums(db);
    expect(missplit).toHaveLength(1);
    expect(missplit[0]!.message).toContain('4 one-track singles');
  });

  it('flags integrity drift: album_count + song_count mismatch', () => {
    addArtist(db, 'ar1', 'Soda Stereo', 5); // claims 5 albums, has 1
    addAlbum(db, { id: 'al1', name: 'Dynamo', artist: 'Soda Stereo', artistId: 'ar1', songCount: 9, classification: 'album' });
    addSong(db, 's1', 'al1', 'ar1'); // only 1 song, claims 9
    const rules = auditLibrary(db).findings.map((f) => f.rule);
    expect(rules).toContain('album_count_mismatch');
    expect(rules).toContain('album_song_count_mismatch');
  });

  it('flags render gaps: missing year, missing artwork', () => {
    addArtist(db, 'ar1', 'Soda Stereo', 1);
    addAlbum(db, {
      id: 'al1',
      name: 'Dynamo',
      artist: 'Soda Stereo',
      artistId: 'ar1',
      songCount: 1,
      classification: 'album',
      year: null,
      cover: null,
    });
    addSong(db, 's1', 'al1', 'ar1');
    const rules = auditLibrary(db).findings.map((f) => f.rule);
    expect(rules).toContain('missing_year');
    expect(rules).toContain('missing_artwork');
  });

  it('flags an orphan artist with no releases', () => {
    addArtist(db, 'orphan', 'Ghost', 0);
    expect(auditLibrary(db).findings.map((f) => f.rule)).toContain('orphan_artist');
  });

  it('selectPollutionTargets expands a watermark artist to all its albums', () => {
    addArtist(db, 'arw', 'ftpdjemilio.com', 2);
    addAlbum(db, { id: 'w1', name: 'Track A', artist: 'ftpdjemilio.com', artistId: 'arw' });
    addAlbum(db, { id: 'w2', name: 'Track B', artist: 'ftpdjemilio.com', artistId: 'arw' });
    addSong(db, 's1', 'w1', 'arw');
    addSong(db, 's2', 'w2', 'arw');
    const { targets } = selectPollutionTargets(db, ['watermark_artist']);
    expect(targets.map((t) => t.albumId).sort()).toEqual(['w1', 'w2']);
  });

  it('PROTECTS a real-named mis-split from deletion even when members trip a delete rule', () => {
    // A real album fragmented into placeholder-artist singles sharing a real title.
    for (let i = 0; i < 3; i++) {
      addArtist(db, `n${i}`, '<Desconocido>', 1);
      addAlbum(db, {
        id: `m${i}`,
        name: 'María de Buenos Aires',
        artist: '<Desconocido>',
        artistId: `n${i}`,
        songCount: 1,
        classification: 'single',
      });
      addSong(db, `ms${i}`, `m${i}`, `n${i}`);
    }
    // Members trip placeholder_single, but the cluster has a real title → protected.
    const { targets, protectedMisSplit } = selectPollutionTargets(db, ['placeholder_single']);
    expect(targets).toEqual([]);
    expect(protectedMisSplit).toBeGreaterThan(0);
  });

  it('does NOT protect a watermark-named mis-split (stays deletable)', () => {
    for (let i = 0; i < 3; i++) {
      addArtist(db, `w${i}`, `Artist ${i}`, 1);
      addAlbum(db, {
        id: `wm${i}`,
        name: 'MUSICAUNO.COM',
        artist: `Artist ${i}`,
        artistId: `w${i}`,
        songCount: 1,
        classification: 'single',
      });
      addSong(db, `ws${i}`, `wm${i}`, `w${i}`);
    }
    const { targets } = selectPollutionTargets(db, ['watermark_album']);
    expect(targets.map((t) => t.albumId).sort()).toEqual(['wm0', 'wm1', 'wm2']);
  });

  it('summarize ranks high severity first and sets ok=false on any high finding', () => {
    const report = summarize(db, [
      { rule: 'missing_year', severity: 'low', subject: 'x', message: '' },
      { rule: 'watermark_artist', severity: 'high', subject: 'y', message: '' },
    ]);
    expect(report.summary[0]!.rule).toBe('watermark_artist');
    expect(report.ok).toBe(false);
    expect(report.highSeverityCount).toBe(1);
  });
});
