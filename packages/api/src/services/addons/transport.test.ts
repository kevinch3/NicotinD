import { describe, expect, it } from 'bun:test';
import type { AddonTransport } from './transport.js';
import { AddonClient } from './client.js';

describe('AddonTransport', () => {
  it('AddonClient structurally satisfies AddonTransport', () => {
    // Compile-time: the assignment fails to typecheck if a method drifts.
    const t: AddonTransport = new AddonClient({ baseUrl: 'http://x', token: 'tok' });
    expect(typeof t.createJob).toBe('function');
    expect(typeof t.fetchFile).toBe('function');
    expect(typeof t.bindOutcome).toBe('function');
  });
});
