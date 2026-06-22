import { describe, expect, it } from 'bun:test';
import type { AcquisitionCandidate } from '@nicotind/core';
import { CandidateSearchAggregator, type CandidateSource } from './candidate-search.js';

const cand = (source: string, title: string, score: number, url: string): AcquisitionCandidate => ({
  source,
  sourceLabel: source,
  kind: 'album',
  title,
  score,
  acquire: { via: 'url', url },
});

const source = (id: string, out: AcquisitionCandidate[] | Error): CandidateSource => ({
  id,
  search: async () => {
    if (out instanceof Error) throw out;
    return out;
  },
});

describe('CandidateSearchAggregator', () => {
  it('blends candidates only from enabled sources', async () => {
    const agg = new CandidateSearchAggregator(
      [
        source('archive', [cand('archive', 'A', 50, 'u1')]),
        source('spotify', [cand('spotify', 'B', 90, 'u2')]),
      ],
      (id) => id === 'spotify', // archive disabled
    );
    const res = await agg.search('q');
    expect(res).toHaveLength(1);
    expect(res[0].source).toBe('spotify');
  });

  it('merges + ranks across multiple enabled sources (best score first)', async () => {
    const agg = new CandidateSearchAggregator(
      [
        source('archive', [cand('archive', 'A', 40, 'u1')]),
        source('spotify', [cand('spotify', 'B', 95, 'u2')]),
      ],
      () => true,
    );
    const res = await agg.search('q');
    expect(res.map((c) => c.source)).toEqual(['spotify', 'archive']);
  });

  it('isolates a failing source (logs + drops, keeps the rest)', async () => {
    const agg = new CandidateSearchAggregator(
      [
        source('archive', new Error('archive.org 503')),
        source('spotify', [cand('spotify', 'B', 90, 'u2')]),
      ],
      () => true,
    );
    const res = await agg.search('q');
    expect(res).toHaveLength(1);
    expect(res[0].source).toBe('spotify');
  });

  it('returns empty when no sources are enabled', async () => {
    const agg = new CandidateSearchAggregator([source('archive', [cand('archive', 'A', 50, 'u1')])], () => false);
    expect(await agg.search('q')).toEqual([]);
    expect(agg.enabledSourceIds()).toEqual([]);
  });
});
