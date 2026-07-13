import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  buildLibrary,
  songId,
  albumIdFor,
  artistIdFor,
  isLooseSinglesBucket,
  LibraryScanner,
  type ScannedTrack,
} from './library-scanner.js';

function track(p: Partial<ScannedTrack> & { relPath: string }): ScannedTrack {
  return {
    size: 1000,
    mtimeMs: Date.parse('2026-01-01T00:00:00Z'),
    suffix: 'mp3',
    contentType: 'audio/mpeg',
    duration: 200,
    bitRate: 320,
    ...p,
  };
}

describe('buildLibrary (pure aggregation)', () => {
  it('groups tracks into albums + artists and mints stable ids', () => {
    const built = buildLibrary([
      track({
        relPath: 'Daft Punk/Discovery/01.mp3',
        artist: 'Daft Punk',
        album: 'Discovery',
        title: 'One More Time',
        track: 1,
      }),
      track({
        relPath: 'Daft Punk/Discovery/02.mp3',
        artist: 'Daft Punk',
        album: 'Discovery',
        title: 'Aerodynamic',
        track: 2,
      }),
    ]);

    expect(built.songs).toHaveLength(2);
    expect(built.albums).toHaveLength(1);
    expect(built.artists).toHaveLength(1);
    expect(built.albums[0]!.songCount).toBe(2);
    expect(built.albums[0]!.duration).toBe(400);
    expect(built.albums[0]!.id).toBe(albumIdFor('Daft Punk', 'Discovery'));
    expect(built.songs[0]!.id).toBe(songId('Daft Punk/Discovery/01.mp3'));
    expect(built.songs[0]!.albumId).toBe(built.albums[0]!.id);
    expect(built.artists[0]!.albumCount).toBe(1);
  });

  it('keys album/artist cover ids on the group id so canonical artwork resolves', () => {
    const built = buildLibrary([
      track({ relPath: 'A/Alb/01.mp3', artist: 'A', album: 'Alb', title: 'T', track: 1 }),
    ]);
    // Album cover id == album id; artist cover id == artist id (so the cover
    // route can look canonical artwork up by these ids); songs keep their own id.
    expect(built.albums[0]!.coverArt).toBe(built.albums[0]!.id);
    expect(built.artists[0]!.coverArt).toBe(built.artists[0]!.id);
    expect(built.songs[0]!.coverArt).toBe(built.songs[0]!.id);
  });

  it('applies a metadata override: re-buckets under the corrected artist/year', () => {
    const rawAlbumId = albumIdFor('<Desconocido>', 'Selva');
    const overrides = new Map([
      [rawAlbumId, { artist: 'La Portuaria', album: 'Selva', year: 1996 }],
    ]);
    const built = buildLibrary(
      [
        track({
          relPath: '<Desconocido>/Selva/01.mp3',
          artist: '<Desconocido>',
          album: 'Selva',
          title: 'T',
          year: 2009,
        }),
      ],
      undefined,
      overrides,
    );
    expect(built.artists[0]!.name).toBe('La Portuaria');
    expect(built.albums[0]!.artist).toBe('La Portuaria');
    expect(built.albums[0]!.id).toBe(albumIdFor('La Portuaria', 'Selva'));
    expect(built.albums[0]!.year).toBe(1996);
    // songId is path-derived → unchanged, so curation/playlist refs survive.
    expect(built.songs[0]!.id).toBe(songId('<Desconocido>/Selva/01.mp3'));
    expect(built.songs[0]!.artistId).toBe(built.artists[0]!.id);
  });

  it('reproduces the same corrected grouping on a simulated rescan', () => {
    const overrides = new Map([
      [albumIdFor('<Desconocido>', 'Selva'), { artist: 'La Portuaria', album: 'Selva' }],
    ]);
    const tracks = [
      track({
        relPath: '<Desconocido>/Selva/01.mp3',
        artist: '<Desconocido>',
        album: 'Selva',
        title: 'T',
      }),
    ];
    const a = buildLibrary(tracks, undefined, overrides);
    const b = buildLibrary(tracks, undefined, overrides);
    expect(b.albums[0]!.id).toBe(a.albums[0]!.id);
    expect(b.artists[0]!.id).toBe(a.artists[0]!.id);
  });

  it('collapses edition variants into one album via the group key', () => {
    const built = buildLibrary([
      track({ relPath: 'A/Album/01.mp3', artist: 'A', album: 'Circus', title: 'T1' }),
      track({
        relPath: 'A/Album (Deluxe Edition)/01.mp3',
        artist: 'A',
        album: 'Circus (Deluxe Edition)',
        title: 'T2',
      }),
    ]);
    // Both editions share a group key → one album id; display name is the shortest.
    expect(built.albums).toHaveLength(1);
    expect(built.albums[0]!.name).toBe('Circus');
    expect(built.albums[0]!.songCount).toBe(2);
  });

  it('infers album from the folder leaf when the album tag is missing', () => {
    const built = buildLibrary([
      track({
        relPath: 'Some Artist/Greatest Hits/01.mp3',
        artist: 'Some Artist',
        title: 'Hit',
        album: undefined,
      }),
    ]);
    expect(built.albums[0]!.name).toBe('Greatest Hits');
  });

  it('falls back to Unknown Artist/Album and a filename-derived title with no tags', () => {
    const built = buildLibrary([track({ relPath: 'loose-file.mp3' })]);
    expect(built.songs[0]!.artist).toBe('Unknown Artist');
    expect(built.songs[0]!.title).toBe('loose-file');
  });
});

