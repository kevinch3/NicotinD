import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { consensusVerdict, gradedConsensus, pollExportDataset } from './radio-poll-export.js';
import { createPoll, getPollById, recordVotes } from './radio-poll-store.js';
import type { GeneratedScenario } from './radio-poll-generate.js';
import type { Song } from '@nicotind/core';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('consensusVerdict', () => {
  it('majority up → good, majority down → bad', () => {
    expect(consensusVerdict(3, 1)).toBe('good');
    expect(consensusVerdict(1, 3)).toBe('bad');
  });

  it('tie or zero votes → ungraded (null)', () => {
    expect(consensusVerdict(2, 2)).toBeNull();
    expect(consensusVerdict(0, 0)).toBeNull();
  });
});

function song(id: string): Song {
  return {
    id,
    title: `T ${id}`,
    album: 'Al',
    albumId: 'alb',
    artist: `A ${id}`,
    artistId: `art-${id}`,
    coverArt: id,
    size: 0,
    contentType: 'audio/mpeg',
    suffix: 'mp3',
    duration: 100,
    bitRate: 320,
    path: `/m/${id}.mp3`,
    created: '2024-01-01',
  };
}

function scenario(): GeneratedScenario {
  return {
    id: 'sc1',
    position: 0,
    kind: 'seed',
    seedSongId: 'seed',
    snapshot: {
      kind: 'seed',
      seed: { song: song('seed'), features: { duration: 100, artistId: 'a', genre: 'Rock' } },
      weights: { genre: 18, bpm: 8 },
      candidates: ['c1', 'c2'].map((cid, i) => ({
        song: song(cid),
        features: { duration: 100, artistId: `art-${cid}` },
        score: 0.9 - i * 0.2,
        rank: i + 1,
        displayOrder: i + 1,
        explanation: {
          score: 0.9 - i * 0.2,
          axes: [],
          skipped: [],
          floored: [],
          artistPenaltyApplied: false,
          recentPlayPenaltyApplied: 0,
        },
      })),
    },
  };
}

describe('pollExportDataset', () => {
  it('is a self-contained dataset with tallies, consensus and the weight set', () => {
    db.run("INSERT INTO users (id, username, password_hash) VALUES ('u1','a','x')");
    const { id } = createPoll(db, {
      name: 'Export me',
      createdBy: 'u1',
      settings: { scenarioCount: 1, nextUpCount: 2 },
      engineVersion: '0.1.0',
      scenarios: [scenario()],
    });
    recordVotes(db, id, {
      raterKey: 'rater-one-x',
      votes: [
        { scenarioId: 'sc1', candidateSongId: 'c1', verdict: 'up' },
        { scenarioId: 'sc1', candidateSongId: 'c2', verdict: 'down' },
      ],
    });
    recordVotes(db, id, {
      raterKey: 'rater-two-x',
      votes: [{ scenarioId: 'sc1', candidateSongId: 'c1', verdict: 'up' }],
    });

    const dataset = pollExportDataset(db, getPollById(db, id)!);
    expect(dataset.name).toBe('Export me');
    expect(dataset.engineVersion).toBe('0.1.0');
    expect(dataset.raterCount).toBe(2);
    expect(dataset.voteCount).toBe(3);
    const sc = dataset.scenarios[0]!;
    expect(sc.weights).toEqual({ genre: 18, bpm: 8 });
    expect(sc.seed?.songId).toBe('seed');
    const c1 = sc.candidates.find((c) => c.songId === 'c1')!;
    expect(c1).toMatchObject({ up: 2, down: 0, consensus: 'good', rank: 1 });
    const c2 = sc.candidates.find((c) => c.songId === 'c2')!;
    expect(c2).toMatchObject({ up: 0, down: 1, consensus: 'bad' });
    // The dataset must replay offline: features + explanation ride along.
    expect(c1.features).toBeDefined();
    expect(c1.explanation).toBeDefined();
    // And it must be plain JSON.
    expect(JSON.parse(JSON.stringify(dataset))).toEqual(dataset);
  });
});

