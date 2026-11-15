import { describe, it, expect } from 'vitest';
import { isPartialDone, partialBadge, stageBadge, stageIndex, STAGE_STEPS } from './pipeline-stage';

describe('stageBadge', () => {
  it('labels and tones each stage', () => {
    expect(stageBadge('downloading')).toEqual({
      key: 'downloads.stage.downloading',
      label: 'Downloading',
      tone: 'active',
    });
    expect(stageBadge('organizing').tone).toBe('active');
    expect(stageBadge('scanning').tone).toBe('active');
    expect(stageBadge('queued').tone).toBe('pending');
    expect(stageBadge('done').tone).toBe('done');
    expect(stageBadge('error').tone).toBe('error');
  });

  /**
   * `resolving` means "the source has not told us what this link contains
   * yet" — a different fact from `queued` ("waiting behind other work"), and
   * the one that explains a card with no track count (#711).
   */
  it('distinguishes resolving from queued', () => {
    expect(stageBadge('resolving').tone).toBe('pending');
    expect(stageBadge('resolving').label).not.toBe(stageBadge('queued').label);
    expect(stageBadge('resolving').key).not.toBe(stageBadge('queued').key);
  });

  /** Every stage carries an i18n key so #664's sweep has nothing to migrate. */
  it('gives every stage a downloads.stage.* key', () => {
    for (const stage of STAGE_STEPS) {
      expect(stageBadge(stage).key).toBe(`downloads.stage.${stage}`);
    }
    expect(stageBadge('error').key).toBe('downloads.stage.error');
  });
});

describe('stageIndex', () => {
  it('orders the linear pipeline steps', () => {
    expect(stageIndex('resolving')).toBe(0);
    expect(stageIndex('queued')).toBe(1);
    expect(stageIndex('done')).toBe(STAGE_STEPS.length - 1);
  });
  it('returns -1 for the off-pipeline error stage', () => {
    expect(stageIndex('error')).toBe(-1);
  });
});

/**
 * #1939. A card that closed with 1 of 14 tracks wore the same green Done as a
 * complete one, beside "13 not offered". Since #1936 the denominator is the
 * edition the job is for, so "fewer landed than that" is a partial.
 */
describe('isPartialDone (#1939)', () => {
  const card = (over: Parameters<typeof isPartialDone>[0]) => isPartialDone(over);

  it('is a done card with tracks of its edition missing', () => {
    expect(card({ stage: 'done', progress: { done: 1, total: 14 } })).toBe(true);
  });

  it('is not a complete card', () => {
    expect(card({ stage: 'done', progress: { done: 11, total: 11 } })).toBe(false);
  });

  it('is not a card whose total the source never committed ("10 so far")', () => {
    expect(card({ stage: 'done', progress: { done: 10, total: 12 }, totalCommitted: false })).toBe(
      false,
    );
  });

  it('is not a card still in flight, or one with no count at all', () => {
    expect(card({ stage: 'downloading', progress: { done: 3, total: 10 } })).toBe(false);
    expect(card({ stage: 'done' })).toBe(false);
  });
});

describe('partialBadge (#1939)', () => {
  it('reads Partial in the warning tone, from its own key', () => {
    expect(partialBadge()).toEqual({
      key: 'downloads.stage.partial',
      label: 'Partial',
      tone: 'warn',
    });
  });
});