describe('loose singles (un-bucketing)', () => {
  it('flags the synthetic Singles bucket and album-less tracks', () => {
    expect(isLooseSinglesBucket('Alfredo Casero/Singles', 'Singles')).toBe(true);
    expect(isLooseSinglesBucket('Alfredo Casero/Singles', 'Mi Canción')).toBe(true); // leaf == Singles
    expect(isLooseSinglesBucket('A/B', 'Unknown Album')).toBe(true);
    expect(isLooseSinglesBucket('Daft Punk/Discovery', 'Discovery')).toBe(false);
  });

  it('turns a force-tagged <Artist>/Singles/ track into its own single named after the title', () => {
    // Mirrors a legacy file the organizer wrote with album="Singles".
    const built = buildLibrary([
      track({
        relPath: 'Alfredo Casero/Singles/Mi Cancion.mp3',
        artist: 'Alfredo Casero',
        album: 'Singles',
        title: 'Mi Cancion',
      }),
    ]);
    expect(built.albums).toHaveLength(1);
    expect(built.albums[0]!.name).toBe('Mi Cancion');
    expect(built.albums[0]!.id).toBe(albumIdFor('Alfredo Casero', 'Mi Cancion'));
  });

  it('gives each loose single its own album card', () => {
    const built = buildLibrary([
      track({
        relPath: 'Alfredo Casero/Singles/Song A.mp3',
        artist: 'Alfredo Casero',
        album: 'Singles',
        title: 'Song A',
      }),
      track({
        relPath: 'Alfredo Casero/Singles/Song B.mp3',
        artist: 'Alfredo Casero',
        album: 'Singles',
        title: 'Song B',
      }),
    ]);
    expect(built.albums).toHaveLength(2);
    expect(built.albums.map((a) => a.name).sort()).toEqual(['Song A', 'Song B']);
    // One artist, two single "releases".
    expect(built.artists).toHaveLength(1);
    expect(built.artists[0]!.albumCount).toBe(2);
  });

  it('collapses format-duplicates of the same single into one card', () => {
    const built = buildLibrary([
      track({
        relPath: 'Alfredo Casero/Singles/Hit.mp3',
        artist: 'Alfredo Casero',
        album: 'Singles',
        title: 'Hit',
        suffix: 'mp3',
      }),
      track({
        relPath: 'Alfredo Casero/Singles/Hit.flac',
        artist: 'Alfredo Casero',
        album: 'Singles',
        title: 'Hit',
        suffix: 'flac',
      }),
    ]);
    expect(built.songs).toHaveLength(1);
    expect(built.albums).toHaveLength(1);
    expect(built.songs[0]!.suffix).toBe('flac'); // lossless wins
  });

  it('keeps a coherent multi-track loose download as one album (not split)', () => {
    const built = buildLibrary([
      track({ relPath: 'A/Some EP/01.mp3', artist: 'A', album: 'Some EP', title: 'T1' }),
      track({ relPath: 'A/Some EP/02.mp3', artist: 'A', album: 'Some EP', title: 'T2' }),
      track({ relPath: 'A/Some EP/03.mp3', artist: 'A', album: 'Some EP', title: 'T3' }),
    ]);
    expect(built.albums).toHaveLength(1);
    expect(built.albums[0]!.name).toBe('Some EP');
    expect(built.albums[0]!.songCount).toBe(3);
  });
});

