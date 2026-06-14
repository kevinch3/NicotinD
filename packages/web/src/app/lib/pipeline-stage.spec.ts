import { describe, it, expect } from 'vitest';
import { stageBadge, stageIndex, STAGE_STEPS } from './pipeline-stage';

describe('stageBadge', () => {
  it('labels and tones each stage', () => {
    expect(stageBadge('downloading')).toEqual({ label: 'Downloading', tone: 'active' });
    expect(stageBadge('organizing').tone).toBe('active');
    expect(stageBadge('scanning').tone).toBe('active');
    expect(stageBadge('queued').tone).toBe('pending');
    expect(stageBadge('done').tone).toBe('done');
    expect(stageBadge('error').tone).toBe('error');
  });
});

describe('stageIndex', () => {
  it('orders the linear pipeline steps', () => {
    expect(stageIndex('queued')).toBe(0);
    expect(stageIndex('done')).toBe(STAGE_STEPS.length - 1);
  });
  it('returns -1 for the off-pipeline error stage', () => {
    expect(stageIndex('error')).toBe(-1);
  });
});
