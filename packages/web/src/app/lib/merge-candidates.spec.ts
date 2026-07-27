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

  /**
   * Issue #271. The server ranks equal-matchPct candidates against each other
   * (bloat, then peer health, then format/speed/per-track size) — a
   * whole-discography dump and a clean rip both score 100%, and only the
   * server's ordering tells them apart. This sort compares matchPct alone, so
   * that ordering survives purely because Array#sort is stable (ES2019+).
   * Pinned here: making this comparator non-trivial would silently discard the
   * server's ranking and re-open #271 on the client.
   */
  it('preserves the server ranking among equal-matchPct candidates', () => {
    const base = [c('clean', '/Artist/Album', 100), c('dump', '/Artist/Discography', 100)];
    expect(mergeCandidates(base, []).map((r) => r.username)).toEqual(['clean', 'dump']);
  });

  it('handles disjoint sets with no duplicates', () => {
    const base = [c('u1', '/A', 80)];
    const extra = [c('u2', '/B', 90)];
    expect(mergeCandidates(base, extra)).toHaveLength(2);
  });
});