describe('LibraryScanner.persist', () => {
  let db: Database;
  let scanner: LibraryScanner;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    scanner = new LibraryScanner('/music', db);
  });

  it('writes albums + songs and prunes vanished rows on a full scan', () => {
    const built = buildLibrary([
      track({ relPath: 'A/Album/01.mp3', artist: 'A', album: 'Album', title: 'T1' }),
    ]);
    scanner.persist(built, Date.now(), true);
    expect(db.query('SELECT COUNT(*) AS c FROM library_songs').get()).toEqual({ c: 1 });
    expect(db.query('SELECT COUNT(*) AS c FROM library_albums').get()).toEqual({ c: 1 });

    // A later full scan that no longer reports the file prunes it.
    scanner.persist(
      {
        songs: [],
        albums: [],
        artists: [],
        genres: [],
        songArtists: [],
        albumArtists: [],
        songGenres: [],
      },
      Date.now() + 1,
      true,
    );
    expect(db.query('SELECT COUNT(*) AS c FROM library_songs').get()).toEqual({ c: 0 });
    expect(db.query('SELECT COUNT(*) AS c FROM library_albums').get()).toEqual({ c: 0 });
  });

  it('preserves curation columns (hidden/classification) across rescans', () => {
    const built = buildLibrary([
      track({ relPath: 'A/Album/01.mp3', artist: 'A', album: 'Album', title: 'T1' }),
    ]);
    scanner.persist(built, Date.now(), true);
    const albumId = built.albums[0]!.id;
    db.run(
      'UPDATE library_albums SET hidden = 1, classification = ?, manual_override = 1 WHERE id = ?',
      ['single', albumId],
    );

    // Rescan the same file — curation must stick.
    scanner.persist(built, Date.now() + 1, true);
    const row = db
      .query<{ hidden: number; classification: string }, [string]>(
        'SELECT hidden, classification FROM library_albums WHERE id = ?',
      )
      .get(albumId);
    expect(row?.hidden).toBe(1);
    expect(row?.classification).toBe('single');
  });

  it('keeps DB-only perceptual features across a tag-less rescan (COALESCE contract)', () => {
    const built = buildLibrary([
      track({ relPath: 'A/Album/01.mp3', artist: 'A', album: 'Album', title: 'T1' }),
    ]);
    scanner.persist(built, Date.now(), true);
    const id = built.songs[0]!.id;
    // Simulate the enrichment tasks writing DB values before the tag lands.
    db.run(
      `UPDATE library_songs SET energy = 0.7, loudness = -9.5, danceability = 0.6,
       valence = 0.4, acousticness = 0.1, instrumental = 0.9, mood = 'relaxed' WHERE id = ?`,
      [id],
    );

    // A rescan whose tracks carry no feature tags must not revert the enrichment.
    scanner.persist(built, Date.now() + 1, true);
    const row = db
      .query<
        {
          energy: number;
          loudness: number;
          danceability: number;
          valence: number;
          acousticness: number;
          instrumental: number;
          mood: string;
        },
        [string]
      >(
        `SELECT energy, loudness, danceability, valence, acousticness, instrumental, mood
         FROM library_songs WHERE id = ?`,
      )
      .get(id);
    expect(row?.energy).toBeCloseTo(0.7);
    expect(row?.loudness).toBeCloseTo(-9.5);
    expect(row?.danceability).toBeCloseTo(0.6);
    expect(row?.valence).toBeCloseTo(0.4);
    expect(row?.acousticness).toBeCloseTo(0.1);
    expect(row?.instrumental).toBeCloseTo(0.9);
    expect(row?.mood).toBe('relaxed');
  });

  it('lets a rescan that DOES read feature tags override stale DB values', () => {
    const first = buildLibrary([
      track({ relPath: 'A/Album/01.mp3', artist: 'A', album: 'Album', title: 'T1' }),
    ]);
    scanner.persist(first, Date.now(), true);
    db.run('UPDATE library_songs SET energy = 0.2, mood = ? WHERE id = ?', [
      'sad',
      first.songs[0]!.id,
    ]);

    // Same file rescanned, now carrying feature tags (e.g. retagged externally).
    const second = buildLibrary([
      track({
        relPath: 'A/Album/01.mp3',
        artist: 'A',
        album: 'Album',
        title: 'T1',
        energy: 0.85,
        mood: 'party',
      }),
    ]);
    scanner.persist(second, Date.now() + 1, true);
    const row = db
      .query<{ energy: number; mood: string }, [string]>(
        'SELECT energy, mood FROM library_songs WHERE id = ?',
      )
      .get(first.songs[0]!.id);
    expect(row?.energy).toBeCloseTo(0.85);
    expect(row?.mood).toBe('party');
  });

  it('incremental persist does not prune untouched rows', () => {
    scanner.persist(
      buildLibrary([
        track({ relPath: 'A/Album/01.mp3', artist: 'A', album: 'Album', title: 'T1' }),
      ]),
      Date.now(),
      true,
    );
    // A separate incremental batch for a different album must not drop the first.
    scanner.persist(
      buildLibrary([
        track({ relPath: 'B/Other/01.mp3', artist: 'B', album: 'Other', title: 'T2' }),
      ]),
      Date.now() + 1,
      false,
    );
    expect(db.query('SELECT COUNT(*) AS c FROM library_songs').get()).toEqual({ c: 2 });
  });
});

