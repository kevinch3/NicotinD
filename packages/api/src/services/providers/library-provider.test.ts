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
});
