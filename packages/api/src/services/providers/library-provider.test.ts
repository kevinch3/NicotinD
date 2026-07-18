import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../db.js';
import { LibrarySearchProvider } from './library-provider.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function seedSong(id: string, title: string, opts: { hidden?: boolean } = {}): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, hidden, landed_at, synced_at)
     VALUES (?, 'alb', ?, 'Alfredo Casero', 'art', 60, ?, ?, 1, 1)`,
    [id, title, `p/${id}.mp3`, opts.hidden ? 1 : 0],
  );
}

function seedAlbum(id: string, name: string, artist: string): void {
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, classification, hidden, synced_at)
     VALUES (?, ?, ?, 'art', 12, 'album', 0, 1)`,
    [id, name, artist],
  );
}

describe('LibrarySearchProvider song search', () => {
  it('matches by title and excludes hidden songs', async () => {
    seedSong('s1', 'Mi Canción');
    seedSong('s2', 'Mi Canción (hidden)', { hidden: true });
    const { results } = await new LibrarySearchProvider(db).search('canción');
    const ids = results!.songs.map((s) => s.id);
    expect(ids).toContain('s1');
    expect(ids).not.toContain('s2');
  });

  it('returns up to 40 song hits', async () => {
    for (let i = 0; i < 50; i++) seedSong(`s${i}`, `Track ${i}`);
    const { results } = await new LibrarySearchProvider(db).search('Track');
    expect(results!.songs.length).toBe(40);
  });

  it('carries artistId on song hits (so the player can link to the artist page)', async () => {
    seedSong('s1', 'Mi Canción');
    const { results } = await new LibrarySearchProvider(db).search('canción');
    expect(results!.songs[0]?.artistId).toBe('art');
  });

  it('returns empty lists for a blank query', async () => {
    const { results } = await new LibrarySearchProvider(db).search('   ');
    expect(results).toEqual({ artists: [], albums: [], songs: [] });
  });

  it('attaches multi-artist credits to song hits', async () => {
    seedSong('s1', 'Collab Song');
    db.run(
      `INSERT INTO library_artists (id, name, synced_at) VALUES ('a1','Charly García',1),('a2','Spinetta',1)`,
    );
    db.run(
      `INSERT INTO library_song_artists (song_id, artist_id, role, position)
       VALUES ('s1','a1','primary',0),('s1','a2','primary',1)`,
    );
    const { results } = await new LibrarySearchProvider(db).search('Collab');
    expect(results!.songs[0]?.artists?.map((a) => a.name)).toEqual(['Charly García', 'Spinetta']);
  });
});

describe('LibrarySearchProvider album matching (tokenized + accent-insensitive)', () => {
  it('surfaces an album by a multi-token "artist + title" query', async () => {
    // The C. Tangana / Ídolo case: artist and title in different columns; a
    // single raw LIKE over the whole query matched neither.
    seedAlbum('al1', 'Ídolo', 'C. Tangana');
    seedAlbum('al2', 'El Madrileño', 'C. Tangana');
    const { results } = await new LibrarySearchProvider(db).search('C. Tangana Ídolo');
    expect(results!.albums.map((a) => a.id)).toEqual(['al1']);
  });

  it('matches an accented title from an un-accented query', async () => {
    seedAlbum('al1', 'Ídolo', 'C. Tangana');
    const { results } = await new LibrarySearchProvider(db).search('idolo');
    expect(results!.albums.map((a) => a.id)).toContain('al1');
  });

  it('does not match when only some tokens are present (AND semantics)', async () => {
    seedAlbum('al1', 'Ídolo', 'C. Tangana');
    // "Rosalía" is nowhere in this album's name or artist → no match.
    const { results } = await new LibrarySearchProvider(db).search('Tangana Rosalía');
    expect(results!.albums).toHaveLength(0);
  });

  it('excludes albums with any un-landed (quarantined) song', async () => {
    seedAlbum('al1', 'Ídolo', 'C. Tangana');
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, hidden, landed_at, synced_at)
       VALUES ('s1', 'al1', 'Track', 'C. Tangana', 'art', 60, 'p/s1.mp3', 0, NULL, 1)`,
    );
    const { results } = await new LibrarySearchProvider(db).search('Ídolo');
    expect(results!.albums).toHaveLength(0);
  });
});

describe('LibrarySearchProvider artist matching', () => {
  it('matches an artist name accent-insensitively', async () => {
    db.run(`INSERT INTO library_artists (id, name, synced_at) VALUES ('a1','Rosalía',1)`);
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, hidden, landed_at, synced_at)
       VALUES ('s1','alb','T','Rosalía','a1',60,'p/s1.mp3',0,1,1)`,
    );
    const { results } = await new LibrarySearchProvider(db).search('rosalia');
    expect(results!.artists.map((a) => a.id)).toContain('a1');
  });
});
