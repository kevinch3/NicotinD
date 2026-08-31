import { describe, expect, it } from 'bun:test';
import { isMbidShape } from './mbid.js';

describe('isMbidShape', () => {
  it('accepts a canonical MusicBrainz recording id', () => {
    expect(isMbidShape('98ddbc99-af41-4722-93ea-1db8e2433878')).toBe(true);
  });

  it('accepts an uppercase or padded tag value, which files really carry', () => {
    expect(isMbidShape('98DDBC99-AF41-4722-93EA-1DB8E2433878')).toBe(true);
    expect(isMbidShape('  98ddbc99-af41-4722-93ea-1db8e2433878\n')).toBe(true);
  });

  it('rejects the Discogs refs external taggers write into MUSICBRAINZ_TRACKID', () => {
    // The exact prod values that 400'd a whole ListenBrainz batch (issue #851).
    expect(isMbidShape('5333377-B5')).toBe(false);
    expect(isMbidShape('5495705-13')).toBe(false);
  });

  it('rejects absent, empty and near-miss values', () => {
    expect(isMbidShape(null)).toBe(false);
    expect(isMbidShape(undefined)).toBe(false);
    expect(isMbidShape('')).toBe(false);
    expect(isMbidShape('98ddbc99af41472293ea1db8e2433878')).toBe(false); // no dashes
    expect(isMbidShape('98ddbc99-af41-4722-93ea-1db8e2433878-extra')).toBe(false);
    expect(isMbidShape('zzddbc99-af41-4722-93ea-1db8e2433878')).toBe(false); // non-hex
  });
});
