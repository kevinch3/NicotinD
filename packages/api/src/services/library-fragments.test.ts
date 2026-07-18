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

  it('groups rows by normalized title across distinct artist spellings', () => {
    // The C. Tangana / Ídolo case — three "same release" rows under different
    // spellings of the album artist.
    addArtist(db, 'a1', 'C. Tangana');
    addArtist(db, 'a2', 'C. Tangana, Nathy Peluso');
    addArtist(db, 'a3', 'C.Tangana');
    addAlbum(db, {
      id: 'al1',
      name: 'Ídolo',
      artist: 'C. Tangana',
      artistId: 'a1',
      songCount: 4,
    });
    addAlbum(db, {
      id: 'al2',
      name: 'Idolo',
      artist: 'C. Tangana, Nathy Peluso',
      artistId: 'a2',
      songCount: 5,
    });
    addAlbum(db, {
      id: 'al3',
      name: 'idolo',
      artist: 'C.Tangana',
      artistId: 'a3',
      songCount: 3,
    });

    const clusters = detectDuplicateAlbums(db);
    expect(clusters).toHaveLength(1);
    const c = clusters[0]!;
    expect(c.normalizedTitle).toBe('idolo');
    // Display name is the first "Ídolo"-length member (all members are length 5
    // so the first to enter the reduce wins; "Ídolo" is the strict-Latin form
    // that the .reduce initialized with).
    expect(c.displayTitle).toBe('Ídolo');
    expect(c.memberIds.sort()).toEqual(['al1', 'al2', 'al3']);
    expect(c.totalSongs).toBe(12);
    // Spellings sorted by occurrences desc; here all equal so alpha-asc.
    expect(c.artistSpellings.map((s) => s.name)).toEqual([
      'C. Tangana',
      'C. Tangana, Nathy Peluso',
      'C.Tangana',
    ]);
  });

  it('does NOT flag two rows with the same artist under the same album id', () => {
    // Two multi-track rows under the same artist spelling = same artist spelling
    // means `artistCounts.size < 2` and the cluster is suppressed (handle that
    // case via `repair-album-folders`, not via this report).
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

  it('does NOT cluster a single spelling across two genuinely distinct titles', () => {
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
      name: 'Dynamo',
      artist: 'Soda Stereo',
      artistId: 'a1',
      songCount: 3,
    });
    expect(detectDuplicateAlbums(db)).toHaveLength(0);
  });

  it('sorts clusters largest first', () => {
    addArtist(db, 'a1', 'X');
    addArtist(db, 'a2', 'Y');
    addArtist(db, 'a3', 'Z');
    addArtist(db, 'a4', 'W');
    // Cluster A: 4 members
    for (let i = 0; i < 4; i++) {
      addArtist(db, `a${i + 5}`, `Artist ${i + 5}`);
      addAlbum(db, {
        id: `aa${i}`,
        name: 'Same Title',
        artist: `Artist ${i + 5}`,
        artistId: `a${i + 5}`,
        songCount: 2,
      });
    }
    // Cluster B: 2 members
    addArtist(db, 'b1', 'Artist B1');
    addArtist(db, 'b2', 'Artist B2');
    addAlbum(db, {
      id: 'bb1',
      name: 'Another',
      artist: 'Artist B1',
      artistId: 'b1',
      songCount: 9,
    });
    addAlbum(db, {
      id: 'bb2',
      name: 'Another',
      artist: 'Artist B2',
      artistId: 'b2',
      songCount: 8,
    });
    const clusters = detectDuplicateAlbums(db);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.memberIds).toHaveLength(4); // Same Title leads
    expect(clusters[1]!.memberIds).toHaveLength(2);
  });

  it('collapses punctuation-variant titles', () => {
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

  it('reports a non-album classification', () => {
    addArtist(db, 'a1', 'X');
    addAlbum(db, {
      id: 'al1',
      name: 'EP',
      artist: 'X',
      artistId: 'a1',
      classification: 'ep',
    });
    addAlbum(db, {
      id: 'al2',
      name: 'Single',
      artist: 'X',
      artistId: 'a1',
      classification: 'single',
    });
    addAlbum(db, {
      id: 'al3',
      name: 'Album',
      artist: 'X',
      artistId: 'a1',
      classification: 'album',
    });
    const findings = detectHiddenByClassification(db);
    expect(findings.map((f) => f.albumId).sort()).toEqual(['al1', 'al2']);
    expect(findings.every((f) => f.reason === 'classification')).toBe(true);
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
    // 1) duplicate: two artist spellings under one normalized title
    addArtist(db, 'a1', 'C. Tangana');
    addArtist(db, 'a2', 'C.Tangana');
    addAlbum(db, {
      id: 'al1',
      name: 'Ídolo',
      artist: 'C. Tangana',
      artistId: 'a1',
      songCount: 5,
    });
    addAlbum(db, {
      id: 'al2',
      name: 'Idolo',
      artist: 'C.Tangana',
      artistId: 'a2',
      songCount: 5,
    });
    // 2) hidden-by-classification — a multi-track single that the grid hides.
    addAlbum(db, {
      id: 'al3',
      name: 'Hidden Single',
      artist: 'C. Tangana',
      artistId: 'a1',
      songCount: 2,
      classification: 'single',
    });
    // 3) mis-split — 4 one-track singles sharing a normalized title
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
    // The mis-split singles (4 rows classified 'single') share their parents'
    // hidden-by-classification status; we expect 1 (Hidden Single) + 4
    // (one-track Fragmented Album rows) = 5 total.
    expect(r.hiddenByClassification).toHaveLength(5);
    expect(r.misSplitAlbums).toHaveLength(1);
    expect(r.totals.duplicateAlbums).toBe(1);
    expect(r.totals.hiddenByClassification).toBe(5);
    expect(r.totals.misSplitAlbums).toBe(1);
  });
});
