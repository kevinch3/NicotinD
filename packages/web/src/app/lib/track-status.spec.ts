import { describe, it, expect } from 'vitest';
import type { TrackStatus } from '@nicotind/core';
import { currentAndNextTracks } from './track-status';

function tracks(...entries: [string, TrackStatus][]) {
  return entries.map(([title, status]) => ({ title, status }));
}

describe('currentAndNextTracks', () => {
  it('returns no current and an empty next list for an empty tracks array', () => {
    expect(currentAndNextTracks([])).toEqual({ next: [] });
  });

  it('returns no current and an empty next list when tracks is undefined', () => {
    expect(currentAndNextTracks(undefined)).toEqual({ next: [] });
  });

  it('leaves current undefined when nothing is downloading (never falls back to a stale status)', () => {
    const result = currentAndNextTracks(
      tracks(['A', 'done'], ['B', 'pending'], ['C', 'pending']),
    );
    expect(result.current).toBeUndefined();
    expect(result.next).toEqual(['B', 'C']);
  });

  it('reports the current track with no upcoming pending tracks', () => {
    const result = currentAndNextTracks(tracks(['A', 'done'], ['B', 'downloading']));
    expect(result.current).toBe('B');
    expect(result.next).toEqual([]);
  });

  it('reports current plus up to 2 pending tracks that follow it', () => {
    const result = currentAndNextTracks(
      tracks(
        ['A', 'done'],
        ['B', 'downloading'],
        ['C', 'pending'],
        ['D', 'pending'],
        ['E', 'pending'],
      ),
    );
    expect(result.current).toBe('B');
    expect(result.next).toEqual(['C', 'D']); // capped at 2, E excluded
  });

  it('reports current with fewer than 2 pending entries after it', () => {
    const result = currentAndNextTracks(
      tracks(['A', 'downloading'], ['B', 'pending'], ['C', 'done']),
    );
    expect(result.current).toBe('A');
    expect(result.next).toEqual(['B']);
  });

  it('uses the LAST downloading entry as current, not the first', () => {
    const result = currentAndNextTracks(
      tracks(['A', 'downloading'], ['B', 'failed'], ['C', 'downloading'], ['D', 'pending']),
    );
    expect(result.current).toBe('C');
    expect(result.next).toEqual(['D']);
  });

  it('skips over non-pending entries between current and the pending ones counted', () => {
    const result = currentAndNextTracks(
      tracks(
        ['A', 'downloading'],
        ['B', 'skipped'],
        ['C', 'pending'],
        ['D', 'failed'],
        ['E', 'pending'],
      ),
    );
    expect(result.current).toBe('A');
    expect(result.next).toEqual(['C', 'E']);
  });
});
