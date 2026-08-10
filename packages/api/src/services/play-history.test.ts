import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  MAX_EVENTS_PER_BATCH,
  MIN_TRACK_MS,
  countsAsPlay,
  lastPlayedAtMap,
  playEventCount,
  recentPlays,
  recordPlayEvents,
  type PlayEventInput,
} from './play-history.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(`INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'ana', 'h', 'user')`);
  db.run(`INSERT INTO users (id, username, password_hash, role) VALUES ('u2', 'bo', 'h', 'user')`);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at, hidden)
     VALUES ('al', 'Album', 'Artist', 'art', 1, 0, 1, 0)`,
  );
});

/** Recently-played joins the live library, so a play needs a real song row. */
function seedSong(
  id: string,
  over: { title?: string; hidden?: number; landed?: number } = {},
): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size,
                                created, synced_at, hidden, landed_at)
     VALUES (?, 'al', ?, 'Artist', 'art', 180, ?, 100, '2024-01-01', 1, ?, ?)`,
    [id, over.title ?? id, `Artist/Album/${id}.opus`, over.hidden ?? 0, over.landed ?? 1],
  );
}

let seq = 0;
function event(over: Partial<PlayEventInput> = {}): PlayEventInput {
  seq += 1;
  return {
    clientEventId: `evt-${seq}`,
    songId: 'song1',
    startedAt: 1_700_000_000_000,
    msPlayed: 200_000,
    durationMs: 300_000,
    reason: 'ended',
    source: 'album',
    device: 'browser',
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    ...over,
  };
}

describe('countsAsPlay', () => {
  it('needs half the track', () => {
    expect(countsAsPlay(149_000, 300_000)).toBe(false);
    expect(countsAsPlay(150_000, 300_000)).toBe(true);
  });

  it('caps the requirement at four minutes for long tracks', () => {
    // A 20-minute track: half would be 10 min, but 4 min is enough.
    expect(countsAsPlay(239_000, 1_200_000)).toBe(false);
    expect(countsAsPlay(240_000, 1_200_000)).toBe(true);
  });

  it('never counts a track shorter than the floor', () => {
    expect(countsAsPlay(29_000, 29_000)).toBe(false);
    expect(countsAsPlay(MIN_TRACK_MS, MIN_TRACK_MS)).toBe(true);
  });

  it('falls back to the four-minute rule when duration is unknown', () => {
    expect(countsAsPlay(239_000, null)).toBe(false);
    expect(countsAsPlay(240_000, null)).toBe(true);
  });

  it('rejects nonsense input rather than throwing', () => {
    expect(countsAsPlay(-5, 300_000)).toBe(false);
    expect(countsAsPlay(200_000, 0)).toBe(false);
    expect(countsAsPlay(Number.NaN, 300_000)).toBe(false);
  });
});

describe('recordPlayEvents', () => {
  it('stores an event and derives `counted` server-side', () => {
    const res = recordPlayEvents(db, 'u1', [event({ msPlayed: 200_000, durationMs: 300_000 })]);
    expect(res).toEqual({ inserted: 1, duplicates: 0, rejected: 0 });

    const row = db
      .query<{ counted: number; user_id: string; ms_played: number; reason: string }, []>(
        `SELECT counted, user_id, ms_played, reason FROM play_events`,
      )
      .get();
    expect(row).toMatchObject({ counted: 1, user_id: 'u1', ms_played: 200_000, reason: 'ended' });
  });

  it('stores a skip as an event that did not count', () => {
    recordPlayEvents(db, 'u1', [event({ msPlayed: 8_000, reason: 'skipped' })]);
    const row = db.query<{ counted: number }, []>(`SELECT counted FROM play_events`).get();
    expect(row?.counted).toBe(0);
  });

  it('is idempotent on clientEventId so a flush retry cannot double-count', () => {
    const e = event();
    expect(recordPlayEvents(db, 'u1', [e])).toMatchObject({ inserted: 1, duplicates: 0 });
    expect(recordPlayEvents(db, 'u1', [e])).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(playEventCount(db)).toBe(1);
  });

  it('dedupes repeats within a single batch', () => {
    const e = event();
    const res = recordPlayEvents(db, 'u1', [e, e]);
    expect(res).toMatchObject({ inserted: 1, duplicates: 1 });
  });

  it('clamps a hostile msPlayed to the track duration', () => {
    recordPlayEvents(db, 'u1', [event({ msPlayed: 99_999_999, durationMs: 300_000 })]);
    const row = db.query<{ ms_played: number }, []>(`SELECT ms_played FROM play_events`).get();
    expect(row?.ms_played).toBe(300_000);
  });

  it('rejects an event with no song id instead of storing a useless row', () => {
    const res = recordPlayEvents(db, 'u1', [event({ songId: '' })]);
    expect(res).toMatchObject({ inserted: 0, rejected: 1 });
    expect(playEventCount(db)).toBe(0);
  });

  it('rejects an unknown reason', () => {
    const res = recordPlayEvents(db, 'u1', [event({ reason: 'wat' as PlayEventInput['reason'] })]);
    expect(res).toMatchObject({ inserted: 0, rejected: 1 });
  });

  it('caps the batch size', () => {
    const many = Array.from({ length: MAX_EVENTS_PER_BATCH + 10 }, () => event());
    const res = recordPlayEvents(db, 'u1', many);
    expect(res.inserted).toBe(MAX_EVENTS_PER_BATCH);
  });

  it('attributes to the caller, ignoring any user id in the payload', () => {
    recordPlayEvents(db, 'u2', [
      event({ ...({ userId: 'u1' } as unknown as Partial<PlayEventInput>) }),
    ]);
    const row = db.query<{ user_id: string }, []>(`SELECT user_id FROM play_events`).get();
    expect(row?.user_id).toBe('u2');
  });

  it('keeps the track metadata snapshot so history survives a re-mint', () => {
    recordPlayEvents(db, 'u1', [event({ title: 'Idolo', artist: 'C. Tangana' })]);
    const row = db
      .query<{ title: string; artist: string }, []>(`SELECT title, artist FROM play_events`)
      .get();
    expect(row).toMatchObject({ title: 'Idolo', artist: 'C. Tangana' });
  });
});

