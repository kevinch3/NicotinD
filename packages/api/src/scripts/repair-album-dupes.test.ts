import { describe, expect, it } from 'bun:test';
import { dupKey, pickKeeper, type DupFile } from './repair-album-dupes.js';

describe('dupKey', () => {
  it('collapses track number, collision suffix, case and punctuation variants', () => {
    const k = dupKey('02 - Circus.mp3');
    expect(dupKey('02 - Circus (2).mp3')).toBe(k);
    expect(dupKey('03 - Beyond The 7th Sky.mp3')).toBe(dupKey('03 - Beyond the 7th Sky.mp3'));
    expect(dupKey("05 - Can't Get You Off My Mind.mp3")).toBe(
      dupKey('05 - Can’t Get You Off My Mind.mp3'),
    );
    // FLAC/MP3 of the same track share a key.
    expect(dupKey('07 - Black Girl.flac')).toBe(dupKey('07 - Black Girl.mp3'));
  });

  it('keeps genuinely distinct tracks distinct', () => {
    expect(dupKey('01 - Believe.mp3')).not.toBe(dupKey('01 - Believe (acoustic version).flac'));
    expect(dupKey('04 - Tunnel Vision.mp3')).not.toBe(dupKey('16 - Tunnel Vision (live).flac'));
    // Same track number, different songs (different albums merged into a folder).
    expect(dupKey('01 - Are You Gonna Go My Way.mp3')).not.toBe(dupKey('01 - Believe.flac'));
  });
});

describe('pickKeeper', () => {
  it('prefers FLAC over a larger lossy copy', () => {
    const files: DupFile[] = [
      { name: '02 - Circus (2).mp3', size: 11_607_762 },
      { name: '02 - Circus.flac', size: 30_000_000 },
      { name: '02 - Circus.mp3', size: 11_539_247 },
    ];
    const [keeper] = pickKeeper(files);
    expect(keeper.name).toBe('02 - Circus.flac');
  });

  it('among same format, keeps the larger copy (better bitrate / not truncated)', () => {
    const files: DupFile[] = [
      { name: '02 - Circus (2).mp3', size: 11_607_762 },
      { name: '02 - Circus.mp3', size: 11_539_247 },
    ];
    const [keeper, ...rest] = pickKeeper(files);
    expect(keeper.name).toBe('02 - Circus (2).mp3'); // larger wins regardless of suffix
    expect(rest.map((r) => r.name)).toEqual(['02 - Circus.mp3']);
  });

  it('breaks a size tie toward the un-suffixed original', () => {
    const files: DupFile[] = [
      { name: 'God Is Love (2).mp3', size: 10_000_000 },
      { name: 'God Is Love.mp3', size: 10_000_000 },
    ];
    const [keeper] = pickKeeper(files);
    expect(keeper.name).toBe('God Is Love.mp3');
  });
});
