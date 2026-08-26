import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { artistIdFor } from './library-scanner.js';
import { libraryHealth } from './library-health.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function addArtist(id: string, name: string, albumCount = 0): void {
  db.run(`INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, ?, 1)`, [
    id,
    name,
    albumCount,
  ]);
}

function addAlbum(o: {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  songCount?: number;
  classification?: string;
  hidden?: number;
  year?: number | null;
}): void {
  db.run(
    `INSERT INTO library_albums
      (id, name, artist, artist_id, song_count, classification, hidden, year, cover_art, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      o.id,
      o.name,
      o.artist ?? 'a',
      o.artistId ?? 'ar1',
      o.songCount ?? 1,
      o.classification ?? 'album',
      o.hidden ?? 0,
      ('year' in o ? o.year : 2000) ?? null,
      o.id, // cover_art = album id, the scanner's convention
    ],
  );
}

function addSong(o: {
  id: string;
  albumId: string;
  title?: string;
  artist?: string;
  artistId?: string;
  suffix?: string;
  bitRate?: number | null;
  track?: number | null;
  disc?: number | null;
  genre?: string | null;
  landedAt?: number | null;
}): void {
  db.run(
    `INSERT INTO library_songs
      (id, album_id, title, artist, artist_id, path, suffix, bit_rate, track, disc, genre, landed_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      o.id,
      o.albumId,
      o.title ?? 't',
      o.artist ?? 'a',
      o.artistId ?? 'ar1',
      `/m/${o.id}.${o.suffix ?? 'opus'}`,
      o.suffix ?? 'opus',
      ('bitRate' in o ? o.bitRate : 192) ?? null,
      o.track ?? null,
      o.disc ?? null,
      ('genre' in o ? o.genre : 'Rock') ?? null,
      ('landedAt' in o ? o.landedAt : 1) ?? null,
    ],
  );
}

function addCover(albumId: string): void {
  db.run(
    `INSERT INTO library_artwork (id, kind, cover_url, updated_at) VALUES (?, 'album', 'u', 1)`,
    [albumId],
  );
}

describe('libraryHealth — report shape & totals', () => {
  it('reports totals and every dimension on an empty library', () => {
    const r = libraryHealth(db);
    expect(r.totals).toEqual({ artists: 0, albums: 0, visibleAlbums: 0, songs: 0 });
    expect(r.dimensions.audit.metric).toEqual({ high: 0, medium: 0, low: 0 });
    expect(r.dimensions.fragments.metric.duplicateAlbums).toBe(0);
    expect(r.dimensions.albumCovers.metric.missing).toBe(0);
    expect(r.dimensions.artistPortraits.metric.visible).toBe(0);
    expect(r.dimensions.genres.metric.missing).toBe(0);
    expect(r.dimensions.years.metric.missing).toBe(0);
    expect(r.dimensions.classification.metric.visibleUnknown).toBe(0);
    expect(r.dimensions.formatCohesion.metric.mixedFormatAlbums).toBe(0);
    expect(r.dimensions.completeness.metric.confirmedIncomplete).toBe(0);
    expect(r.dimensions.completeness.metric.suspected).toBe(0);
    expect(r.dimensions.lyrics.metric.withLyrics).toBe(0);
    expect(r.dimensions.flags.metric.open).toBe(0);
  });
});

describe('libraryHealth — album covers', () => {
  it('counts visible albums with no canonical album-kind artwork, worst (largest) first', () => {
    addArtist('ar1', 'A', 3);
    addAlbum({ id: 'al-big', name: 'Big', songCount: 10 });
    addAlbum({ id: 'al-small', name: 'Small', songCount: 2 });
    addAlbum({ id: 'al-covered', name: 'Covered', songCount: 5 });
    addAlbum({ id: 'al-hidden', name: 'Hidden', songCount: 9, hidden: 1 });
    addCover('al-covered');
    const d = libraryHealth(db).dimensions.albumCovers;
    expect(d.metric).toEqual({ visible: 3, missing: 2 });
    expect(d.worklist.map((w) => w.albumId)).toEqual(['al-big', 'al-small']);
  });

  it('caps the worklist at the clamped sample size', () => {
    addArtist('ar1', 'A', 60);
    for (let i = 0; i < 60; i++) addAlbum({ id: `al${i}`, name: `N${i}` });
    expect(libraryHealth(db).dimensions.albumCovers.worklist).toHaveLength(10);
    expect(libraryHealth(db, { sampleSize: 2 }).dimensions.albumCovers.worklist).toHaveLength(2);
    expect(libraryHealth(db, { sampleSize: 999 }).dimensions.albumCovers.worklist).toHaveLength(50);
  });
});

