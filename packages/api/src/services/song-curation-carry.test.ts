import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  carrySongCuration,
  moveSongGenreOverride,
  SONG_CARRY_TABLES,
  SONG_CARRY_EXEMPT,
} from './song-curation-carry.js';
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

    expect(r.playlistRows).toBe(1);
    expect(r.genreOverrideMoved).toBe(true);
    expect(r.acquisitionMoved).toBe(true);
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
    expect(r.playlistRows).toBe(0);
    expect(r.genreOverrideMoved).toBe(false);
    expect(r.acquisitionMoved).toBe(false);
    expect(r.moved).toEqual({});
    expect(r.dropped).toEqual({});
    expect(overrideKeys()).toEqual(['same']);
  });
});

describe('the registry, and the tables it newly covers', () => {
  it('every carried and exempt entry records a reason', () => {
    // The lists are read by whoever adds the next table; an entry with no
    // reason is a decision nobody can check.
    for (const e of [...SONG_CARRY_TABLES, ...SONG_CARRY_EXEMPT]) {
      expect(e.why.trim().length).toBeGreaterThan(20);
    }
  });

  it('no table is in both lists', () => {
    const carried = new Set(SONG_CARRY_TABLES.map((e) => `${e.table}.${e.column}`));
    const both = SONG_CARRY_EXEMPT.filter((e) => carried.has(`${e.table}.${e.column}`));
    expect(both).toEqual([]);
  });

  it('carries lyrics, which nothing else would ever restore', () => {
    // 2,436 rows on prod, outside ORPHAN_TABLES so nothing sweeps them, and
    // rebuilt by nothing. Synced LRC offsets live only here.
    db.run(
      `INSERT INTO library_lyrics (song_id, plain_text, updated_at) VALUES ('old', 'la la', 1)`,
    );
    carrySongCuration(db, { fromId: 'old', toId: 'new' });
    expect(db.query<{ song_id: string }, []>('SELECT song_id FROM library_lyrics').all()).toEqual([
      { song_id: 'new' },
    ]);
  });

  it('keeps the destination lyrics when both sides have them, and drops the stale row', () => {
    db.run(
      `INSERT INTO library_lyrics (song_id, plain_text, updated_at) VALUES ('old', 'source', 1)`,
    );
    db.run(
      `INSERT INTO library_lyrics (song_id, plain_text, updated_at) VALUES ('new', 'dest', 1)`,
    );

    const r = carrySongCuration(db, { fromId: 'old', toId: 'new' });

    const rows = db
      .query<{ song_id: string; plain_text: string }, []>(
        'SELECT song_id, plain_text FROM library_lyrics',
      )
      .all();
    expect(rows).toEqual([{ song_id: 'new', plain_text: 'dest' }]);
    // The leftover must be deleted explicitly: nothing sweeps this table.
    expect(r.dropped['library_lyrics']).toBe(1);
  });

  it('carries an exclude decision', () => {
    db.run(
      `INSERT INTO recommendation_feedback (user_id, song_id, kind, at) VALUES ('u', 'old', 'exclude', 1)`,
    );
    carrySongCuration(db, { fromId: 'old', toId: 'new' });
    expect(
      db.query<{ song_id: string }, []>('SELECT song_id FROM recommendation_feedback').all(),
    ).toEqual([{ song_id: 'new' }]);
  });

  it('leaves play_events alone — history is defended by snapshot, not by carry', () => {
    db.run(
      `INSERT INTO play_events (client_event_id, user_id, song_id, title, artist, album, at, ms_played, reason, counted)
       VALUES ('e1', 'u', 'old', 'T', 'A', 'Al', 1, 1000, 'played', 1)`,
    );
    carrySongCuration(db, { fromId: 'old', toId: 'new' });
    // Re-pointing it would be wrong: the event records what was played then,
    // and title/artist/album are copied onto the row for exactly this reason.
    expect(db.query<{ song_id: string }, []>('SELECT song_id FROM play_events').all()).toEqual([
      { song_id: 'old' },
    ]);
  });

  it('reports what it moved, per table', () => {
    db.run(`INSERT INTO library_lyrics (song_id, plain_text, updated_at) VALUES ('old', 'la', 1)`);
    const r = carrySongCuration(db, { fromId: 'old', toId: 'new' });
    expect(r.moved['library_lyrics']).toBe(1);
    // Tables with nothing to move are omitted rather than reported as zero.
    expect(r.moved['library_embeddings']).toBeUndefined();
  });
});
