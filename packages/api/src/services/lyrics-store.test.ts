import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { LYRICS_OFFSET_MAX_MS, type LyricsChoice } from '@nicotind/core';
import {
  getLyrics,
  getLyricsExport,
  getLyricsProvenance,
  setLyrics,
  setLyricsOffset,
  deleteLyrics,
} from './lyrics-store.js';
import { libraryEvents, type StampedEvent } from './library-events.js';

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

// The store is the one writer of `library_lyrics` rows a client holds, so emitting here is what
// makes every caller — REST, the fetch path, the MCP tools — reach an open client (#1666).
describe('lyrics-store announces every stored-lyrics change', () => {
  function changedIds(fn: () => void): string[][] {
    libraryEvents.flush();
    const seen: StampedEvent[] = [];
    const off = libraryEvents.on((e) => seen.push(e));
    try {
      fn();
      libraryEvents.flush();
    } finally {
      off();
    }
    return seen
      .map((e) => e.event)
      .filter((e) => e.type === 'lyrics.changed')
      .map((e) => (e as { songIds: string[] }).songIds);
  }
  const row = { plain: 'w', synced: '[00:01.00]w', source: 'lrclib', customized: false };

  it('a save, a re-time and a delete each name the song', () => {
    expect(changedIds(() => setLyrics(db, 'song-1', row))).toEqual([['song-1']]);
    expect(changedIds(() => setLyricsOffset(db, 'song-1', 500))).toEqual([['song-1']]);
    expect(changedIds(() => deleteLyrics(db, 'song-1'))).toEqual([['song-1']]);
  });

  it('a write that changed no row stays silent', () => {
    expect(changedIds(() => setLyricsOffset(db, 'song-nope', 500))).toEqual([]);
    expect(changedIds(() => deleteLyrics(db, 'song-nope'))).toEqual([]);
  });

  it('a burst over several songs is one frame naming each once', () => {
    const ids = changedIds(() => {
      setLyrics(db, 'a', row);
      setLyrics(db, 'b', row);
      setLyricsOffset(db, 'a', 250);
    });
    expect(ids).toEqual([['a', 'b']]);
  });
});

/**
 * #1676: why a candidate was chosen and who corrected it live beside the words,
 * so a song whose lyrics changed is diagnosable from the row — and the origin
 * record survives the user edit that turns `source` into 'user'.
 */
