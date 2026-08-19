import { describe, expect, it } from 'vitest';
import { approvalShare, breakdownLine } from './radio-polls-card.lib';

describe('breakdownLine', () => {
  it('renders axes as value×weight with skipped appended', () => {
    expect(
      breakdownLine({
        score: 0.8,
        axes: [
          { axis: 'genre', value: 0.85, weight: 18, contribution: 15.3 },
          { axis: 'bpm', value: 0.9, weight: 8, contribution: 7.2 },
        ],
        skipped: ['valence'],
        floored: [],
        artistPenaltyApplied: false,
        recentPlayPenaltyApplied: 0,
      }),
    ).toBe('genre 0.85×18 · bpm 0.90×8  [skipped: valence]');
  });

  it('omits the skipped suffix when nothing was skipped', () => {
    expect(
      breakdownLine({
        score: 1,
        axes: [{ axis: 'genre', value: 1, weight: 18, contribution: 18 }],
        skipped: [],
        floored: [],
        artistPenaltyApplied: false,
        recentPlayPenaltyApplied: 0,
      }),
    ).toBe('genre 1.00×18');
  });
});

describe('approvalShare', () => {
  it('is up over total, null when unvoted', () => {
    expect(approvalShare(3, 1)).toBe(0.75);
    expect(approvalShare(0, 2)).toBe(0);
    expect(approvalShare(0, 0)).toBeNull();
  });
});
