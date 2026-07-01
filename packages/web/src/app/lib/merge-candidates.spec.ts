import { mergeCandidates } from './merge-candidates';
import type { FolderCandidate } from '../services/api/api-types';

function c(username: string, directory: string, matchPct: number): FolderCandidate {
  return {
    username,
    directory,
    files: [],
    matchedTracks: 0,
    totalTracks: 10,
    matchPct,
    format: 'MP3',
    estimatedSizeMb: 0,
    isLive: false,
    freeUploadSlots: 1,
    queueLength: 0,
    uploadSpeed: 0,
  } as FolderCandidate;
}

describe('mergeCandidates', () => {
  it('returns base candidates when extra is empty', () => {
    const base = [c('u1', '/A', 90), c('u2', '/B', 80)];
    expect(mergeCandidates(base, [])).toEqual(base);
  });

  it('de-duplicates by username::directory, keeping higher matchPct', () => {
    const base = [c('u1', '/A', 80)];
    const extra = [c('u1', '/A', 95)];
    const result = mergeCandidates(base, extra);
    expect(result).toHaveLength(1);
    expect(result[0].matchPct).toBe(95);
  });

  it('keeps lower-pct instance from base when extra is lower', () => {
    const base = [c('u1', '/A', 90)];
    const extra = [c('u1', '/A', 70)];
    expect(mergeCandidates(base, extra)[0].matchPct).toBe(90);
  });

  it('sorts merged results descending by matchPct', () => {
    const base = [c('u1', '/A', 70)];
    const extra = [c('u2', '/B', 95), c('u3', '/C', 50)];
    const result = mergeCandidates(base, extra);
    expect(result.map((r) => r.matchPct)).toEqual([95, 70, 50]);
  });

  it('handles disjoint sets with no duplicates', () => {
    const base = [c('u1', '/A', 80)];
    const extra = [c('u2', '/B', 90)];
    expect(mergeCandidates(base, extra)).toHaveLength(2);
  });
});
