import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Song } from '@nicotind/core';
import { applySchema } from '../db.js';
import type { GeneratedScenario } from './radio-poll-generate.js';
import {
  MAX_RATERS_PER_POLL,
  RadioPollRaterCapError,
  RadioPollVoteError,
  closePoll,
  createPoll,
  deletePoll,
  getPollByToken,
  listPollSummaries,
  listScenarios,
  pollResults,
  pollStatus,
  publicPollView,
  recordVotes,
} from './radio-poll-store.js';

let db: Database;

function song(id: string): Song {
  return {
    id,
    title: `Title ${id}`,
    album: 'Album',
    albumId: 'alb',
    artist: `Artist ${id}`,
    artistId: `art-${id}`,
    coverArt: `cover-${id}`,
    size: 0,
    contentType: 'audio/mpeg',
    suffix: 'mp3',
    duration: 200,
    bitRate: 320,
    path: `/music/${id}.mp3`,
    created: '2024-01-01',
  };
}

function scenario(id: string, position: number, candidateIds: string[]): GeneratedScenario {
  return {
    id,
    position,
    kind: 'seed',
    seedSongId: `seed-${id}`,
    snapshot: {
      kind: 'seed',
      seed: { song: song(`seed-${id}`), features: { duration: 200, artistId: 'a' } },
      weights: { genre: 18 },
      candidates: candidateIds.map((cid, i) => ({
        song: song(cid),
        features: { duration: 200, artistId: `art-${cid}` },
        score: 1 - i * 0.1,
        rank: i + 1,
        displayOrder: i + 1,
        explanation: {
          score: 1 - i * 0.1,
          axes: [{ axis: 'genre', value: 1, weight: 18, contribution: 18 }],
          skipped: [],
          floored: [],
          artistPenaltyApplied: false,
          recentPlayPenaltyApplied: 0,
        },
      })),
    },
  };
}

function makePoll(scenarios?: GeneratedScenario[]): { id: string; token: string } {
  db.run("INSERT INTO users (id, username, password_hash) VALUES ('u1','admin','x')");
  return createPoll(db, {
    name: 'Test poll',
    createdBy: 'u1',
    settings: { scenarioCount: 2, nextUpCount: 2 },
    engineVersion: '0.1.0',
    scenarios: scenarios ?? [scenario('sc1', 0, ['c1', 'c2']), scenario('sc2', 1, ['c3', 'c4'])],
  });
}

const VOTE = { scenarioId: 'sc1', candidateSongId: 'c1', verdict: 'up' as const };
const RATER = 'rater-device-1';

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('createPoll / getPollByToken / listScenarios', () => {
  it('persists the poll and its frozen scenarios', () => {
    const { token } = makePoll();
    const poll = getPollByToken(db, token);
    expect(poll).not.toBeNull();
    expect(poll!.name).toBe('Test poll');
    const scenarios = listScenarios(db, poll!.id);
    expect(scenarios).toHaveLength(2);
    expect(scenarios[0]!.snapshot.candidates.map((c) => c.song.id)).toEqual(['c1', 'c2']);
  });
});

describe('pollStatus', () => {
  it('discriminates open / closed / expired', () => {
    expect(pollStatus({ closed_at: null, expires_at: null })).toBe('open');
    expect(pollStatus({ closed_at: 1, expires_at: null })).toBe('closed');
    expect(pollStatus({ closed_at: null, expires_at: 10 }, 20)).toBe('expired');
    expect(pollStatus({ closed_at: null, expires_at: 30 }, 20)).toBe('open');
    // Closed wins over expired — the admin's explicit action is the truth.
    expect(pollStatus({ closed_at: 1, expires_at: 10 }, 20)).toBe('closed');
  });
});

describe('publicPollView', () => {
  it('strips scores, features and explanations from the rater payload', () => {
    const { token } = makePoll();
    const poll = getPollByToken(db, token)!;
    const view = publicPollView(poll, listScenarios(db, poll.id), { jwt: 'j', expiresAt: 99 });
    expect(view.mediaJwt).toBe('j');
    expect(view.poll.scenarioCount).toBe(2);
    const c = view.scenarios[0]!.candidates[0]! as unknown as Record<string, unknown>;
    expect(c['id']).toBe('c1');
    expect(c['score']).toBeUndefined();
    expect(c['explanation']).toBeUndefined();
    expect(c['features']).toBeUndefined();
    expect(c['rank']).toBeUndefined();
  });

  it('orders candidates by the frozen displayOrder', () => {
    const shuffled = scenario('sc1', 0, ['c1', 'c2']);
    shuffled.snapshot.candidates[0]!.displayOrder = 2;
    shuffled.snapshot.candidates[1]!.displayOrder = 1;
    const { token } = makePoll([shuffled]);
    const poll = getPollByToken(db, token)!;
    const view = publicPollView(poll, listScenarios(db, poll.id), { jwt: 'j', expiresAt: 0 });
    expect(view.scenarios[0]!.candidates.map((c) => c.id)).toEqual(['c2', 'c1']);
  });
});

