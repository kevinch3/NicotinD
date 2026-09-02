import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { upsertGenreOverride, type GenreOverrideRow } from './genre-overrides.js';
import { repointGenreOverridesBeforePrune } from './genre-override-repoint.js';

let db: Database;
const OLD = 1;
const NEW = 2;

function seedSong(
  id: string,
  opts: { title: string; artist: string; dur: number; synced: number },
) {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
     VALUES (?, 'al', ?, ?, 'art', ?, ?, 100, '2024-01-01', ?)`,
    [id, opts.title, opts.artist, opts.dur, `p/${id}.opus`, opts.synced],
  );
}

function seedSongOverride(songId: string, p: Partial<GenreOverrideRow> = {}) {
  upsertGenreOverride(db, {
    scope: 'song',
    key: songId,
    genres: ['Folclore'],
    source: 'user',
    mbid: null,
    confidence: null,
    status: 'applied',
    note: null,
    mode: 'replace',
    ...p,
  });
}

const overrideKeyFor = (songId: string) =>
  db
    .query<{ key: string }, [string]>(
      `SELECT key FROM library_genre_overrides WHERE scope = 'song' AND key = ?`,
    )
    .get(songId)?.key ?? null;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES ('al','Album','Artist','art',1,0,${NEW})`,
  );
});

/**
 * `library_genre_overrides` (scope='song') is keyed on `library_songs.id` =
 * sha1(path), so a file move re-mints the id under it. The scanner's full-scan
 * prune then deletes the old row and every curator decision keyed on it is
 * gone — a *replace*-mode row is not merely a convenience mirror, it is the
 * one thing standing between the song and a future bad retag reverting it.
 * Measured on prod: 290/953 (30%) song-scope overrides orphaned, 173 of them
 * curator `mode:'replace'` decisions.
 */
describe('repointGenreOverridesBeforePrune', () => {
  it('moves a song-scope override onto the surviving row for the same recording', () => {
    seedSong('old', { title: 'Yo Puedo', artist: 'Decadentes', dur: 210, synced: OLD });
    seedSong('new', { title: 'Yo Puedo', artist: 'Decadentes', dur: 210, synced: NEW });
    seedSongOverride('old');

    expect(repointGenreOverridesBeforePrune(db, NEW)).toEqual({ repointed: 1, unmatched: 0 });
    expect(overrideKeyFor('old')).toBeNull();
    expect(overrideKeyFor('new')).toBe('new');
  });

  /**
   * A wrong re-point silently attaches one song's curated genre to a
   * DIFFERENT song, which is worse than the dangling row it replaces.
   */
  it('leaves the override alone when two survivors match — ambiguity must not guess', () => {
    seedSong('old', { title: 'Intro', artist: 'V', dur: 60, synced: OLD });
    seedSong('a', { title: 'Intro', artist: 'V', dur: 60, synced: NEW });
    seedSong('b', { title: 'Intro', artist: 'V', dur: 60, synced: NEW });
    seedSongOverride('old');

    expect(repointGenreOverridesBeforePrune(db, NEW)).toEqual({ repointed: 0, unmatched: 1 });
    expect(overrideKeyFor('old')).toBe('old'); // dangles, as it would have before
  });

  it('does not match a different recording of the same title (duration discriminates)', () => {
    // A live cut or remix shares title+artist but not length.
    seedSong('old', { title: 'Song', artist: 'A', dur: 200, synced: OLD });
    seedSong('live', { title: 'Song', artist: 'A', dur: 385, synced: NEW });
    seedSongOverride('old');

    expect(repointGenreOverridesBeforePrune(db, NEW)).toEqual({ repointed: 0, unmatched: 1 });
  });

  it('reports a genuinely deleted song as unmatched rather than inventing a target', () => {
    seedSong('old', { title: 'Gone', artist: 'A', dur: 100, synced: OLD });
    seedSongOverride('old');
    expect(repointGenreOverridesBeforePrune(db, NEW)).toEqual({ repointed: 0, unmatched: 1 });
  });

  it('ignores doomed songs with no override — the overwhelming majority', () => {
    seedSong('old', { title: 'Unloved', artist: 'A', dur: 100, synced: OLD });
    seedSong('new', { title: 'Unloved', artist: 'A', dur: 100, synced: NEW });
    expect(repointGenreOverridesBeforePrune(db, NEW)).toEqual({ repointed: 0, unmatched: 0 });
  });

  it('collapses rather than aborting when the survivor already carries its own override', () => {
    // (scope, key) is the primary key; a plain UPDATE would abort the scan.
    seedSong('old', { title: 'Dup', artist: 'A', dur: 100, synced: OLD });
    seedSong('new', { title: 'Dup', artist: 'A', dur: 100, synced: NEW });
    seedSongOverride('new', { genres: ['Techno'] });
    seedSongOverride('old', { genres: ['House'] });

    expect(() => repointGenreOverridesBeforePrune(db, NEW)).not.toThrow();
    // The survivor's own override wins; the doomed one is left for the prune.
    expect(overrideKeyFor('new')).toBe('new');
    expect(overrideKeyFor('old')).toBe('old');
  });

  it('preserves the curator mode across the repoint', () => {
    seedSong('old', { title: 'Larralde', artist: 'Larralde', dur: 210, synced: OLD });
    seedSong('new', { title: 'Larralde', artist: 'Larralde', dur: 210, synced: NEW });
    seedSongOverride('old', { genres: ['Folclore', 'Chacarera'], mode: 'replace' });

    repointGenreOverridesBeforePrune(db, NEW);
    const row = db
      .query<{ genres: string; mode: string | null }, []>(
        `SELECT genres, mode FROM library_genre_overrides WHERE scope = 'song' AND key = 'new'`,
      )
      .get();
    expect(row).toEqual({ genres: 'Folclore;Chacarera', mode: 'replace' });
  });

  it('never touches an artist- or album-scoped override for the doomed song', () => {
    seedSong('old', { title: 'Yo Puedo', artist: 'Decadentes', dur: 210, synced: OLD });
    seedSong('new', { title: 'Yo Puedo', artist: 'Decadentes', dur: 210, synced: NEW });
    // A row that merely happens to share the doomed song's id as its key, but
    // under a different scope (album/artist keys are never song ids in
    // practice, but the WHERE clause must still be scope-guarded).
    upsertGenreOverride(db, {
      scope: 'artist',
      key: 'old',
      genres: ['Rock'],
      source: 'user',
      mbid: null,
      confidence: null,
      status: 'applied',
      note: null,
    });

    repointGenreOverridesBeforePrune(db, NEW);
    const artistRow = db
      .query<{ key: string }, []>(`SELECT key FROM library_genre_overrides WHERE scope = 'artist'`)
      .get();
    expect(artistRow).toEqual({ key: 'old' });
  });
});
