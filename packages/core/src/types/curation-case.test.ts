import { describe, it, expect } from 'bun:test';
import {
  CURATION_CASE_KINDS,
  isCurationCaseKind,
  type CurationCase,
} from './curation-case.js';

describe('curation case kinds', () => {
  it('is a closed set of the five decision shapes', () => {
    expect([...CURATION_CASE_KINDS].sort()).toEqual([
      'batch',
      'duplicate',
      'identity',
      'listen',
      'placement',
    ]);
  });

  it('accepts a known kind and rejects anything else', () => {
    expect(isCurationCaseKind('identity')).toBe(true);
    expect(isCurationCaseKind('Identity')).toBe(false);
    expect(isCurationCaseKind('')).toBe(false);
    expect(isCurationCaseKind(undefined)).toBe(false);
  });

  it('types a case carrying a typed option', () => {
    const c: CurationCase = {
      id: 'flag:19',
      kind: 'identity',
      target: { kind: 'artist', id: 'a1', title: 'Rocky', subtitle: '1 album' },
      question: 'Which Rocky is this?',
      evidence: [{ label: 'Origin', value: 'France' }],
      options: [
        {
          id: 'keep',
          label: 'Leave as is',
          rationale: 'Nothing to change',
          effect: { type: 'resolve-only' },
        },
      ],
      confidence: 1,
      source: 'flag',
    };
    expect(c.options[0]!.effect.type).toBe('resolve-only');
  });
});