describe('buildLibrary — multi-artist splitting (conservative, confirmation-gated)', () => {
  function songCredits(built: ReturnType<typeof buildLibrary>, relPath: string) {
    const id = songId(relPath);
    return built.songArtists
      .filter((l) => l.parentId === id)
      .sort((a, b) => a.position - b.position);
  }

  it('splits a collab when both members appear atomically elsewhere in the batch', () => {
    // Charly García and Luis Alberto Spinetta each have their own solo tracks, so the
    // collab "Charly García y Luis Alberto Spinetta" splits into two linked artists.
    const built = buildLibrary([
      track({ relPath: 'Charly/Solo/01.mp3', artist: 'Charly García', album: 'Solo', title: 'A' }),
      track({
        relPath: 'Spinetta/Solo/01.mp3',
        artist: 'Luis Alberto Spinetta',
        album: 'Solo',
        title: 'B',
      }),
      track({
        relPath: 'Collab/Album/01.mp3',
        artist: 'Charly García y Luis Alberto Spinetta',
        album: 'Collab',
        title: 'C',
      }),
    ]);
    const credits = songCredits(built, 'Collab/Album/01.mp3');
    expect(credits.map((c) => c.artistId)).toEqual([
      artistIdFor('Charly García'),
      artistIdFor('Luis Alberto Spinetta'),
    ]);
    expect(credits.every((c) => c.role === 'primary')).toBe(true);
  });

  it('keeps a band whole when its members are not independently confirmed (no garbage)', () => {
    // "The Wailers" never appears atomically, so the band stays a single credit — and
    // crucially there is NO "part == raw" garbage row (the old bug produced
    // "Bob Marley" + "Bob Marley & The Wailers").
    const built = buildLibrary([
      track({
        relPath: 'BM/Album/01.mp3',
        artist: 'Bob Marley & The Wailers',
        album: 'Legend',
        title: 'A',
      }),
    ]);
    const credits = songCredits(built, 'BM/Album/01.mp3');
    expect(credits).toHaveLength(1);
    expect(credits[0]!.artistId).toBe(artistIdFor('Bob Marley & The Wailers'));
  });

  it('keeps a duo whole when the authority marks it canonical, even if both members confirmed', () => {
    const built = buildLibrary(
      [
        track({ relPath: 'Wisin/Solo/01.mp3', artist: 'Wisin', album: 'Solo', title: 'A' }),
        track({ relPath: 'Yandel/Solo/01.mp3', artist: 'Yandel', album: 'Solo', title: 'B' }),
        track({ relPath: 'Duo/Album/01.mp3', artist: 'Wisin & Yandel', album: 'Duo', title: 'C' }),
      ],
      undefined,
      undefined,
      {
        confirmedArtists: new Set(),
        canonicalWhole: new Set(['wisin & yandel']),
        aliases: new Map(),
      },
    );
    const credits = songCredits(built, 'Duo/Album/01.mp3');
    expect(credits).toHaveLength(1);
    expect(credits[0]!.artistId).toBe(artistIdFor('Wisin & Yandel'));
  });

  it('collapses spelling variants into one entity via the MBID alias map', () => {
    const built = buildLibrary(
      [
        track({ relPath: 'SD1/A/01.mp3', artist: 'Snoop Dog', album: 'A', title: 'X' }),
        track({ relPath: 'SD2/B/01.mp3', artist: 'Snoop Dogg', album: 'B', title: 'Y' }),
      ],
      undefined,
      undefined,
      {
        confirmedArtists: new Set(),
        canonicalWhole: new Set(),
        aliases: new Map([['snoop dog', 'Snoop Dogg']]),
      },
    );
    // One artist entity, both albums keyed under the canonical spelling.
    expect(built.artists.map((a) => a.name)).toEqual(['Snoop Dogg']);
    expect(new Set(built.songs.map((s) => s.artistId))).toEqual(
      new Set([artistIdFor('Snoop Dogg')]),
    );
    expect(new Set(built.albums.map((a) => a.artistId))).toEqual(
      new Set([artistIdFor('Snoop Dogg')]),
    );
    expect(built.songs.every((s) => s.artist === 'Snoop Dogg')).toBe(true);
  });

  it('rewrites split-member credit spelling through the alias map', () => {
    // The collab names a member in a variant spelling; the alias map both confirms
    // the part (it is a known real artist by MBID) and canonicalizes the credit.
    const built = buildLibrary(
      [
        track({ relPath: 'Dre/Solo/01.mp3', artist: 'Dr. Dre', album: 'Solo', title: 'A' }),
        track({
          relPath: 'Collab/Album/01.mp3',
          artist: 'Snoop Dog & Dr. Dre',
          album: 'Collab',
          title: 'B',
        }),
      ],
      undefined,
      undefined,
      {
        confirmedArtists: new Set(),
        canonicalWhole: new Set(),
        aliases: new Map([['snoop dog', 'Snoop Dogg']]),
      },
    );
    const credits = songCredits(built, 'Collab/Album/01.mp3');
    expect(credits.map((c) => c.artistId)).toEqual([
      artistIdFor('Snoop Dogg'),
      artistIdFor('Dr. Dre'),
    ]);
    // The credit-only artist row carries the canonical spelling too.
    expect(built.artists.some((a) => a.name === 'Snoop Dogg')).toBe(true);
    expect(built.artists.some((a) => a.name === 'Snoop Dog')).toBe(false);
  });

  it('flags a split compound entity so the grid can hide it (members stay visible)', () => {
    const built = buildLibrary([
      track({ relPath: 'Charly/Solo/01.mp3', artist: 'Charly García', album: 'Solo', title: 'A' }),
      track({
        relPath: 'Spinetta/Solo/01.mp3',
        artist: 'Luis Alberto Spinetta',
        album: 'Solo',
        title: 'B',
      }),
      track({
        relPath: 'Collab/Album/01.mp3',
        artist: 'Charly García y Luis Alberto Spinetta',
        album: 'Collab',
        title: 'C',
      }),
    ]);
    const byName = new Map(built.artists.map((a) => [a.name, a]));
    expect(byName.get('Charly García y Luis Alberto Spinetta')?.splitCompound).toBe(true);
    expect(byName.get('Charly García')?.splitCompound).toBe(false);
    expect(byName.get('Luis Alberto Spinetta')?.splitCompound).toBe(false);
  });

  it('does not flag a band kept whole', () => {
    const built = buildLibrary([
      track({
        relPath: 'BM/Album/01.mp3',
        artist: 'Bob Marley & The Wailers',
        album: 'Legend',
        title: 'A',
      }),
    ]);
    expect(built.artists.find((a) => a.name === 'Bob Marley & The Wailers')?.splitCompound).toBe(
      false,
    );
  });
});