describe('libraryHealth — genres, years, classification', () => {
  it('counts landed songs with an unresolved genre; quarantined songs excluded', () => {
    addArtist('ar1', 'A', 1);
    addAlbum({ id: 'al1', name: 'N', songCount: 4 });
    addSong({ id: 's-ok', albumId: 'al1', genre: 'Rock' });
    addSong({ id: 's-null', albumId: 'al1', genre: null });
    addSong({ id: 's-junk', albumId: 'al1', genre: 'Music' }); // YouTube category name = unresolved
    addSong({ id: 's-quarantined', albumId: 'al1', genre: null, landedAt: null });
    const d = libraryHealth(db).dimensions.genres;
    expect(d.metric).toEqual({ songs: 3, missing: 2 });
    expect(d.worklist.map((w) => w.songId).sort()).toEqual(['s-junk', 's-null']);
  });

  it('counts visible albums missing a usable year', () => {
    addArtist('ar1', 'A', 2);
    addAlbum({ id: 'al1', name: 'N1', year: null });
    addAlbum({ id: 'al2', name: 'N2', year: 1999 });
    const d = libraryHealth(db).dimensions.years;
    expect(d.metric).toEqual({ visibleAlbums: 2, missing: 1 });
    expect(d.worklist[0]!.albumId).toBe('al1');
  });

  it('counts visible unknown-classification albums and passes fragment reasons through', () => {
    addArtist('ar1', 'A', 2);
    addAlbum({ id: 'al1', name: 'N1', classification: 'unknown' });
    addAlbum({ id: 'al2', name: 'N2', classification: 'album' });
    const d = libraryHealth(db).dimensions.classification;
    expect(d.metric.visibleUnknown).toBe(1);
    expect(d.worklist.some((w) => w.albumId === 'al1')).toBe(true);
  });
});

