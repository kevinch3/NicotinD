import { describe, expect, it } from 'bun:test';
import {
  AlbumHuntOrchestrator,
  ArchiveAlbumHunter,
  SpotifyAlbumHunter,
  type SourceHunter,
} from './source-hunter.js';
import type { ArchiveSearchService } from './archive-search.service.js';
import type { SpotifySearchService } from './spotify-search.service.js';
import type { AcquisitionCandidate } from '@nicotind/core';

describe('ArchiveAlbumHunter', () => {
  it('maps archive searchAlbum results to candidates', async () => {
    const fake = {
      searchAlbum: async () => [
        {
          identifier: 'p',
          title: 'Porfiado',
          creator: 'El Cuarteto de Nos',
          year: '2012',
          detailsUrl: 'https://archive.org/details/p',
          trackCount: 12,
          kind: 'album' as const,
        },
      ],
    } as unknown as ArchiveSearchService;
    const out = await new ArchiveAlbumHunter(fake).huntAlbum('El Cuarteto de Nos', 'Porfiado');
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('archive');
    expect(out[0].acquire).toEqual({ via: 'url', url: 'https://archive.org/details/p' });
  });
});

describe('SpotifyAlbumHunter', () => {
  it('maps spotify searchAlbum results to candidates', async () => {
    const fake = {
      searchAlbum: async () => [
        {
          id: 'a',
          url: 'https://open.spotify.com/album/a',
          title: 'Porfiado',
          artist: 'El Cuarteto de Nos',
          year: '2012',
          trackCount: 12,
          kind: 'album' as const,
        },
      ],
    } as unknown as SpotifySearchService;
    const out = await new SpotifyAlbumHunter(fake).huntAlbum('El Cuarteto de Nos', 'Porfiado');
    expect(out[0].source).toBe('spotify');
  });
});

const hunter = (id: string, out: AcquisitionCandidate[] | Error): SourceHunter => ({
  id,
  huntAlbum: async () => {
    if (out instanceof Error) throw out;
    return out;
  },
});

const cand = (source: string, url: string, score: number): AcquisitionCandidate => ({
  source,
  sourceLabel: source,
  kind: 'album',
  title: 't',
  score,
  acquire: { via: 'url', url },
});

describe('AlbumHuntOrchestrator', () => {
  it('blends enabled hunters best-first', async () => {
    const orch = new AlbumHuntOrchestrator(
      [hunter('archive', [cand('archive', 'u1', 40)]), hunter('spotify', [cand('spotify', 'u2', 90)])],
      () => true,
    );
    const res = await orch.hunt('a', 'b');
    expect(res.map((c) => c.source)).toEqual(['spotify', 'archive']);
  });

  it('skips disabled hunters', async () => {
    const orch = new AlbumHuntOrchestrator(
      [hunter('archive', [cand('archive', 'u1', 40)]), hunter('spotify', [cand('spotify', 'u2', 90)])],
      (id) => id === 'archive',
    );
    const res = await orch.hunt('a', 'b');
    expect(res.map((c) => c.source)).toEqual(['archive']);
    expect(orch.enabledSourceIds()).toEqual(['archive']);
  });

  it('isolates a failing hunter', async () => {
    const orch = new AlbumHuntOrchestrator(
      [hunter('archive', new Error('boom')), hunter('spotify', [cand('spotify', 'u2', 90)])],
      () => true,
    );
    const res = await orch.hunt('a', 'b');
    expect(res).toHaveLength(1);
    expect(res[0].source).toBe('spotify');
  });

  it('returns empty when nothing is enabled', async () => {
    const orch = new AlbumHuntOrchestrator([hunter('archive', [cand('archive', 'u1', 40)])], () => false);
    expect(await orch.hunt('a', 'b')).toEqual([]);
  });
});