describe('buildLibrary — multi-genre', () => {
  it('splits a joined tag: primary in song.genre, full set in songGenres, aggregate over set', () => {
    const built = buildLibrary([
      track({
        relPath: 'A/Alb/01.mp3',
        artist: 'A',
        album: 'Alb',
        title: 'T1',
        genre: 'Latin Rock;Latin Music',
      }),
      track({ relPath: 'A/Alb/02.mp3', artist: 'A', album: 'Alb', title: 'T2', genre: 'Latin Rock' }),
    ]);
    expect(built.songs[0]!.genre).toBe('Latin Rock');
    const g1 = built.songGenres.filter((g) => g.songId === built.songs[0]!.id);
    expect(g1.map((g) => [g.genre, g.position])).toEqual([
      ['Latin Rock', 0],
      ['Latin Music', 1],
    ]);
    const rock = built.genres.find((g) => g.name === 'Latin Rock');
    const music = built.genres.find((g) => g.name === 'Latin Music');
    expect(rock?.songCount).toBe(2);
    expect(music?.songCount).toBe(1);
    expect(rock?.albumCount).toBe(1);
  });

  it('accepts multi-frame array genres from the tag parser', () => {
    const built = buildLibrary([
      track({
        relPath: 'A/Alb/01.mp3',
        artist: 'A',
        album: 'Alb',
        title: 'T',
        genre: ['Rock', 'Pop'],
      }),
    ]);
    expect(built.songs[0]!.genre).toBe('Rock');
    expect(built.songGenres.map((g) => g.genre)).toEqual(['Rock', 'Pop']);
  });

  it('applies the genre alias context (drop junk, expand concatenations)', () => {
    const ctx = {
      aliases: new Map([
        ['other', ''],
        ['rockpunk', 'Rock;Punk'],
      ]),
      known: new Map<string, string>(),
    };
    const built = buildLibrary(
      [
        track({ relPath: 'A/Alb/01.mp3', artist: 'A', album: 'Alb', title: 'T1', genre: 'Other' }),
        track({ relPath: 'A/Alb/02.mp3', artist: 'A', album: 'Alb', title: 'T2', genre: 'RockPunk' }),
      ],
      undefined,
      undefined,
      undefined,
      ctx,
    );
    expect(built.songs[0]!.genre).toBeNull();
    expect(built.songGenres.filter((g) => g.songId === built.songs[0]!.id)).toEqual([]);
    expect(built.songs[1]!.genre).toBe('Rock');
    expect(
      built.songGenres.filter((g) => g.songId === built.songs[1]!.id).map((g) => g.genre),
    ).toEqual(['Rock', 'Punk']);
  });

  it('normalizes casing variants to one genre via the in-batch vocabulary', () => {
    const built = buildLibrary([
      track({ relPath: 'A/Alb/01.mp3', artist: 'A', album: 'Alb', title: 'T1', genre: 'Deep House' }),
      track({ relPath: 'A/Alb/02.mp3', artist: 'A', album: 'Alb', title: 'T2', genre: 'Deep House' }),
      track({ relPath: 'A/Alb/03.mp3', artist: 'A', album: 'Alb', title: 'T3', genre: 'deep house' }),
    ]);
    expect(built.genres).toHaveLength(1);
    expect(built.genres[0]!.name).toBe('Deep House');
    expect(built.songs[2]!.genre).toBe('Deep House');
  });
});

