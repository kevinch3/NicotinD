import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { getLyrics, setLyrics, deleteLyrics } from './lyrics-store.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('lyrics-store', () => {
  it('returns null for a song with no lyrics', () => {
    expect(getLyrics(db, 'song-1')).toBeNull();
  });

  it('upserts and reads lyrics by songId', () => {
    const saved = setLyrics(db, 'song-1', {
      plain: 'words',
      synced: '[00:01.00]words',
      source: 'lrclib',
      customized: false,
    });
    expect(saved.plain).toBe('words');
    expect(saved.customized).toBe(false);

    const read = getLyrics(db, 'song-1');
    expect(read?.plain).toBe('words');
    expect(read?.synced).toBe('[00:01.00]words');
    expect(read?.source).toBe('lrclib');
    expect(read?.customized).toBe(false);
  });

  it('marks a user edit as customized and clears synced', () => {
    setLyrics(db, 'song-1', { plain: 'auto', synced: '[00:01]auto', source: 'lrclib', customized: false });
    setLyrics(db, 'song-1', { plain: 'my edit', synced: null, source: 'user', customized: true });
    const read = getLyrics(db, 'song-1');
    expect(read?.plain).toBe('my edit');
    expect(read?.synced).toBeNull();
    expect(read?.source).toBe('user');
    expect(read?.customized).toBe(true);
  });

  it('deletes a row (reset)', () => {
    setLyrics(db, 'song-1', { plain: 'x', synced: null, source: 'lrclib', customized: false });
    deleteLyrics(db, 'song-1');
    expect(getLyrics(db, 'song-1')).toBeNull();
  });
});