describe('recentPlays', () => {
  it('returns the caller’s counted plays, newest first, one row per track', () => {
    seedSong('a', { title: 'A' });
    seedSong('b', { title: 'B' });
    recordPlayEvents(db, 'u1', [
      event({ songId: 'a', startedAt: 1_000, title: 'A' }),
      event({ songId: 'b', startedAt: 2_000, title: 'B' }),
      event({ songId: 'a', startedAt: 3_000, title: 'A' }),
    ]);

    const rows = recentPlays(db, 'u1', 10);
    expect(rows.map((r) => r.songId)).toEqual(['a', 'b']);
    expect(rows[0]).toMatchObject({ title: 'A', album: 'Album', duration: 180, playedAt: 3_000 });
  });

  it('never leaks another user’s history', () => {
    seedSong('mine');
    seedSong('theirs');
    recordPlayEvents(db, 'u1', [event({ songId: 'mine' })]);
    recordPlayEvents(db, 'u2', [event({ songId: 'theirs' })]);
    expect(recentPlays(db, 'u1', 10).map((r) => r.songId)).toEqual(['mine']);
  });

  it('omits skips — a track you skipped is not something you listened to', () => {
    seedSong('skipped');
    recordPlayEvents(db, 'u1', [event({ songId: 'skipped', msPlayed: 3_000, reason: 'skipped' })]);
    expect(recentPlays(db, 'u1', 10)).toEqual([]);
  });

  it('prefers the live title, so a retag is reflected on the shelf', () => {
    seedSong('a', { title: 'Corrected Title' });
    recordPlayEvents(db, 'u1', [event({ songId: 'a', title: 'Old Typo' })]);
    expect(recentPlays(db, 'u1', 10)[0]?.title).toBe('Corrected Title');
  });

  it('drops a song that no longer exists — the shelf exists to be tapped', () => {
    seedSong('live');
    recordPlayEvents(db, 'u1', [
      event({ songId: 'live', startedAt: 1_000 }),
      event({ songId: 'deleted', startedAt: 2_000 }),
    ]);
    expect(recentPlays(db, 'u1', 10).map((r) => r.songId)).toEqual(['live']);
    // ...but the raw log keeps it, which is what a year review reads.
    expect(playEventCount(db)).toBe(2);
  });

  it('drops hidden and still-quarantined songs', () => {
    seedSong('hidden', { hidden: 1 });
    seedSong('quarantined', { landed: 0 as unknown as number });
    db.run(`UPDATE library_songs SET landed_at = NULL WHERE id = 'quarantined'`);
    recordPlayEvents(db, 'u1', [event({ songId: 'hidden' }), event({ songId: 'quarantined' })]);
    expect(recentPlays(db, 'u1', 10)).toEqual([]);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 5; i += 1) seedSong(`s${i}`);
    recordPlayEvents(
      db,
      'u1',
      Array.from({ length: 5 }, (_, i) => event({ songId: `s${i}`, startedAt: 1_000 + i })),
    );
    expect(recentPlays(db, 'u1', 3)).toHaveLength(3);
  });
});

describe('lastPlayedAtMap', () => {
  it('returns the most recent play per song, for this user only', () => {
    recordPlayEvents(db, 'u1', [
      event({ songId: 'a', startedAt: 1_000 }),
      event({ songId: 'a', startedAt: 5_000 }),
      event({ songId: 'b', startedAt: 2_000 }),
    ]);
    recordPlayEvents(db, 'u2', [event({ songId: 'a', startedAt: 9_999 })]);

    const map = lastPlayedAtMap(db, 'u1', ['a', 'b']);
    expect(map.get('a')).toBe(5_000);
    expect(map.get('b')).toBe(2_000);
  });

  it('omits songs this user never played', () => {
    recordPlayEvents(db, 'u1', [event({ songId: 'a' })]);
    expect(lastPlayedAtMap(db, 'u1', ['a', 'never']).has('never')).toBe(false);
  });

  it('counts a skip too — starting a track still means you just heard it', () => {
    recordPlayEvents(db, 'u1', [
      event({ songId: 'a', startedAt: 3_000, msPlayed: 2_000, reason: 'skipped' }),
    ]);
    expect(lastPlayedAtMap(db, 'u1', ['a']).get('a')).toBe(3_000);
  });

  it('handles an empty id list without querying', () => {
    expect(lastPlayedAtMap(db, 'u1', []).size).toBe(0);
  });

  it('chunks past SQLite’s variable limit', () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `s${i}`);
    recordPlayEvents(db, 'u1', [event({ songId: 's1199', startedAt: 7_000 })]);
    const map = lastPlayedAtMap(db, 'u1', ids);
    expect(map.get('s1199')).toBe(7_000);
  });
});
