import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../db.js';
import { recordPlayEvents } from '../play-history.js';
import { SKIP_RULE, excludedSongIds, excludedSongs, recordFeedback } from './feedback-store.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 3_600_000;

function db(): Database {
  const d = new Database(':memory:');
  applySchema(d);
  d.run(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'u1', 'x')`);
  return d;
}

let seq = 0;
function skip(d: Database, songId: string, at: number, msPlayed = 5_000): void {
  recordPlayEvents(d, 'u1', [
    {
      clientEventId: `e${++seq}`,
      songId,
      title: songId,
      artist: 'A',
      album: null,
      startedAt: at,
      msPlayed,
      durationMs: 240_000,
      reason: 'skipped',
      source: 'radio',
      device: 'web',
    },
  ]);
}
function fullPlay(d: Database, songId: string, at: number): void {
  recordPlayEvents(d, 'u1', [
    {
      clientEventId: `e${++seq}`,
      songId,
      title: songId,
      artist: 'A',
      album: null,
      startedAt: at,
      msPlayed: 240_000,
      durationMs: 240_000,
      reason: 'ended',
      source: 'radio',
      device: 'web',
    },
  ]);
}

describe('explicit feedback', () => {
  it('exclude adds the song; a later restore removes it; a later exclude re-adds it', () => {
    const d = db();
    recordFeedback(d, { userId: 'u1', songId: 's1', kind: 'exclude', now: NOW });
    expect([...excludedSongIds(d, 'u1', NOW)]).toEqual(['s1']);
    recordFeedback(d, { userId: 'u1', songId: 's1', kind: 'restore', now: NOW + 1 });
    expect(excludedSongIds(d, 'u1', NOW + 2).size).toBe(0);
    recordFeedback(d, { userId: 'u1', songId: 's1', kind: 'exclude', now: NOW + 3 });
    expect(excludedSongs(d, 'u1', NOW + 4)).toEqual([
      { songId: 's1', reason: 'explicit', since: NOW + 3 },
    ]);
  });

  it('variety votes are logged but never exclude', () => {
    const d = db();
    recordFeedback(d, {
      userId: 'u1',
      songId: 's1',
      kind: 'too_similar',
      now: NOW,
      context: { to: 'different' },
    });
    recordFeedback(d, { userId: 'u1', songId: 's1', kind: 'too_different', now: NOW });
    expect(excludedSongIds(d, 'u1', NOW).size).toBe(0);
    const row = d
      .query<{ context_json: string }, []>(
        `SELECT context_json FROM recommendation_feedback WHERE kind = 'too_similar'`,
      )
      .get();
    expect(JSON.parse(row!.context_json)).toEqual({ to: 'different' });
  });

  it('is per listener', () => {
    const d = db();
    d.run(`INSERT INTO users (id, username, password_hash) VALUES ('u2', 'u2', 'x')`);
    recordFeedback(d, { userId: 'u1', songId: 's1', kind: 'exclude', now: NOW });
    expect(excludedSongIds(d, 'u2', NOW).size).toBe(0);
  });
});

describe('derived skips (SKIP_RULE)', () => {
  it(`holds a song out after ${SKIP_RULE.minSkips} early skips inside the window`, () => {
    const d = db();
    skip(d, 's1', NOW - DAY);
    expect(excludedSongIds(d, 'u1', NOW).size).toBe(0);
    skip(d, 's1', NOW - 3_600_000);
    expect(excludedSongs(d, 'u1', NOW)).toEqual([
      { songId: 's1', reason: 'skips', since: NOW - 3_600_000, skips: 2 },
    ]);
  });

  it('a skip after hearing most of the track is not an early skip', () => {
    const d = db();
    skip(d, 's1', NOW - DAY, SKIP_RULE.maxMsPlayed);
    skip(d, 's1', NOW - 3_600_000, SKIP_RULE.maxMsPlayed + 1);
    expect(excludedSongIds(d, 'u1', NOW).size).toBe(0);
  });

  it('skips older than the window are forgotten', () => {
    const d = db();
    skip(d, 's1', NOW - SKIP_RULE.windowMs - 1);
    skip(d, 's1', NOW - DAY);
    expect(excludedSongIds(d, 'u1', NOW).size).toBe(0);
  });

  it('a counted play after the last skip cancels the derived exclusion', () => {
    const d = db();
    skip(d, 's1', NOW - 2 * DAY);
    skip(d, 's1', NOW - DAY);
    fullPlay(d, 's1', NOW - 3_600_000);
    expect(excludedSongIds(d, 'u1', NOW).size).toBe(0);
    // ...but a counted play BEFORE the skips does not.
    const d2 = db();
    fullPlay(d2, 's1', NOW - 3 * DAY);
    skip(d2, 's1', NOW - 2 * DAY);
    skip(d2, 's1', NOW - DAY);
    expect([...excludedSongIds(d2, 'u1', NOW)]).toEqual(['s1']);
  });

  it('an explicit restore after the skips beats the derived rule; an older one does not', () => {
    const d = db();
    skip(d, 's1', NOW - 2 * DAY);
    skip(d, 's1', NOW - DAY);
    recordFeedback(d, { userId: 'u1', songId: 's1', kind: 'restore', now: NOW - 3_600_000 });
    expect(excludedSongIds(d, 'u1', NOW).size).toBe(0);
    skip(d, 's1', NOW - 60_000);
    skip(d, 's1', NOW - 30_000);
    expect([...excludedSongIds(d, 'u1', NOW)]).toEqual(['s1']);
  });

  it('an explicit exclude reports as explicit even when the skips also qualify', () => {
    const d = db();
    skip(d, 's1', NOW - 2 * DAY);
    skip(d, 's1', NOW - DAY);
    recordFeedback(d, { userId: 'u1', songId: 's1', kind: 'exclude', now: NOW - 100 });
    expect(excludedSongs(d, 'u1', NOW)).toEqual([
      { songId: 's1', reason: 'explicit', since: NOW - 100 },
    ]);
  });
});
