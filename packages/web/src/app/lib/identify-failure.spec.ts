import { describe, expect, it } from 'vitest';
import { identifyFailureKey } from './identify-failure';

describe('identifyFailureKey', () => {
  it('maps each typed failure kind to its review.* i18n key', () => {
    expect(identifyFailureKey('fpcalc-missing')).toBe('review.identifyFpcalcMissing');
    expect(identifyFailureKey('undecodable')).toBe('review.identifyUndecodable');
    expect(identifyFailureKey('source-error')).toBe('review.identifySourceError');
    expect(identifyFailureKey('file-missing')).toBe('review.identifyFileMissing');
  });

  it('falls back to the neutral no-match key for unknown kinds', () => {
    expect(identifyFailureKey('no-match')).toBe('review.identifyNoMatch');
    expect(identifyFailureKey('something-new')).toBe('review.identifyNoMatch');
  });
});