describe('recordVotes', () => {
  it('records votes and re-voting updates in place (no double count)', () => {
    const { id } = makePoll();
    const first = recordVotes(db, id, { raterKey: RATER, votes: [VOTE] });
    expect(first.recorded).toBe(1);
    recordVotes(db, id, { raterKey: RATER, votes: [{ ...VOTE, verdict: 'down' }] });
    const rows = db
      .query<{ verdict: string; n: number }, []>(
        'SELECT verdict, COUNT(*) AS n FROM radio_poll_votes GROUP BY verdict',
      )
      .all();
    expect(rows).toEqual([{ verdict: 'down', n: 1 }]);
  });

  it('rejects a scenario id from another poll', () => {
    const { id } = makePoll();
    expect(() =>
      recordVotes(db, id, { raterKey: RATER, votes: [{ ...VOTE, scenarioId: 'foreign' }] }),
    ).toThrow(RadioPollVoteError);
  });

  it('rejects a candidate not in the scenario snapshot', () => {
    const { id } = makePoll();
    expect(() =>
      recordVotes(db, id, { raterKey: RATER, votes: [{ ...VOTE, candidateSongId: 'c3' }] }),
    ).toThrow(RadioPollVoteError);
  });

  it('rejects bad verdicts, short rater keys and oversize notes', () => {
    const { id } = makePoll();
    expect(() =>
      recordVotes(db, id, {
        raterKey: RATER,
        votes: [{ ...VOTE, verdict: 'meh' as unknown as 'up' }],
      }),
    ).toThrow(RadioPollVoteError);
    expect(() => recordVotes(db, id, { raterKey: 'short', votes: [VOTE] })).toThrow(
      RadioPollVoteError,
    );
    expect(() =>
      recordVotes(db, id, { raterKey: RATER, votes: [{ ...VOTE, note: 'x'.repeat(501) }] }),
    ).toThrow(RadioPollVoteError);
    expect(() => recordVotes(db, id, { raterKey: RATER, votes: [] })).toThrow(RadioPollVoteError);
  });

  it('caps the vote batch at the poll candidate count', () => {
    const { id } = makePoll();
    const votes = Array.from({ length: 5 }, () => VOTE);
    expect(() => recordVotes(db, id, { raterKey: RATER, votes })).toThrow(RadioPollVoteError);
  });

  it('refuses a NEW rater past the cap but lets an existing one re-vote', () => {
    const { id } = makePoll([scenario('sc1', 0, ['c1'])]);
    // Simulate a full poll without inserting 1000 raters one write at a time.
    const insert = db.transaction(() => {
      for (let i = 0; i < MAX_RATERS_PER_POLL; i++) {
        db.run(
          `INSERT INTO radio_poll_votes (scenario_id, rater_key, candidate_song_id, verdict, at)
           VALUES ('sc1', ?, 'c1', 'up', 0)`,
          [`bulk-rater-${i}`],
        );
      }
    });
    insert();
    expect(() => recordVotes(db, id, { raterKey: 'a-brand-new-rater', votes: [VOTE] })).toThrow(
      RadioPollRaterCapError,
    );
    const ok = recordVotes(db, id, {
      raterKey: 'bulk-rater-0',
      votes: [{ ...VOTE, verdict: 'down' }],
    });
    expect(ok.recorded).toBe(1);
  });
});

describe('pollResults / listPollSummaries', () => {
  it('joins per-candidate tallies onto the frozen snapshots', () => {
    const { id } = makePoll();
    recordVotes(db, id, {
      raterKey: RATER,
      votes: [
        { scenarioId: 'sc1', candidateSongId: 'c1', verdict: 'up' },
        { scenarioId: 'sc1', candidateSongId: 'c2', verdict: 'down' },
      ],
    });
    recordVotes(db, id, {
      raterKey: 'rater-device-2',
      votes: [{ scenarioId: 'sc1', candidateSongId: 'c1', verdict: 'up' }],
    });
    const results = pollResults(db, getPollByToken(db, listPollSummaries(db)[0]!.token)!);
    const sc1 = results.scenarios[0]!;
    expect(sc1.candidates.find((c) => c.song.id === 'c1')).toMatchObject({ up: 2, down: 0 });
    expect(sc1.candidates.find((c) => c.song.id === 'c2')).toMatchObject({ up: 0, down: 1 });
    // Snapshot detail (the diagnosis surface) is preserved on results.
    expect(sc1.candidates[0]!.explanation.axes[0]!.axis).toBe('genre');
    expect(results.poll.voteCount).toBe(3);
    expect(results.poll.raterCount).toBe(2);
  });

  it('summaries carry counts and newest-first ordering', () => {
    makePoll();
    const summaries = listPollSummaries(db);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.scenarioCount).toBe(2);
    expect(summaries[0]!.voteCount).toBe(0);
  });
});

describe('closePoll / deletePoll', () => {
  it('close is idempotent-safe and reported', () => {
    const { id, token } = makePoll();
    expect(closePoll(db, id, 123)).toBe(true);
    expect(getPollByToken(db, token)!.closed_at).toBe(123);
    expect(closePoll(db, id)).toBe(false);
  });

  it('delete removes scenarios and votes with the poll', () => {
    const { id } = makePoll();
    recordVotes(db, id, { raterKey: RATER, votes: [VOTE] });
    expect(deletePoll(db, id)).toBe(true);
    expect(db.query('SELECT COUNT(*) AS n FROM radio_poll_scenarios').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM radio_poll_votes').get()).toEqual({ n: 0 });
    expect(deletePoll(db, id)).toBe(false);
  });
});
