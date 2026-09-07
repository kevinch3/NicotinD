import { describe, it, expect } from 'vitest';
import { autoFetchToast, NoChangeError } from './auto-fetch-toast';

/**
 * Issue #988: the route collapsed five outcomes into one `{ filled: false }`
 * and the client discarded even that, so "Fetch automatically" was silent
 * whether it worked, declined, or failed. Every branch must now say something,
 * and the three kinds must be distinguishable.
 */
describe('autoFetchToast', () => {
  it('names the provider that answered', () => {
    expect(autoFetchToast({ filled: true, source: 'Gondwana → spotify' })).toEqual({
      message: 'New portrait from Gondwana → spotify',
      kind: 'success',
    });
  });

  it('still confirms success when the provider is unnamed', () => {
    expect(autoFetchToast({ filled: true, source: null }).kind).toBe('success');
  });

  // A curator's own portrait is a decision, not a gap — informational, not an
  // error, and the message has to say how to get past it.
  it('explains a curator-locked artist as info, not failure', () => {
    const t = autoFetchToast({ filled: false, reason: 'manual-override' });
    expect(t.kind).toBe('info');
    expect(t.message).toContain('reset');
  });

  it('separates "nobody had one" from "the lookup broke"', () => {
    expect(autoFetchToast({ filled: false, reason: 'no-candidate' }).kind).toBe('info');
    expect(autoFetchToast({ filled: false, reason: 'error' }).kind).toBe('error');
    expect(autoFetchToast({ filled: false, reason: 'no-cache-dir' }).kind).toBe('error');
    expect(autoFetchToast({ filled: false, reason: 'not-found' }).kind).toBe('error');
  });

  it('never returns an empty message for any outcome', () => {
    const reasons = [
      'not-found',
      'manual-override',
      'no-cache-dir',
      'no-candidate',
      'error',
    ] as const;
    for (const reason of reasons) {
      expect(autoFetchToast({ filled: false, reason }).message.length).toBeGreaterThan(0);
    }
  });
});

describe('NoChangeError', () => {
  it('is distinguishable from a real failure', () => {
    expect(new NoChangeError()).toBeInstanceOf(Error);
    expect(new NoChangeError().name).toBe('NoChangeError');
  });
});
