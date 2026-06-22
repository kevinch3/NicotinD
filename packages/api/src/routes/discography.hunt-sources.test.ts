import { describe, it, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';
import { discographyRoutes } from './discography.js';
import type { DiscographyService } from '../services/discography.service.js';
import type { AlbumHunterService } from '../services/album-hunter.service.js';
import { AlbumHuntOrchestrator, type SourceHunter } from '../services/source-hunter.js';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { SlskdRef } from '../index.js';
import type { AcquisitionCandidate } from '@nicotind/core';

const lidarr = () =>
  ({
    album: { get: mock(async () => ({ id: 1, title: 'Porfiado', artist: { artistName: 'El Cuarteto de Nos' } })) },
  }) as unknown as Lidarr;

const hunter = (id: string, out: AcquisitionCandidate[]): SourceHunter => ({
  id,
  huntAlbum: async () => out,
});

const cand = (source: string, url: string, score: number): AcquisitionCandidate => ({
  source,
  sourceLabel: source,
  kind: 'album',
  title: 'Porfiado',
  score,
  acquire: { via: 'url', url },
});

function makeApp(sourceHunt: AlbumHuntOrchestrator) {
  const db = new Database(':memory:');
  applySchema(db);
  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub: 'u', role: 'admin', iat: 0, exp: 9999999999 });
    return next();
  });
  app.route(
    '/',
    discographyRoutes({
      discography: {} as DiscographyService,
      hunter: {} as AlbumHunterService,
      sourceHunt,
      lidarr: lidarr(),
      db,
      slskdRef: { current: null } as SlskdRef,
    }),
  );
  return app;
}

const post = (app: Hono<AuthEnv>) =>
  app.request('/albums/1/hunt/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

describe('POST /albums/:id/hunt/sources', () => {
  it('returns a blended candidate list from enabled sources', async () => {
    const orch = new AlbumHuntOrchestrator(
      [hunter('archive', [cand('archive', 'u1', 40)]), hunter('spotify', [cand('spotify', 'u2', 90)])],
      () => true,
    );
    const res = await post(makeApp(orch));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: AcquisitionCandidate[]; sources: string[] };
    expect(body.candidates.map((c) => c.source)).toEqual(['spotify', 'archive']);
    expect(body.sources.sort()).toEqual(['archive', 'spotify']);
  });

  it('returns an empty blend (not an error) when all sources are disabled', async () => {
    const orch = new AlbumHuntOrchestrator([hunter('archive', [cand('archive', 'u1', 40)])], () => false);
    const res = await post(makeApp(orch));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: AcquisitionCandidate[]; sources: string[] };
    expect(body.candidates).toEqual([]);
    expect(body.sources).toEqual([]);
  });
});
