import { describe, it, expect } from 'bun:test';
import { pickBestTrackFile, healthScore, extraTokenCount, type SearchResponseLike } from './track-pick';

const resp = (
  username: string,
  files: string[],
  health: Partial<SearchResponseLike> = {},
): SearchResponseLike => ({
  username,
  files: files.map((filename) => ({ filename, size: 1000 })),
  ...health,
});

describe('pickBestTrackFile', () => {
  it('prefers the clean title over a noisy variant, even from a healthier peer', () => {
    const pick = pickBestTrackFile(
      [
        resp('healthy', ['Britney Spears\\03 - Toxic (5.1 Mix).flac'], { freeUploadSlots: 5 }),
        resp('queued', ['Britney Spears\\03 - Toxic.mp3'], { freeUploadSlots: 0, queueLength: 50 }),
      ],
      'Toxic',
    );
    expect(pick?.file.filename).toContain('Toxic.mp3'); // fewest extra words wins
  });

  it('breaks ties among equally-clean files by FLAC then peer health', () => {
    const pick = pickBestTrackFile(
      [
        resp('a', ['x\\Toxic.mp3'], { freeUploadSlots: 0 }),
        resp('b', ['x\\Toxic.flac'], { freeUploadSlots: 0 }),
      ],
      'Toxic',
    );
    expect(pick?.file.filename).toContain('.flac');
    expect(pick?.username).toBe('b');
  });

  it('uses peer health to break ties among equal formats', () => {
    const pick = pickBestTrackFile(
      [
        resp('slow', ['x\\Toxic.mp3'], { freeUploadSlots: 0, queueLength: 99 }),
        resp('fast', ['x\\Toxic.mp3'], { freeUploadSlots: 3 }),
      ],
      'Toxic',
    );
    expect(pick?.username).toBe('fast');
  });

  it('ignores non-audio files and returns null when nothing matches', () => {
    expect(pickBestTrackFile([resp('a', ['x\\Toxic.jpg', 'x\\readme.txt'])], 'Toxic')).toBeNull();
    expect(pickBestTrackFile([resp('a', ['x\\Some Other Song.flac'])], 'Toxic')).toBeNull();
  });

  it('matches across a leading track number and folder path', () => {
    const pick = pickBestTrackFile([resp('a', ['Music\\Album\\07 Closing Time.flac'])], 'Closing Time');
    expect(pick?.file.filename).toContain('Closing Time.flac');
  });
});

describe('healthScore / extraTokenCount', () => {
  it('rewards a free slot over a long queue', () => {
    expect(healthScore({ freeUploadSlots: 1 })).toBeGreaterThan(healthScore({ queueLength: 100 }));
  });
  it('counts only words beyond the canonical title', () => {
    expect(extraTokenCount('toxic', 'toxic')).toBe(0);
    expect(extraTokenCount('toxic', 'toxic live remix')).toBe(2);
  });
});
