import { describe, it, expect } from 'bun:test';
import {
  pickBestTrackFile,
  healthScore,
  extraTokenCount,
  buildTrackQueries,
  type SearchResponseLike,
} from './track-pick';

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

  it('matches a peer file that drops the title\'s (feat …) qualifier', () => {
    // Lidarr title carries "(feat. Drake)"; the peer's filename omits it. Matching
    // on the qualifier-stripped core rescues the near-hit.
    const pick = pickBestTrackFile(
      [resp('a', ['x\\Work.flac'])],
      'Work (feat. Drake)',
    );
    expect(pick?.file.filename).toContain('Work.flac');
  });

  it('does not loosen matching for an already-bare title', () => {
    // "Work" must not spuriously match "Workout" via a core fallback.
    expect(pickBestTrackFile([resp('a', ['x\\Workout Mix.flac'])], 'Work')).toBeNull();
  });
});

describe('buildTrackQueries', () => {
  it('emits exact, title-only, truncated-artist, and qualifier-stripped variants', () => {
    expect(buildTrackQueries('Bahiano', 'Cuando reina el Amor (feat. X)')).toEqual([
      'Bahiano Cuando reina el Amor (feat. X)',
      'Cuando reina el Amor (feat. X)',
      'Bahian Cuando reina el Amor (feat. X)',
      'Bahiano Cuando reina el Amor',
    ]);
  });

  it('de-dupes and skips empty variants for a short artist / bare title', () => {
    // Short artist (<=3 chars) → no truncation; bare title → no qualifier variant.
    expect(buildTrackQueries('U2', 'One')).toEqual(['U2 One', 'One']);
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
