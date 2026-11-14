import { of } from 'rxjs';
import { runScoredHunt, huntDownloadPayload } from './scored-hunt';
import type { DownloadsApiService } from '../services/api/downloads-api.service';
import type { FolderCandidate } from '../services/api/api-types';

const cand = (username: string, matchPct: number): FolderCandidate => ({
  username,
  directory: `${username}/Album`,
  files: [{ filename: `${username}/01.flac`, size: 5 } as FolderCandidate['files'][number]],
  matchedTracks: 9,
  totalTracks: 10,
  matchPct,
  format: 'FLAC',
  estimatedSizeMb: 1,
  isLive: false,
  freeUploadSlots: 1,
  queueLength: 0,
  uploadSpeed: 1,
});

function api(base: object, skew: object = { candidates: [] }) {
  return {
    huntAlbumBase: vi.fn(() => of({ candidates: [], totalTracks: 10, ...base })),
    huntAlbumSkew: vi.fn(() => of(skew)),
  };
}

describe('runScoredHunt', () => {
  it('stops after the base queries when they were confident', async () => {
    const a = api({ candidates: [cand('a', 95)], skewNeeded: false });
    const phases: string[] = [];
    const hunt = await runScoredHunt(a as unknown as DownloadsApiService, 7, 'X', 'Y', {
      skew: true,
      onPhase: (p, s) => phases.push(`${p}:${s}`),
    });
    expect(a.huntAlbumSkew).not.toHaveBeenCalled();
    expect(hunt.candidates.map((c) => c.username)).toEqual(['a']);
    expect(phases).toEqual(['base:searching', 'base:done', 'skew:skipped']);
  });

  it('runs the skewed queries when needed and merges both, flags included', async () => {
    const a = api(
      { candidates: [cand('a', 60)], skewNeeded: true, searchesFired: 3, searchesAnswered: 3 },
      { candidates: [cand('b', 90)], rateLimited: true, searchesFired: 2, searchesAnswered: 1 },
    );
    const base: string[] = [];
    const hunt = await runScoredHunt(a as unknown as DownloadsApiService, 7, 'X', 'Y', {
      skew: true,
      onBase: (cs) => base.push(...cs.map((c) => c.username)),
    });
    expect(base).toEqual(['a']);
    expect(hunt.candidates.map((c) => c.username).sort()).toEqual(['a', 'b']);
    expect(hunt).toMatchObject({ rateLimited: true, cutShort: true, searchesFired: 5 });
  });

  it('never skews when told not to', async () => {
    const a = api({ skewNeeded: true });
    await runScoredHunt(a as unknown as DownloadsApiService, 7, 'X', 'Y', { skew: false });
    expect(a.huntAlbumSkew).not.toHaveBeenCalled();
  });
});

describe('huntDownloadPayload', () => {
  it('sends the pick and every other candidate as an alternate', () => {
    const all = [cand('a', 90), cand('b', 80), cand('c', 70)];
    const body = huntDownloadPayload(all[1]!, all, 'local-1');
    expect(body.selected.username).toBe('b');
    expect(body.alternates.map((x) => x.username)).toEqual(['a', 'c']);
    expect(body.localAlbumId).toBe('local-1');
  });
});
