import { describe, it, expect } from 'vitest';
import { failureDigest } from './failure-digest';

describe('failureDigest', () => {
  it('names the reason for a single album', () => {
    expect(failureDigest([{ title: 'Mare', reason: 'No confident match' }])).toBe(
      `Couldn't get "Mare" — No confident match`,
    );
  });

  it('drops the dash when there is no reason', () => {
    expect(failureDigest([{ title: 'Mare', reason: '' }])).toBe(`Couldn't get "Mare"`);
  });

  it('counts and names several albums', () => {
    expect(
      failureDigest([
        { title: 'Mare', reason: 'a' },
        { title: 'Lys', reason: 'b' },
      ]),
    ).toBe(`2 albums couldn't be fetched: "Mare", "Lys"`);
  });
});
