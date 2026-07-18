import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  checkFragments,
  detectDuplicateAlbums,
  detectHiddenByClassification,
} from './library-fragments.js';

function addArtist(db: Database, id: string, name: string): void {
  db.run(`INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, 0, 1)`, [
    id,
    name,
  ]);
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
  },
): void {
  db.run(
    `INSERT INTO library_albums
      (id, name, artist, artist_id, song_count, classification, hidden, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      o.id,
      o.name,
      o.artist,
      o.artistId,
      o.songCount ?? 1,
      o.classification ?? 'album',
      o.hidden ?? 0,
    ],
  );
}

describe('detectDuplicateAlbums', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('returns nothing for a clean library', () => {
    addArtist(db, 'a1', 'Soda Stereo');
    addAlbum(db, {
      id: 'al1',
      name: 'Canción Animal',
      artist: 'Soda Stereo',
      artistId: 'a1',
    });
    expect(detectDuplicateAlbums(db)).toEqual([]);
  });

  it('clusters same-title rows that are punctuation/spacing variants of one artist', () => {
    // The real "La K'onga" / "La Konga" prod case: same release, artist tagged
    // with a different apostrophe/spacing. Both fold to "lakonga" and mint
    // distinct rows because the scanner's artist normalizer keeps punctuation.
    addArtist(db, 'a1', "La K'onga");
    addArtist(db, 'a2', 'La Konga');
    addAlbum(db, {
      id: 'al1',
      name: 'El Mismo Aire',
      artist: "La K'onga",
      artistId: 'a1',
      songCount: 16,
    });
    addAlbum(db, {
      id: 'al2',
      name: 'El Mismo Aire',
      artist: 'La Konga',
      artistId: 'a2',
      songCount: 1,
    });

    const clusters = detectDuplicateAlbums(db);
    expect(clusters).toHaveLength(1);
    const c = clusters[0]!;
    expect(c.normalizedTitle).toBe('el mismo aire');
    expect(c.memberIds.sort()).toEqual(['al1', 'al2']);
    expect(c.totalSongs).toBe(17);
    expect(c.artistSpellings.map((s) => s.name).sort()).toEqual(["La K'onga", 'La Konga']);
  });

  it('does NOT flag identically-titled albums by genuinely different artists', () => {
    // "Off the Wall" by Michael Jackson vs Pink Floyd is two releases, not one —
    // title-only grouping wrongly flagged this; folded-artist sub-clustering must not.
    addArtist(db, 'a1', 'Michael Jackson');
    addArtist(db, 'a2', 'Pink Floyd');
    addAlbum(db, {
      id: 'al1',
      name: 'Off the Wall',
      artist: 'Michael Jackson',
      artistId: 'a1',
      songCount: 10,
    });
    addAlbum(db, {
      id: 'al2',
      name: 'Off the Wall',
      artist: 'Pink Floyd',
      artistId: 'a2',
      songCount: 2,
    });
    expect(detectDuplicateAlbums(db)).toEqual([]);
  });

  it('does NOT flag a featured-artist credit as a spelling variant', () => {
    // "C. Tangana" vs "C. Tangana, Nathy Peluso" are different credited line-ups;
    // their folds differ, so they are (correctly) not clustered as one release.
    addArtist(db, 'a1', 'C. Tangana');
    addArtist(db, 'a2', 'C. Tangana, Nathy Peluso');
    addAlbum(db, {
      id: 'al1',
      name: 'Un Veneno',
      artist: 'C. Tangana',
      artistId: 'a1',
      songCount: 3,
    });
    addAlbum(db, {
      id: 'al2',
      name: 'Un Veneno',
      artist: 'C. Tangana, Nathy Peluso',
      artistId: 'a2',
      songCount: 3,
    });
    expect(detectDuplicateAlbums(db)).toEqual([]);
  });

  it('does NOT flag a single clean row (same artist, same id)', () => {
    addArtist(db, 'a1', 'Soda Stereo');
    addAlbum(db, {
      id: 'al1',
      name: 'Canción Animal',
      artist: 'Soda Stereo',
      artistId: 'a1',
      songCount: 3,
    });
    addAlbum(db, {
      id: 'al2',
      name: 'Cancion Animal',
      artist: 'Soda Stereo',
      artistId: 'a1',
      songCount: 3,
    });
    expect(detectDuplicateAlbums(db)).toHaveLength(0);
  });

  it('sorts clusters largest first', () => {
    // Cluster A: 3 spelling variants of one folded artist ("mrgato").
    addArtist(db, 'a1', 'Mr Gato');
    addArtist(db, 'a2', 'Mr. Gato');
    addArtist(db, 'a3', 'Mr.Gato');
    for (const [id, artist, aid] of [
      ['aa0', 'Mr Gato', 'a1'],
      ['aa1', 'Mr. Gato', 'a2'],
      ['aa2', 'Mr.Gato', 'a3'],
    ] as const) {
      addAlbum(db, { id, name: 'Los Señores', artist, artistId: aid, songCount: 2 });
    }
    // Cluster B: 2 spelling variants of another folded artist ("lakonga").
    addArtist(db, 'b1', 'La Konga');
    addArtist(db, 'b2', "La K'onga");
    addAlbum(db, { id: 'bb1', name: 'Another', artist: 'La Konga', artistId: 'b1', songCount: 9 });
    addAlbum(db, { id: 'bb2', name: 'Another', artist: "La K'onga", artistId: 'b2', songCount: 8 });

    const clusters = detectDuplicateAlbums(db);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.memberIds).toHaveLength(3); // Los Señores leads (3 rows)
    expect(clusters[1]!.memberIds).toHaveLength(2);
  });

  it('collapses punctuation-variant titles under one folded artist', () => {
    addArtist(db, 'a1', 'Soda Stereo');
    addArtist(db, 'a2', 'Soda Stereo!');
    addAlbum(db, {
      id: 'al1',
      name: '¡Bang! ¡Bang! Estás liquidado',
      artist: 'Soda Stereo',
      artistId: 'a1',
      songCount: 4,
    });
    addAlbum(db, {
      id: 'al2',
      name: 'Bang! Bang!... Estás liquidado',
      artist: 'Soda Stereo!',
      artistId: 'a2',
      songCount: 3,
    });
    expect(detectDuplicateAlbums(db)).toHaveLength(1);
  });
});

describe('detectHiddenByClassification', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('reports a hidden=1 row', () => {
    addArtist(db, 'a1', 'X');
    addAlbum(db, {
      id: 'al1',
      name: 'Hidden Album',
      artist: 'X',
      artistId: 'a1',
      hidden: 1,
    });
    const findings = detectHiddenByClassification(db);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.reason).toBe('hidden');
    expect(findings[0]!.albumId).toBe('al1');
  });

  it('flags an album-sized tracklist mis-tagged as a single or EP', () => {
    addArtist(db, 'a1', 'Dua Lipa');
    // 18-track "single" — a full album the grid wrongly hides.
    addAlbum(db, {
      id: 'al1',
      name: 'Future Nostalgia',
      artist: 'Dua Lipa',
      artistId: 'a1',
      classification: 'single',
      songCount: 18,
    });
    // 16-track "ep" — likewise a full album.
    addAlbum(db, {
      id: 'al2',
      name: 'Space Oddity',
      artist: 'Dua Lipa',
      artistId: 'a1',
      classification: 'ep',
      songCount: 16,
    });
    const findings = detectHiddenByClassification(db);
    expect(findings.map((f) => f.albumId).sort()).toEqual(['al1', 'al2']);
    expect(findings.every((f) => f.reason === 'oversized')).toBe(true);
    expect(findings.find((f) => f.albumId === 'al1')!.songCount).toBe(18);
  });

  it('flags an unresolved (unknown) classification', () => {
    addArtist(db, 'a1', 'X');
    addAlbum(db, {
      id: 'al1',
      name: 'Coolio.com',
      artist: 'X',
      artistId: 'a1',
      classification: 'unknown',
      songCount: 14,
    });
    const findings = detectHiddenByClassification(db);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.reason).toBe('unknown');
  });

  it('does NOT flag legitimately-short singles, EPs, or compilations', () => {
    addArtist(db, 'a1', 'X');
    addAlbum(db, {
      id: 'al1',
      name: 'A-Side',
      artist: 'X',
      artistId: 'a1',
      classification: 'single',
      songCount: 2,
    });
    addAlbum(db, {
      id: 'al2',
      name: 'Little EP',
      artist: 'X',
      artistId: 'a1',
      classification: 'ep',
      songCount: 5,
    });
    addAlbum(db, {
      id: 'al3',
      name: 'Various Hits',
      artist: 'Various Artists',
      artistId: 'a1',
      classification: 'compilation',
      songCount: 40,
    });
    expect(detectHiddenByClassification(db)).toEqual([]);
  });

  it('excludes a clean album row', () => {
    addArtist(db, 'a1', 'X');
    addAlbum(db, {
      id: 'al1',
      name: 'Album',
      artist: 'X',
      artistId: 'a1',
      classification: 'album',
    });
    expect(detectHiddenByClassification(db)).toEqual([]);
  });
});

describe('checkFragments', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('reports ok:true on a clean library', () => {
    addArtist(db, 'a1', 'Soda Stereo');
    addAlbum(db, {
      id: 'al1',
      name: 'Canción Animal',
      artist: 'Soda Stereo',
      artistId: 'a1',
    });
    const r = checkFragments(db);
    expect(r.ok).toBe(true);
    expect(r.totals).toEqual({ duplicateAlbums: 0, hiddenByClassification: 0, misSplitAlbums: 0 });
  });

  it('aggregates all three defect classes', () => {
    // 1) duplicate: two spelling variants of one folded artist.
    addArtist(db, 'a1', 'La Konga');
    addArtist(db, 'a2', "La K'onga");
    addAlbum(db, {
      id: 'al1',
      name: 'Universo Paralelo',
      artist: 'La Konga',
      artistId: 'a1',
      songCount: 12,
    });
    addAlbum(db, {
      id: 'al2',
      name: 'Universo Paralelo',
      artist: "La K'onga",
      artistId: 'a2',
      songCount: 1,
    });
    // 2) wrongly-hidden — an album-sized tracklist mis-tagged as a single.
    addAlbum(db, {
      id: 'al3',
      name: 'Future Nostalgia',
      artist: 'Dua Lipa',
      artistId: 'a1',
      songCount: 18,
      classification: 'single',
    });
    // 3) mis-split — 4 one-track singles sharing a normalized title.
    for (let i = 0; i < 4; i++) {
      const aid = `m${i}`;
      addArtist(db, aid, `${100 + i}`);
      addAlbum(db, {
        id: `mal${i}`,
        name: 'Fragmented Album',
        artist: `${100 + i}`,
        artistId: aid,
        songCount: 1,
        classification: 'single',
      });
    }
    const r = checkFragments(db);
    expect(r.ok).toBe(false);
    expect(r.duplicateAlbums).toHaveLength(1);
    // Only the genuine oversized single is flagged — the short one-track
    // mis-split singles are NOT (that defect is owned by misSplitAlbums).
    expect(r.hiddenByClassification).toHaveLength(1);
    expect(r.hiddenByClassification[0]!.reason).toBe('oversized');
    expect(r.misSplitAlbums).toHaveLength(1);
    expect(r.totals.duplicateAlbums).toBe(1);
    expect(r.totals.hiddenByClassification).toBe(1);
    expect(r.totals.misSplitAlbums).toBe(1);
  });
});
