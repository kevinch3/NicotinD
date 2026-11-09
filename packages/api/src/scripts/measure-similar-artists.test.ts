import { describe, expect, it } from 'bun:test';
import { fetchSimilar, spreadSample, summarize } from './measure-similar-artists.js';

describe('measure-similar-artists (#1486)', () => {
  it('parses a labs answer and drops the artist itself', async () => {
    const fetchFn = (async () =>
      Response.json([
        { artist_mbid: 'self', name: 'Soda Stereo', score: 999 },
        { artist_mbid: 'cerati', name: 'Gustavo Cerati', score: 881 },
        { name: 'no mbid', score: 1 },
      ])) as unknown as typeof fetch;
    expect(await fetchSimilar('self', fetchFn)).toEqual([
      { mbid: 'cerati', name: 'Gustavo Cerati', score: 881 },
    ]);
  });

  it('reads a failed call as null, never as "no neighbours"', async () => {
    const down = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
    const throws = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(await fetchSimilar('x', down)).toBeNull();
    expect(await fetchSimilar('x', throws)).toBeNull();
  });

  it('summarizes coverage, in-library share and the score scale', () => {
    const s = (mbid: string, score: number) => ({ mbid, name: mbid, score });
    const summary = summarize(
      [
        { mbid: 'a', results: [s('owned1', 900), s('stranger', 500)] },
        { mbid: 'b', results: [s('stranger2', 40)] },
        { mbid: 'c', results: [] },
        { mbid: 'd', results: null },
      ],
      new Set(['owned1']),
    );
    expect(summary).toMatchObject({
      sampled: 4,
      failed: 1,
      withResults: 2,
      coveragePct: 66.7,
      inLibraryPct: 33.3,
      usableForRadioPct: 33.3,
      topScore: { p50: 900 },
    });
  });

  it('samples the same spread every run', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    expect(spreadSample(items, 3)).toEqual([0, 3, 6]);
    expect(spreadSample(items, 20)).toHaveLength(10);
  });
});
