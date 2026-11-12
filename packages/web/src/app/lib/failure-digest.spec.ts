import { describe, it, expect } from 'vitest';
import { failureDigest } from './failure-digest';
import { interpolate } from '../services/translate.service';
import EN_CATALOG from '../../../public/i18n/en.json';

const t = (key: string, params?: Record<string, string | number>) =>
  interpolate((EN_CATALOG as Record<string, string>)[key] ?? key, params);

describe('failureDigest', () => {
  it('names the reason for a single album', () => {
    expect(failureDigest([{ title: 'Mare', reason: 'No confident match' }], t)).toBe(
      `Couldn't get "Mare" — No confident match`,
    );
  });

  it('drops the dash when there is no reason', () => {
    expect(failureDigest([{ title: 'Mare', reason: '' }], t)).toBe(`Couldn't get "Mare"`);
  });

  it('counts and names several albums', () => {
    expect(
      failureDigest(
        [
          { title: 'Mare', reason: 'a' },
          { title: 'Lys', reason: 'b' },
        ],
        t,
      ),
    ).toBe(`2 albums couldn't be fetched: "Mare", "Lys"`);
  });
});
