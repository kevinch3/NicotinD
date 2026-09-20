import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { LYRICS_OFFSET_MAX_MS } from '@nicotind/core';
import { getLyrics, setLyrics, setLyricsOffset, deleteLyrics } from './lyrics-store.js';

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
    setLyrics(db, 'song-1', {
      plain: 'auto',
      synced: '[00:01]auto',
      source: 'lrclib',
      customized: false,
    });
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

/**
 * The sync offset: a correction applied at render time so the fetched words are
 * never rewritten. What has to hold is that it is durable, bounded, and tied to
 * the exact text it was measured against.
 */
describe('lyrics-store sync offset', () => {
  const fetched = { plain: 'words', synced: '[00:01.00]words', source: 'lrclib' };

  it('starts at zero for a freshly fetched row', () => {
    const saved = setLyrics(db, 'song-1', { ...fetched, customized: false });
    expect(saved.offsetMs).toBe(0);
    expect(getLyrics(db, 'song-1')?.offsetMs).toBe(0);
  });

  it('stores an offset and leaves the text untouched', () => {
    setLyrics(db, 'song-1', { ...fetched, customized: false });
    const synced = setLyricsOffset(db, 'song-1', 1_250);
    expect(synced?.offsetMs).toBe(1_250);

    const read = getLyrics(db, 'song-1');
    expect(read?.offsetMs).toBe(1_250);
    // The whole point of storing an offset rather than rewriting timestamps.
    expect(read?.synced).toBe('[00:01.00]words');
    expect(read?.plain).toBe('words');
    expect(read?.source).toBe('lrclib');
  });

  it('refuses to store an offset for a song with no lyrics', () => {
    expect(setLyricsOffset(db, 'song-nope', 500)).toBeNull();
    expect(getLyrics(db, 'song-nope')).toBeNull();
  });

  it('clamps beyond the promised range in both directions', () => {
    setLyrics(db, 'song-1', { ...fetched, customized: false });
    expect(setLyricsOffset(db, 'song-1', 999_999)?.offsetMs).toBe(LYRICS_OFFSET_MAX_MS);
    expect(setLyricsOffset(db, 'song-1', -999_999)?.offsetMs).toBe(-LYRICS_OFFSET_MAX_MS);
  });

  it('treats a non-finite offset as no offset', () => {
    setLyrics(db, 'song-1', { ...fetched, customized: false });
    expect(setLyricsOffset(db, 'song-1', Number.NaN)?.offsetMs).toBe(0);
  });

  it('is reversible — back to zero restores the original timing', () => {
    setLyrics(db, 'song-1', { ...fetched, customized: false });
    setLyricsOffset(db, 'song-1', 2_000);
    expect(setLyricsOffset(db, 'song-1', 0)?.offsetMs).toBe(0);
  });

  // The invalidation rule. New text means the old correction was measured
  // against something that no longer exists; carrying it over would shift
  // lyrics nobody ever checked, which is worse than not correcting at all.
  it('resets the offset when the text is replaced', () => {
    setLyrics(db, 'song-1', { ...fetched, customized: false });
    setLyricsOffset(db, 'song-1', 3_000);
    setLyrics(db, 'song-1', {
      plain: 'different words',
      synced: '[00:02.00]different words',
      source: 'lrclib',
      customized: false,
    });
    expect(getLyrics(db, 'song-1')?.offsetMs).toBe(0);
  });

  it('carries an offset over only when the caller asks explicitly', () => {
    setLyrics(db, 'song-1', { ...fetched, customized: false, offsetMs: 750 });
    expect(getLyrics(db, 'song-1')?.offsetMs).toBe(750);
  });
});
