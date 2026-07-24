/**
 * Tests for on-demand track analysis. `verifyGenre` is pure given a stubbed
 * Lidarr client. `analyzeBpm` decodes audio via ffmpeg + music-tempo, so its
 * test generates a 120 BPM click track and is skipped when ffmpeg is absent.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Lidarr } from '@nicotind/lidarr-client';
import {
  analyzeBpm,
  analyzeKey,
  verifyGenre,
  summarizeFfmpegStderr,
  NoConfidentResultError,
} from './track-analysis.js';
import { ffmpegAvailable } from './transcode.js';

describe('summarizeFfmpegStderr', () => {
  it('returns the last non-empty lines as a compact reason', () => {
    const stderr = '  \n[mp3 @ 0x1] Header missing\nInvalid data found when processing input\n\n';
    expect(summarizeFfmpegStderr(stderr)).toBe(
      '[mp3 @ 0x1] Header missing | Invalid data found when processing input',
    );
  });

  it('returns empty string when there is no stderr', () => {
    expect(summarizeFfmpegStderr('')).toBe('');
    expect(summarizeFfmpegStderr('   \n  \n')).toBe('');
  });

  it('truncates very long output but keeps the tail', () => {
    const long = 'x'.repeat(1000);
    const out = summarizeFfmpegStderr(long, 100);
    expect(out.length).toBeLessThanOrEqual(101); // 100 + leading ellipsis
    expect(out.startsWith('…')).toBe(true);
  });
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Minimal Lidarr stub exposing only artist.lookup. */
function fakeLidarr(lookup: (term: string) => Array<{ artistName: string; genres?: string[] }>) {
  return { artist: { lookup: async (t: string) => lookup(t) } } as unknown as Lidarr;
}

describe('verifyGenre', () => {
  it('returns null source when lidarr is absent', async () => {
    const r = await verifyGenre(null, { artist: 'Aphex Twin', currentGenre: 'IDM' });
    expect(r).toEqual({ current: 'IDM', suggested: null, candidates: [], source: null });
  });

  it('suggests the first genre differing from the current tag', async () => {
    const lidarr = fakeLidarr(() => [
      { artistName: 'Aphex Twin', genres: ['Electronic', 'IDM', 'Ambient'] },
    ]);
    const r = await verifyGenre(lidarr, { artist: 'Aphex Twin', currentGenre: 'IDM' });
    expect(r.source).toBe('lidarr');
    expect(r.candidates).toEqual(['Electronic', 'IDM', 'Ambient']);
    expect(r.suggested).toBe('Electronic');
  });

  it('matches the artist diacritic/punctuation-insensitively, not just hits[0]', async () => {
    const lidarr = fakeLidarr(() => [
      { artistName: 'Some Tribute Band', genres: ['Cover'] },
      { artistName: 'Sigur Rós', genres: ['Post-Rock'] },
    ]);
    const r = await verifyGenre(lidarr, { artist: 'Sigur Ros', currentGenre: null });
    expect(r.suggested).toBe('Post-Rock');
  });

  it('degrades to null when the artist has no genres', async () => {
    const lidarr = fakeLidarr(() => [{ artistName: 'Aphex Twin', genres: [] }]);
    const r = await verifyGenre(lidarr, { artist: 'Aphex Twin', currentGenre: 'IDM' });
    expect(r.suggested).toBeNull();
    expect(r.source).toBeNull();
  });

  it('degrades gracefully when lookup throws', async () => {
    const lidarr = {
      artist: {
        lookup: async () => {
          throw new Error('lidarr down');
        },
      },
    } as unknown as Lidarr;
    const r = await verifyGenre(lidarr, { artist: 'Aphex Twin', currentGenre: 'IDM' });
    expect(r.suggested).toBeNull();
    expect(r.source).toBeNull();
  });
});

describe('analyzeBpm', () => {
  it.skipIf(!ffmpegAvailable())('detects a positive tempo from a rhythmic signal', async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const root = mkdtempSync(join(tmpdir(), 'nicotind-bpm-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const wav = join(root, 'click.wav');
    // A 440 Hz sine pulsed by a 2 Hz tremolo → periodic onsets ≈ 120 BPM, 20 s.
    // Avoids lavfi comma-escaping; gives music-tempo a clear rhythmic signal.
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=20:sample_rate=44100',
        '-af',
        'tremolo=f=2:d=0.9',
        wav,
      ],
      { stdio: 'ignore' },
    );
    const bpm = await analyzeBpm(wav);
    expect(bpm).not.toBeNull();
    expect(bpm!).toBeGreaterThan(0);
  });

  it.skipIf(!ffmpegAvailable())(
    'signals a NoConfidentResultError (not a hard failure) when the signal is too short',
    async () => {
      mkdirSync(tmpdir(), { recursive: true });
      const root = mkdtempSync(join(tmpdir(), 'nicotind-bpm-short-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const wav = join(root, 'short.wav');
      // 1 s of audio — decodes fine, but far below the 5 s analysis minimum.
      execFileSync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1:sample_rate=44100',
          wav,
        ],
        { stdio: 'ignore' },
      );
      const errors: unknown[] = [];
      const bpm = await analyzeBpm(wav, (err) => errors.push(err));
      expect(bpm).toBeNull();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(NoConfidentResultError);

      const keyErrors: unknown[] = [];
      const key = await analyzeKey(wav, (err) => keyErrors.push(err));
      expect(key).toBeNull();
      expect(keyErrors).toHaveLength(1);
      expect(keyErrors[0]).toBeInstanceOf(NoConfidentResultError);
    },
  );

  it.skipIf(!ffmpegAvailable())(
    'signals a NoConfidentResultError for a low-confidence (unreliable) key detection (issue #187 B5)',
    async () => {
      mkdirSync(tmpdir(), { recursive: true });
      const root = mkdtempSync(join(tmpdir(), 'nicotind-key-noise-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const wav = join(root, 'noise.wav');
      // Fixed-seed white noise: no tonal content, but chromaToKey still picks
      // *some* key for any non-flat chroma — this seed measured at confidence
      // ≈0.477, below MIN_KEY_CONFIDENCE (0.5). A confident-sounding wrong key
      // must not be returned as if it were reliable.
      execFileSync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'anoisesrc=color=white:duration=6:sample_rate=44100:seed=1',
          wav,
        ],
        { stdio: 'ignore' },
      );
      const keyErrors: unknown[] = [];
      const key = await analyzeKey(wav, (err) => keyErrors.push(err));
      expect(key).toBeNull();
      expect(keyErrors).toHaveLength(1);
      expect(keyErrors[0]).toBeInstanceOf(NoConfidentResultError);
    },
  );
});
