import { describe, it, expect } from 'vitest';
import { stageBadge, stageIndex, STAGE_STEPS } from './pipeline-stage';

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
