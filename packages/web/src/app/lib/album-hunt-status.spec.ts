import { describe, expect, it } from 'vitest';
import { IDLE_HUNT, SEARCHING_HUNT, STARTING_HUNT, albumHuntLabel } from './album-hunt-status';

const t = (key: string) =>
  ({ 'acquire.finding': 'Finding…', 'pipeline.downloading': 'Downloading' })[key] ?? key;

describe('albumHuntLabel', () => {
  it('reads "Finding…" before a job exists', () => {
    expect(albumHuntLabel(SEARCHING_HUNT, t)).toBe('Finding…');
    expect(albumHuntLabel(IDLE_HUNT, t)).toBe('Finding…');
  });

  it('stops saying "Finding…" once the pick is being enqueued (#1543)', () => {
    expect(albumHuntLabel(STARTING_HUNT, t)).toBe('Starting download…');
  });

  it('adds the progress count to the stage once the job has a total', () => {
    expect(
      albumHuntLabel({ phase: 'job', stage: 'downloading', delivered: 7, expected: 13 }, t),
    ).toMatch(/ · 7\/13$/);
  });

  it('prints the bare stage when there is no committed total', () => {
    expect(albumHuntLabel({ phase: 'job', stage: 'downloading' }, t)).not.toMatch(/\//);
  });
});