describe('LibraryScanner.persist — multi-genre join table', () => {
  let db: Database;
  let scanner: LibraryScanner;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    scanner = new LibraryScanner('/music', db);
  });

  it('writes library_song_genres rows and replaces them on rescan', () => {
    const built = buildLibrary([
      track({ relPath: 'A/Alb/01.mp3', artist: 'A', album: 'Alb', title: 'T', genre: 'Rock;Pop' }),
    ]);
    scanner.persist(built, Date.now(), true);
    const id = built.songs[0]!.id;
    const rows = db
      .query<{ genre: string; position: number }, [string]>(
        'SELECT genre, position FROM library_song_genres WHERE song_id = ? ORDER BY position',
      )
      .all(id);
    expect(rows).toEqual([
      { genre: 'Rock', position: 0 },
      { genre: 'Pop', position: 1 },
    ]);

    // Rescan with a changed tag replaces the set (no stale leftovers).
    const built2 = buildLibrary([
      track({ relPath: 'A/Alb/01.mp3', artist: 'A', album: 'Alb', title: 'T', genre: 'Techno' }),
    ]);
    scanner.persist(built2, Date.now() + 1, true);
    const rows2 = db
      .query<{ genre: string }, [string]>(
        'SELECT genre FROM library_song_genres WHERE song_id = ? ORDER BY position',
      )
      .all(id);
    expect(rows2).toEqual([{ genre: 'Techno' }]);
  });

  it('prunes join rows for songs removed by a full scan', () => {
    const built = buildLibrary([
      track({ relPath: 'A/Alb/01.mp3', artist: 'A', album: 'Alb', title: 'T', genre: 'Rock' }),
    ]);
    scanner.persist(built, Date.now(), true);
    scanner.persist(
      { songs: [], albums: [], artists: [], genres: [], songArtists: [], albumArtists: [], songGenres: [] },
      Date.now() + 1,
      true,
    );
    expect(db.query('SELECT COUNT(*) AS c FROM library_song_genres').get()).toEqual({ c: 0 });
  });
});
