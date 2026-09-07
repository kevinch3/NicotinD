import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { upsertGenreAlias } from './genre-alias-mutate.js';
import { loadGenreSets } from './genre-split.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function addSong(id: string, genres: string[]): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at)
     VALUES (?, 'al', ?, 'a', 'ar', ?, 1)`,
    [id, id, `/m/${id}.mp3`],
  );
  genres.forEach((g, i) =>
    db.run(`INSERT INTO library_song_genres (song_id, genre, position) VALUES (?, ?, ?)`, [
      id,
      g,
      i,
    ]),
  );
}

function genresOf(id: string): string[] {
  return loadGenreSets(db, [id]).get(id) ?? [];
}

/**
 * Issue #949: the alias table is the only genre store whose granularity matches
 * an artist-wide bad string — one row fixes every song carrying it AND every
 * song that will arrive with it — and MCP could not write it.
 */
describe('upsertGenreAlias', () => {
  it('repairs every song carrying the bad value, at whatever position', () => {
    // The prod case: 44 Mercedes Sosa rows, all at position 3, invisible to
    // get_rare_genres because that counts the primary genre only.
    addSong('s1', ['Folklore', 'Latin', 'World', 'Nueva CancióN']);
    addSong('s2', ['Nueva CancióN']);
    addSong('s3', ['Rock']);

    const r = upsertGenreAlias(db, { alias: 'Nueva CancióN', canonical: 'Nueva Canción' });
    expect(r).toMatchObject({ ok: true, canonical: ['Nueva Canción'], songsUpdated: 2 });
    expect(genresOf('s1')).toEqual(['Folklore', 'Latin', 'World', 'Nueva Canción']);
    expect(genresOf('s2')).toEqual(['Nueva Canción']);
    expect(genresOf('s3')).toEqual(['Rock']);
  });

  it('expands one alias into several genres — the no-separator concatenation case', () => {
    addSong('s1', ['Pop RockLatin AlternativeLatin RockLatin Pop']);
    const r = upsertGenreAlias(db, {
      alias: 'Pop RockLatin AlternativeLatin RockLatin Pop',
      canonical: 'Pop Rock;Latin Alternative;Latin Rock;Latin Pop',
    });
    expect(r).toMatchObject({ ok: true, songsUpdated: 1 });
    expect(genresOf('s1')).toEqual(['Pop Rock', 'Latin Alternative', 'Latin Rock', 'Latin Pop']);
  });

  it('drops a junk value when canonical is empty', () => {
    addSong('s1', ['Rock', 'Other']);
    expect(upsertGenreAlias(db, { alias: 'Other', canonical: '' })).toMatchObject({ ok: true });
    expect(genresOf('s1')).toEqual(['Rock']);
  });

  it('survives as a rule, not just a repair: the row is stored for future arrivals', () => {
    upsertGenreAlias(db, { alias: 'Rock - Alternative Rock', canonical: 'Alternative Rock;Rock' });
    expect(
      db
        .query<{ canonical: string; source: string }, [string]>(
          'SELECT canonical, source FROM library_genre_aliases WHERE alias = ?',
        )
        .get('Rock - Alternative Rock'),
    ).toEqual({ canonical: 'Alternative Rock;Rock', source: 'user' });
  });

  it('parses the canonical side the way every other curation surface does', () => {
    // A comma is a scanner separator, so it must become two genres here too —
    // otherwise an alias could mint a value a rescan would re-split (#942).
    const r = upsertGenreAlias(db, { alias: 'RockPunk', canonical: 'Rock, Punk' });
    expect(r).toMatchObject({ ok: true, canonical: ['Rock', 'Punk'] });
  });

  it('rejects an empty alias and an exact no-op', () => {
    expect(upsertGenreAlias(db, { alias: '  ', canonical: 'Rock' }).ok).toBe(false);
    expect(upsertGenreAlias(db, { alias: 'Rock', canonical: 'Rock' }).ok).toBe(false);
  });

  it('allows a casing repair inside an accented name', () => {
    // The no-op check compares exact strings, not folded keys: the key folds
    // case AND accents, so it would refuse the 44-row Mercedes Sosa case.
    expect(upsertGenreAlias(db, { alias: 'Nueva CancióN', canonical: 'Nueva Canción' }).ok).toBe(
      true,
    );
  });
});
