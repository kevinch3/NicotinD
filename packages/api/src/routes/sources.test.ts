import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { sourcesRoutes } from './sources.js';
import {
  CandidateSearchAggregator,
  type CandidateSource,
} from '../services/candidate-search.js';
import type { AcquisitionCandidate } from '@nicotind/core';

const cand = (source: string, url: string, score: number): AcquisitionCandidate => ({
  source,
  sourceLabel: source,
  kind: 'album',
  title: 't',
  score,
  acquire: { via: 'url', url },
});

function mount(sources: CandidateSource[], isEnabled: (id: string) => boolean) {
  const aggregator = new CandidateSearchAggregator(sources, isEnabled);
  const app = new Hono<AuthEnv>();
  app.route('/api/sources', sourcesRoutes({ aggregator }));
  return app;
}

describe('GET /api/sources/search', () => {
  it('400s without q', async () => {
    const app = mount([], () => true);
    const res = await app.request('/api/sources/search');
    expect(res.status).toBe(400);
  });

  it('returns a blended candidate list + enabled source ids', async () => {
    const app = mount(
      [
        { id: 'archive', search: async () => [cand('archive', 'u1', 40)] },
        { id: 'spotify', search: async () => [cand('spotify', 'u2', 90)] },
      ],
      () => true,
    );
    const res = await app.request('/api/sources/search?q=porfiado');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: AcquisitionCandidate[]; sources: string[] };
    expect(body.candidates.map((c) => c.source)).toEqual(['spotify', 'archive']);
    expect(body.sources.sort()).toEqual(['archive', 'spotify']);
  });

  it('returns an empty blend when sources are disabled', async () => {
    const app = mount([{ id: 'archive', search: async () => [cand('archive', 'u1', 40)] }], () => false);
    const res = await app.request('/api/sources/search?q=x');
    const body = (await res.json()) as { candidates: AcquisitionCandidate[]; sources: string[] };
    expect(body.candidates).toEqual([]);
    expect(body.sources).toEqual([]);
  });
});