describe('libraryHealth — format cohesion', () => {
  beforeEach(() => addArtist('ar1', 'A', 9));

  it('flags a visible album mixing suffixes, listing them, but not single-suffix or 1-track albums', () => {
    addAlbum({ id: 'al-mixed', name: 'Mixed', songCount: 2 });
    addSong({ id: 'm1', albumId: 'al-mixed', suffix: 'mp3' });
    addSong({ id: 'm2', albumId: 'al-mixed', suffix: 'flac' });
    addAlbum({ id: 'al-pure', name: 'Pure', songCount: 2 });
    addSong({ id: 'p1', albumId: 'al-pure', suffix: 'opus' });
    addSong({ id: 'p2', albumId: 'al-pure', suffix: 'opus' });
    addAlbum({ id: 'al-one', name: 'One', songCount: 1 });
    addSong({ id: 'o1', albumId: 'al-one', suffix: 'mp3' });
    const d = libraryHealth(db).dimensions.formatCohesion;
    expect(d.metric.mixedFormatAlbums).toBe(1);
    expect(d.worklist.mixed).toHaveLength(1);
    expect(d.worklist.mixed[0]!.albumId).toBe('al-mixed');
    expect([...d.worklist.mixed[0]!.suffixes].sort()).toEqual(['flac', 'mp3']);
  });

  it('flags an album when at least half its known-bitrate tracks sit below the per-format floor', () => {
    addAlbum({ id: 'al-low', name: 'Low', songCount: 2 });
    addSong({ id: 'l1', albumId: 'al-low', suffix: 'mp3', bitRate: 64 });
    addSong({ id: 'l2', albumId: 'al-low', suffix: 'mp3', bitRate: 96 });
    addAlbum({ id: 'al-minority', name: 'Minority', songCount: 4 });
    addSong({ id: 'n1', albumId: 'al-minority', suffix: 'mp3', bitRate: 64 });
    addSong({ id: 'n2', albumId: 'al-minority', suffix: 'mp3', bitRate: 320 });
    addSong({ id: 'n3', albumId: 'al-minority', suffix: 'mp3', bitRate: 320 });
    addSong({ id: 'n4', albumId: 'al-minority', suffix: 'mp3', bitRate: 320 });
    const d = libraryHealth(db).dimensions.formatCohesion;
    expect(d.metric.lowBitrateAlbums).toBe(1);
    expect(d.worklist.lowBitrate[0]!.albumId).toBe('al-low');
  });

  it('opus has its own 96 kbps floor and lossless is exempt', () => {
    addAlbum({ id: 'al-opus', name: 'Opus', songCount: 2 });
    addSong({ id: 'q1', albumId: 'al-opus', suffix: 'opus', bitRate: 128 });
    addSong({ id: 'q2', albumId: 'al-opus', suffix: 'opus', bitRate: 112 });
    addAlbum({ id: 'al-flac', name: 'Flac', songCount: 1 });
    addSong({ id: 'f1', albumId: 'al-flac', suffix: 'flac', bitRate: 90 });
    const d = libraryHealth(db).dimensions.formatCohesion;
    expect(d.metric.lowBitrateAlbums).toBe(0);
  });

  it('treats bit_rate 0 or NULL as unknown, never as low', () => {
    // Prod has bit_rate=0 rows from probe failures — an all-zero album is unknowable, not bad.
    addAlbum({ id: 'al-zero', name: 'Zero', songCount: 2 });
    addSong({ id: 'z1', albumId: 'al-zero', suffix: 'm4a', bitRate: 0 });
    addSong({ id: 'z2', albumId: 'al-zero', suffix: 'm4a', bitRate: null });
    const d = libraryHealth(db).dimensions.formatCohesion;
    expect(d.metric.lowBitrateAlbums).toBe(0);
  });

  it('counts remaining lossless songs (what transcode-library would act on)', () => {
    addAlbum({ id: 'al1', name: 'N', songCount: 3 });
    addSong({ id: 'a1', albumId: 'al1', suffix: 'flac' });
    addSong({ id: 'a2', albumId: 'al1', suffix: 'ape' });
    addSong({ id: 'a3', albumId: 'al1', suffix: 'mp3' });
    expect(libraryHealth(db).dimensions.formatCohesion.metric.losslessSongs).toBe(2);
  });
});

describe('libraryHealth — completeness (confirmed, from album_jobs)', () => {
  const artist = 'Queen';
  const arId = artistIdFor(artist);

  function addJob(o: {
    artist?: string;
    album: string;
    canonical: string[];
    lidarrAlbumId?: number | null;
    state?: string;
  }): void {
    db.run(
      `INSERT INTO album_jobs
        (lidarr_album_id, username, directory, canonical_tracks_json, alternates_json,
         state, created_at, artist_name, album_title)
       VALUES (?, 'u', 'd', ?, '[]', ?, 1, ?, ?)`,
      [
        o.lidarrAlbumId ?? 7,
        JSON.stringify(o.canonical),
        o.state ?? 'exhausted',
        o.artist ?? artist,
        o.album,
      ],
    );
  }

  function seedOwned(albumId: string, name: string, titles: string[]): void {
    addAlbum({ id: albumId, name, artist, artistId: arId, songCount: titles.length });
    titles.forEach((t, i) =>
      addSong({ id: `${albumId}-s${i}`, albumId, title: t, artist, artistId: arId }),
    );
  }

  beforeEach(() => {
    db.run(`INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, 1, 1)`, [
      arId,
      artist,
    ]);
  });

  it('reports a hunted album owning fewer tracks than its canonical list', () => {
    seedOwned('al-jazz', 'Jazz', ['Mustapha', 'Fat Bottomed Girls']);
    addJob({ album: 'Jazz', canonical: ['Mustapha', 'Fat Bottomed Girls', 'Jealousy'] });
    const d = libraryHealth(db).dimensions.completeness;
    expect(d.metric.confirmedIncomplete).toBe(1);
    const row = d.worklist.confirmed[0]!;
    expect(row).toMatchObject({
      artist,
      album: 'Jazz',
      expected: 3,
      owned: 2,
      missing: 1,
      lidarrAlbumId: 7,
    });
    expect(row.albumId).toBe('al-jazz');
  });

  it('skips complete albums and albums no longer in the library at all', () => {
    seedOwned('al-done', 'News of the World', ['We Will Rock You', 'We Are the Champions']);
    addJob({ album: 'News of the World', canonical: ['We Will Rock You', 'We Are the Champions'] });
    addJob({ album: 'Innuendo', canonical: ['Innuendo', 'Headlong'] }); // nothing on disk
    expect(libraryHealth(db).dimensions.completeness.metric.confirmedIncomplete).toBe(0);
  });

  it('dedupes per artist/title with the newest job winning', () => {
    seedOwned('al-hot', 'Hot Space', ['Staying Power', 'Dancer']);
    addJob({ album: 'Hot Space', canonical: ['Staying Power', 'Dancer', 'Back Chat'] });
    addJob({ album: 'Hot Space', canonical: ['Staying Power', 'Dancer'] }); // newer, complete
    expect(libraryHealth(db).dimensions.completeness.metric.confirmedIncomplete).toBe(0);
  });
});

