import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { carrySongCuration, moveSongGenreOverride } from './song-curation-carry.js';
import { upsertGenreOverride } from './genre-overrides.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function override(key: string, genres: string[]): void {
  upsertGenreOverride(db, {
    scope: 'song',
    key,
    genres,
    source: 'user',
    mbid: null,
    confidence: null,
    status: 'applied',
    note: null,
    mode: 'replace',
  });
}

const overrideKeys = () =>
  db
    .query<{ key: string }, []>(`SELECT key FROM library_genre_overrides WHERE scope = 'song'`)
    .all()
    .map((r) => r.key);

function acquisition(path: string, method: string): void {
  db.run(
    `INSERT INTO acquisitions (relative_path, method, stage, started_at) VALUES (?, ?, 'done', 1)`,
    [path, method],
  );
}

describe('moveSongGenreOverride', () => {
  it('moves a curator override onto the new id', () => {
    override('old', ['Dub']);
    expect(moveSongGenreOverride(db, 'old', 'new')).toBe(true);
    expect(overrideKeys()).toEqual(['new']);
  });

  it('keeps the destination own curation and drops the stale row', () => {
    // (scope, key) is a primary key; a plain UPDATE would abort the enclosing
    // transaction, which during a scan prune means losing the whole pass.
    override('old', ['Dub']);
    override('new', ['Ambient']);
    expect(moveSongGenreOverride(db, 'old', 'new')).toBe(false);
    expect(overrideKeys()).toEqual(['new']);
    const kept = db
      .query<{ genres: string }, [string]>(
        `SELECT genres FROM library_genre_overrides WHERE scope = 'song' AND key = ?`,
      )
      .get('new');
    expect(kept!.genres).toContain('Ambient');
  });

  it('leaves nothing behind when there was no override', () => {
    expect(moveSongGenreOverride(db, 'old', 'new')).toBe(false);
    expect(overrideKeys()).toEqual([]);
  });

  it('is a no-op when the id did not change', () => {
    override('same', ['Dub']);
    expect(moveSongGenreOverride(db, 'same', 'same')).toBe(false);
    // The guard matters: without it the DELETE fallback would erase a live row.
    expect(overrideKeys()).toEqual(['same']);
  });
});

describe('carrySongCuration', () => {
  it('carries playlists, the override and provenance in one call', () => {
    db.run(
      `INSERT INTO playlists (id, user_id, name, created_at, modified_at) VALUES ('p', 'u', 'P', 1, 1)`,
    );
    db.run(
      `INSERT INTO playlist_songs (playlist_id, song_id, position, added_at) VALUES ('p', 'old', 0, 1)`,
    );
    override('old', ['Dub']);
    acquisition('a/old.flac', 'peer');

    const r = carrySongCuration(db, {
      fromId: 'old',
      toId: 'new',
      fromPath: 'a/old.flac',
      toPath: 'a/old.opus',
    });

    expect(r).toEqual({ playlistRows: 1, genreOverrideMoved: true, acquisitionMoved: true });
    expect(db.query<{ song_id: string }, []>('SELECT song_id FROM playlist_songs').all()).toEqual([
      { song_id: 'new' },
    ]);
    expect(overrideKeys()).toEqual(['new']);
    expect(
      db.query<{ relative_path: string }, []>('SELECT relative_path FROM acquisitions').all(),
    ).toEqual([{ relative_path: 'a/old.opus' }]);
  });

  it('keeps a pre-existing provenance row at the destination path', () => {
    // relative_path is the primary key, so a plain UPDATE would abort; the row
    // already there is also the newer record of the two.
    acquisition('a/old.flac', 'lossless');
    acquisition('a/old.opus', 'opus-peer');

    const r = carrySongCuration(db, {
      fromId: 'old',
      toId: 'new',
      fromPath: 'a/old.flac',
      toPath: 'a/old.opus',
    });

    expect(r.acquisitionMoved).toBe(false);
    const rows = db
      .query<{ relative_path: string; method: string }, []>(
        'SELECT relative_path, method FROM acquisitions',
      )
      .all();
    expect(rows).toEqual([{ relative_path: 'a/old.opus', method: 'opus-peer' }]);
  });

  it('does not touch a playlist entry the destination already has', () => {
    db.run(
      `INSERT INTO playlists (id, user_id, name, created_at, modified_at) VALUES ('p', 'u', 'P', 1, 1)`,
    );
    db.run(
      `INSERT INTO playlist_songs (playlist_id, song_id, position, added_at) VALUES ('p', 'old', 0, 1)`,
    );
    db.run(
      `INSERT INTO playlist_songs (playlist_id, song_id, position, added_at) VALUES ('p', 'new', 1, 1)`,
    );

    const r = carrySongCuration(db, { fromId: 'old', toId: 'new' });

    // The OR IGNORE case: one row stays, and the stale one is left for the
    // caller's own delete rather than silently duplicated.
    expect(r.playlistRows).toBe(0);
  });

  it('leaves provenance alone when no paths are given', () => {
    acquisition('a/old.flac', 'peer');
    const r = carrySongCuration(db, { fromId: 'old', toId: 'new' });
    expect(r.acquisitionMoved).toBe(false);
    expect(
      db.query<{ relative_path: string }, []>('SELECT relative_path FROM acquisitions').all(),
    ).toEqual([{ relative_path: 'a/old.flac' }]);
  });

  it('is a no-op when the id did not change', () => {
    override('same', ['Dub']);
    const r = carrySongCuration(db, { fromId: 'same', toId: 'same' });
    expect(r).toEqual({ playlistRows: 0, genreOverrideMoved: false, acquisitionMoved: false });
    expect(overrideKeys()).toEqual(['same']);
  });
});