describe('stars5 export (issue #800)', () => {
  function starsScenario(): GeneratedScenario {
    const base = scenario();
    base.snapshot.candidates.push({
      ...base.snapshot.candidates[0]!,
      song: song('c3'),
      rank: 3,
      displayOrder: 3,
    });
    return base;
  }

  it('carries voteScale, rating stats and a graded consensus', () => {
    db.run("INSERT INTO users (id, username, password_hash) VALUES ('u1','a','x')");
    const { id } = createPoll(db, {
      name: 'Stars',
      createdBy: 'u1',
      settings: { scenarioCount: 1, nextUpCount: 3, voteScale: 'stars5' },
      scenarios: [starsScenario()],
    });
    recordVotes(db, id, {
      raterKey: 'rater-one-x',
      votes: [
        { scenarioId: 'sc1', candidateSongId: 'c1', rating: 5 },
        { scenarioId: 'sc1', candidateSongId: 'c2', rating: 3 },
      ],
    });
    recordVotes(db, id, {
      raterKey: 'rater-two-x',
      votes: [{ scenarioId: 'sc1', candidateSongId: 'c1', rating: 4 }],
    });

    const dataset = pollExportDataset(db, getPollById(db, id)!);
    expect(dataset.voteScale).toBe('stars5');
    const c1 = dataset.scenarios[0]!.candidates.find((c) => c.songId === 'c1')!;
    expect(c1).toMatchObject({ ratingCount: 2, meanRating: 4.5, ratingCounts: [0, 0, 0, 1, 1] });
    expect(c1.consensus).toBe(gradedConsensus(4.5, 2));
    const c3 = dataset.scenarios[0]!.candidates.find((c) => c.songId === 'c3')!;
    expect(c3).toMatchObject({ ratingCount: 0, meanRating: null, consensus: null });
  });

  it('binary polls export voteScale binary with the old consensus untouched', () => {
    db.run("INSERT INTO users (id, username, password_hash) VALUES ('u1','a','x')");
    const { id } = createPoll(db, {
      name: 'Legacy binary',
      createdBy: 'u1',
      settings: { scenarioCount: 1, nextUpCount: 2 },
      scenarios: [scenario()],
    });
    recordVotes(db, id, {
      raterKey: 'rater-one-x',
      votes: [{ scenarioId: 'sc1', candidateSongId: 'c1', verdict: 'up' }],
    });
    const dataset = pollExportDataset(db, getPollById(db, id)!);
    expect(dataset.voteScale).toBe('binary');
    const c1 = dataset.scenarios[0]!.candidates.find((c) => c.songId === 'c1')!;
    expect(c1).toMatchObject({ up: 1, down: 0, consensus: 'good', ratingCount: 0 });
  });

  it('gradedConsensus grades a mean rating, never a missing one', () => {
    expect(gradedConsensus(null, 0)).toBeNull();
    expect(gradedConsensus(5, 1)).toBe('good');
    expect(gradedConsensus(1, 1)).toBe('bad');
  });
});

describe('formulaVersion in the export dataset (issue #583)', () => {
  it("pre-versioning rows export as '1'; stamped rows keep theirs", () => {
    db.run("INSERT INTO users (id, username, password_hash) VALUES ('uv','av','x')");
    const legacy = createPoll(db, {
      name: 'Legacy',
      createdBy: 'uv',
      settings: { scenarioCount: 1, nextUpCount: 2 },
      scenarios: [scenario()],
    });
    expect(pollExportDataset(db, getPollById(db, legacy.id)!).formulaVersion).toBe('1');

    const v2 = createPoll(db, {
      name: 'V2',
      createdBy: 'uv',
      settings: { scenarioCount: 1, nextUpCount: 2 },
      formulaVersion: '2',
      scenarios: [{ ...scenario(), id: 'sc-v2' }],
    });
    expect(pollExportDataset(db, getPollById(db, v2.id)!).formulaVersion).toBe('2');
  });
});