describe('libraryHealth — completeness (suspected, track-number gaps)', () => {
  beforeEach(() => addArtist('ar1', 'A', 9));

  function albumWithTracks(
    id: string,
    tracks: Array<number | null>,
    classification = 'album',
  ): void {
    addAlbum({ id, name: id, songCount: tracks.length, classification });
    tracks.forEach((t, i) => addSong({ id: `${id}-s${i}`, albumId: id, track: t }));
  }

  it('flags a fully-numbered album with a gap', () => {
    albumWithTracks('al-gap', [1, 2, 4]);
    const d = libraryHealth(db).dimensions.completeness;
    expect(d.metric.suspected).toBe(1);
    expect(d.worklist.suspected[0]).toMatchObject({ albumId: 'al-gap', maxTrack: 4, numbered: 3 });
  });

  it('excludes albums with any NULL track number', () => {
    albumWithTracks('al-null', [1, 2, null, 4]);
    expect(libraryHealth(db).dimensions.completeness.metric.suspected).toBe(0);
  });

  it('excludes albums with duplicate track numbers (junk numbering)', () => {
    albumWithTracks('al-dup', [1, 2, 2, 5]);
    expect(libraryHealth(db).dimensions.completeness.metric.suspected).toBe(0);
  });

  it('excludes albums owning fewer than 3 numbered tracks (loose rips keep their source numbers)', () => {
    albumWithTracks('al-two', [1, 5]);
    expect(libraryHealth(db).dimensions.completeness.metric.suspected).toBe(0);
  });

  it('excludes implausible numbering above 40 (disc-track mashes)', () => {
    albumWithTracks('al-mash', [1, 2, 3, 41]);
    expect(libraryHealth(db).dimensions.completeness.metric.suspected).toBe(0);
  });

  it('excludes singles and treats discs independently', () => {
    albumWithTracks('al-single', [1, 2, 4], 'single');
    addAlbum({ id: 'al-discs', name: 'Discs', songCount: 4 });
    // Disc 1 complete (1,2); disc 2 complete (1,2) — no gap despite repeated numbers across discs.
    addSong({ id: 'd1', albumId: 'al-discs', track: 1, disc: 1 });
    addSong({ id: 'd2', albumId: 'al-discs', track: 2, disc: 1 });
    addSong({ id: 'd3', albumId: 'al-discs', track: 1, disc: 2 });
    addSong({ id: 'd4', albumId: 'al-discs', track: 2, disc: 2 });
    expect(libraryHealth(db).dimensions.completeness.metric.suspected).toBe(0);
  });
});

describe('libraryHealth — lyrics & flags', () => {
  it('reports lyrics coverage and open flags with the oldest timestamp', () => {
    addArtist('ar1', 'A', 1);
    addAlbum({ id: 'al1', name: 'N', songCount: 2 });
    addSong({ id: 's1', albumId: 'al1' });
    addSong({ id: 's2', albumId: 'al1' });
    db.run(
      `INSERT INTO library_lyrics (song_id, plain_text, source, updated_at) VALUES ('s1','x','t',1)`,
    );
    db.run(
      `INSERT INTO curation_flags (target_kind, target_id, reason, created_by, created_at)
       VALUES ('album','al1','check','tester',111)`,
    );
    const r = libraryHealth(db);
    expect(r.dimensions.lyrics.metric).toEqual({ songs: 2, withLyrics: 1 });
    expect(r.dimensions.flags.metric).toEqual({ open: 1, oldestAt: 111 });
  });
});
