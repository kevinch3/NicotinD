import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  AUTO_DAILY_LIMITS,
  autoBudgetRefusal,
  autoGenreRefusal,
  autoGenreVocabulary,
  isAutoReplaceableGenreSet,
} from './agent-policy.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function addGenre(name: string, songCount: number): void {
  db.run(
    `INSERT INTO library_genres (name, song_count, album_count, synced_at) VALUES (?, ?, 1, 1)`,
    [name, songCount],
  );
}

function addSong(id: string, genres: string[]): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, genre, synced_at)
     VALUES (?, 'al', 't', 'a', 'ar', ?, ?, 1)`,
    [id, `/m/${id}.opus`, genres[0] ?? null],
  );
  genres.forEach((g, i) =>
    db.run(`INSERT INTO library_song_genres (song_id, genre, position) VALUES (?, ?, ?)`, [
      id,
      g,
      i,
    ]),
  );
}

describe('isAutoReplaceableGenreSet', () => {
  it.each([
    [[], true],
    [['Music'], true],
    [['Other', 'Music'], true],
    [['Electronic'], true],
    [['Dance'], true],
    [['Music', 'Electronic'], true],
    // A real genre anywhere would be lost by a replace.
    [['Electronic', 'Tech House'], false],
    [['Dance', 'Electronic'], false],
    [['Rock'], false],
    [['Pop'], false],
    [['Music', 'House'], false],
  ] as const)('%j → %p', (genres, expected) => {
    expect(isAutoReplaceableGenreSet(genres)).toBe(expected);
  });
});

describe('autoGenreVocabulary', () => {
  it('keeps specific genres at least 3 songs carry; drops junk, catch-alls, slashes and one-offs', () => {
    addGenre('Tech House', 40);
    addGenre('Reggae', 3);
    addGenre('Alt-Pop', 1);
    addGenre('Electronic', 900);
    addGenre('Music', 50);
    addGenre('Nu Disco / Disco', 10);
    expect([...autoGenreVocabulary(db).values()].sort()).toEqual(['Reggae', 'Tech House']);
  });
});

describe('autoGenreRefusal', () => {
  beforeEach(() => {
    addGenre('Tech House', 40);
    addGenre('Techno', 40);
    addGenre('Alt-Pop', 1);
  });

  it('allows a vocabulary genre on a catch-all-only or genre-less song', () => {
    addSong('s-elec', ['Electronic']);
    addSong('s-none', []);
    expect(
      autoGenreRefusal(db, { songId: 's-elec', genre: 'Tech House', mode: 'replace' }),
    ).toBeNull();
    expect(autoGenreRefusal(db, { songId: 's-none', genre: 'techno', mode: 'replace' })).toBeNull();
    expect(
      autoGenreRefusal(db, { songId: 's-none', genre: 'Techno; Tech House', mode: 'replace' }),
    ).toBeNull();
  });

  it('refuses append, which a rescan loses', () => {
    addSong('s1', ['Electronic']);
    expect(autoGenreRefusal(db, { songId: 's1', genre: 'Techno', mode: '' })).toContain('replace');
    expect(autoGenreRefusal(db, { songId: 's1', genre: 'Techno', mode: 'append' })).toContain(
      'replace',
    );
  });

  it('refuses a song that already has a specific genre — a replace would drop it', () => {
    addSong('s1', ['Electronic', 'Tech House']);
    expect(autoGenreRefusal(db, { songId: 's1', genre: 'Techno', mode: 'replace' })).toContain(
      'already has a specific genre',
    );
  });

  it('refuses a genre outside the vocabulary: invented, one-off, catch-all or junk', () => {
    addSong('s1', ['Electronic']);
    for (const genre of ['Psybient Trap', 'Alt-Pop', 'Electronic', 'Music', '']) {
      expect(autoGenreRefusal(db, { songId: 's1', genre, mode: 'replace' })).toContain(
        'vocabulary',
      );
    }
    // One bad name in a list refuses the whole list.
    expect(
      autoGenreRefusal(db, { songId: 's1', genre: 'Techno; Made Up', mode: 'replace' }),
    ).toContain('Made Up');
  });

  it('refuses an unknown song', () => {
    expect(autoGenreRefusal(db, { songId: 'nope', genre: 'Techno', mode: 'replace' })).toBe(
      'Song not found',
    );
  });
});

describe('autoBudgetRefusal', () => {
  const now = Date.UTC(2026, 9, 18, 12);
  const audit = (action: string, at: number, username = 'agent:tok') =>
    db.run(`INSERT INTO audit_log (at, user_id, username, action) VALUES (?, 'u1', ?, ?)`, [
      at,
      username,
      action,
    ]);

  it('refuses once the token has spent today’s budget, counting only its own rows today', () => {
    const { limit } = AUTO_DAILY_LIMITS.flag_for_review!;
    for (let i = 0; i < limit - 1; i++) audit('curation.flag', now - 1000);
    audit('curation.flag', Date.UTC(2026, 9, 17, 23)); // yesterday
    audit('curation.flag', now, 'agent:other'); // another token
    expect(autoBudgetRefusal(db, 'tok', 'flag_for_review', now)).toBeNull();

    audit('curation.flag', now);
    expect(autoBudgetRefusal(db, 'tok', 'flag_for_review', now)).toContain('budget exhausted');
    // Budgets are per tool.
    expect(autoBudgetRefusal(db, 'tok', 'set_song_genre', now)).toBeNull();
  });

  it('has no budget for read tools', () => {
    expect(autoBudgetRefusal(db, 'tok', 'search_library', now)).toBeNull();
  });
});