describe('lyrics-store provenance', () => {
  const choice: LyricsChoice = {
    source: 'lrclib',
    sourceTrackId: '42',
    timed: true,
    matchedDurationSec: 201,
    localDurationSec: 200,
    durationDeltaSec: 1,
    matchedBy: 'exact',
    skippedUntimed: [],
    replacedOtherTake: false,
    forced: false,
    at: 1,
  };
  const fetched = {
    plain: 'words',
    synced: '[00:01.00]words',
    source: 'lrclib',
    customized: false,
    sourceTrackId: '42',
    choice,
  };
  beforeEach(() => {
    db.run(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'ana', 'h')`);
  });

  it('stores why a fetched candidate was chosen', () => {
    setLyrics(db, 'song-1', fetched);
    const p = getLyricsProvenance(db, 'song-1');
    expect(p?.choice).toEqual(choice);
    expect(p?.customized).toBe(false);
    expect(p?.customizedBy).toBeNull();
  });

  it('a user edit keeps the origin choice and records who and when', () => {
    setLyrics(db, 'song-1', fetched);
    const saved = setLyrics(db, 'song-1', {
      plain: 'fixed',
      synced: null,
      source: 'user',
      customized: true,
      actor: 'u1',
    });
    const p = getLyricsProvenance(db, 'song-1')!;
    expect(p.source).toBe('user');
    expect(p.sourceTrackId).toBeNull();
    expect(p.choice).toEqual(choice);
    expect(p.customizedBy).toEqual({ userId: 'u1', username: 'ana' });
    expect(p.customizedAt).toBe(saved.updatedAt);
  });

  it('a later fetch replaces the choice and clears the editor', () => {
    setLyrics(db, 'song-1', { ...fetched, customized: true, source: 'user', actor: 'u1' });
    const next = { ...choice, sourceTrackId: '43', matchedBy: 'search' };
    setLyrics(db, 'song-1', { ...fetched, choice: next });
    const p = getLyricsProvenance(db, 'song-1')!;
    expect(p.choice).toEqual(next);
    expect(p.customizedBy).toBeNull();
    expect(p.customizedAt).toBeNull();
  });

  it('a removed account keeps its id and loses only its name', () => {
    setLyrics(db, 'song-1', { ...fetched, customized: true, actor: 'gone' });
    expect(getLyricsProvenance(db, 'song-1')?.customizedBy).toEqual({
      userId: 'gone',
      username: null,
    });
  });

  it('records who set the offset, and forgets it with the offset when the text changes', () => {
    setLyrics(db, 'song-1', fetched);
    const saved = setLyricsOffset(db, 'song-1', 500, 'u1')!;
    let p = getLyricsProvenance(db, 'song-1')!;
    expect(p.offsetBy).toEqual({ userId: 'u1', username: 'ana' });
    expect(p.offsetAt).toBe(saved.updatedAt);

    setLyrics(db, 'song-1', { ...fetched, synced: '[00:02.00]new' });
    p = getLyricsProvenance(db, 'song-1')!;
    expect(p.offsetBy).toBeNull();
    expect(p.offsetAt).toBeNull();
  });

  it('an offset carried over explicitly keeps its author', () => {
    setLyrics(db, 'song-1', fetched);
    setLyricsOffset(db, 'song-1', 500, 'u1');
    setLyrics(db, 'song-1', { ...fetched, offsetMs: 500 });
    expect(getLyricsProvenance(db, 'song-1')?.offsetBy?.userId).toBe('u1');
  });

  it('is null for a song with no lyrics', () => {
    expect(getLyricsProvenance(db, 'song-1')).toBeNull();
  });
});

describe('lyrics-store export (#1676)', () => {
  function seedSong(id: string, duration = 200): void {
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, synced_at) VALUES ('al1', 'Huija', 'LP', 'a1', 0)`,
    );
    db.run(
      `INSERT INTO library_songs
        (id, album_id, title, artist, artist_id, duration, path,
         size, bit_rate, suffix, content_type, created, synced_at)
       VALUES (?, 'al1', 'Selva', 'La Portuaria', 'a1', ?, 'p.flac', 1, 1, 'flac', 'audio/flac', '2024', 0)`,
      [id, duration],
    );
  }
  const row = {
    plain: 'w',
    synced: '[00:01.00]w\n[00:02.00]x',
    source: 'lrclib',
    customized: false,
  };

  it('bakes the stored offset into the LRC and says how much', () => {
    seedSong('song-1');
    setLyrics(db, 'song-1', row);
    setLyricsOffset(db, 'song-1', 750);
    const e = getLyricsExport(db, 'song-1')!;
    expect(e.synced).toBe('[00:01.75]w\n[00:02.75]x');
    expect(e.offsetAppliedMs).toBe(750);
    expect(e.corrected).toBe(true);
    expect(e).toMatchObject({
      songId: 'song-1',
      title: 'Selva',
      artist: 'La Portuaria',
      album: 'Huija',
      durationSec: 200,
      plain: 'w',
    });
    // The stored text is untouched: the export is a view, not a rewrite.
    expect(getLyrics(db, 'song-1')?.synced).toBe(row.synced);
  });

  it('an uncorrected fetched row exports verbatim and is not `corrected`', () => {
    seedSong('song-1');
    setLyrics(db, 'song-1', row);
    const e = getLyricsExport(db, 'song-1')!;
    expect(e.synced).toBe(row.synced);
    expect(e.offsetAppliedMs).toBe(0);
    expect(e.corrected).toBe(false);
  });

  it('a user-edited plain row is `corrected` with nothing to bake', () => {
    seedSong('song-1');
    setLyrics(db, 'song-1', { ...row, synced: null, customized: true, source: 'user' });
    const e = getLyricsExport(db, 'song-1')!;
    expect(e.synced).toBeNull();
    expect(e.offsetAppliedMs).toBe(0);
    expect(e.corrected).toBe(true);
  });

  it('is null without a row, or without the song', () => {
    seedSong('song-1');
    expect(getLyricsExport(db, 'song-1')).toBeNull();
    setLyrics(db, 'orphan', row);
    expect(getLyricsExport(db, 'orphan')).toBeNull();
  });
});

describe('library_lyrics provenance migration (#1676)', () => {
  it('adds the columns to a pre-#1676 table without touching its rows', () => {
    const old = new Database(':memory:');
    old.run(`
      CREATE TABLE library_lyrics (
        song_id TEXT PRIMARY KEY, plain_text TEXT, synced_text TEXT, source TEXT,
        customized INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        matched_duration INTEGER, source_id TEXT, offset_ms INTEGER NOT NULL DEFAULT 0
      )`);
    old.run(
      `INSERT INTO library_lyrics VALUES ('s1', 'w', '[00:01.00]w', 'lrclib', 1, 5, 200, '9', 250)`,
    );
    applySchema(old);
    applySchema(old);
    expect(getLyrics(old, 's1')).toMatchObject({
      plain: 'w',
      synced: '[00:01.00]w',
      customized: true,
      offsetMs: 250,
      sourceTrackId: '9',
    });
    // Unknown, never invented: nobody recorded a choice or an editor for this row.
    expect(getLyricsProvenance(old, 's1')).toMatchObject({
      choice: null,
      customizedBy: null,
      customizedAt: null,
      offsetBy: null,
      offsetAt: null,
    });
    old.close();
  });
});
