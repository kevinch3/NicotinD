/**
 * Tests for the library-wide loudness normalization pass.
 *
 * The mechanism is tested in `opus-gain.test.ts`, including that a wrong page
 * CRC is actually caught. This covers what the pass decides: which files it
 * touches, which it declines, and that running it twice is a no-op.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { DEFAULT_TARGET_LUFS, normalizeLibraryLoudness } from './loudness-normalize.js';
import { readOutputGain } from './opus-gain.js';
import { songId } from './library-scanner.js';
import { ffmpegAvailable } from './transcode.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpMusic(): string {
  const d = mkdtempSync(join(tmpdir(), 'nicotind-norm-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function makeOpus(musicDir: string, rel: string): void {
  const dest = join(musicDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-vn',
      '-c:a',
      'libopus',
      '-b:a',
      '96k',
      '-f',
      'ogg',
      '-y',
      dest,
    ],
    { stdio: 'ignore' },
  );
}

function seed(
  db: Database,
  rel: string,
  opts: { loudness?: number | null; suffix?: string } = {},
): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, suffix,
                                size, duration, loudness, hidden, synced_at)
     VALUES (?, 'alb', 'T', 'A', 'art', ?, ?, 1000, 60, ?, 0, 1)`,
    // `'loudness' in opts`, not `??`: an explicitly null loudness is the whole
    // point of one case below, and `??` would silently turn it back into -10.
    [songId(rel), rel, opts.suffix ?? 'opus', 'loudness' in opts ? (opts.loudness ?? null) : -10],
  );
}

describe.skipIf(!ffmpegAvailable())('normalizeLibraryLoudness', () => {
  it('writes the gain that moves a track to the target', () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'A/Al/01 - Loud.opus';
    makeOpus(music, rel);
    seed(db, rel, { loudness: -10 }); // 4 dB above the -14 target

    return normalizeLibraryLoudness(db, music, { apply: true }).then((r) => {
      expect(r.normalized).toBe(1);
      expect(readOutputGain(join(music, rel))).toBeCloseTo(DEFAULT_TARGET_LUFS - -10, 2);
    });
  });

  it('is a no-op on a second run', async () => {
    // Idempotent by MEASUREMENT, not by a flag: each file's current gain is
    // read and compared, so a re-run touches nothing and an interrupted run
    // resumes correctly with no resume bookkeeping at all.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'A/Al/01 - Loud.opus';
    makeOpus(music, rel);
    seed(db, rel, { loudness: -10 });

    await normalizeLibraryLoudness(db, music, { apply: true });
    const bytes = readFileSync(join(music, rel));
    const again = await normalizeLibraryLoudness(db, music, { apply: true });

    expect(again.normalized).toBe(0);
    expect(again.alreadyCorrect).toBe(1);
    expect(readFileSync(join(music, rel)).equals(bytes)).toBe(true);
  });

  it('leaves a track with no measurement alone', async () => {
    // Normalizing to a guess would be a confident wrong answer, and a
    // normalized-to-nothing track is worse than an unnormalized one.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'A/Al/01 - Unmeasured.opus';
    makeOpus(music, rel);
    seed(db, rel, { loudness: null });

    const r = await normalizeLibraryLoudness(db, music, { apply: true });

    expect(r.noMeasurement).toBe(1);
    expect(r.normalized).toBe(0);
    expect(readOutputGain(join(music, rel))).toBe(0);
  });

  it('ignores files that are not Opus', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    seed(db, 'A/Al/01 - Song.mp3', { suffix: 'mp3' });

    const r = await normalizeLibraryLoudness(db, music, { apply: true });

    expect(r.candidates).toBe(0);
  });

  it('counts a missing file instead of throwing', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    seed(db, 'A/Al/01 - Gone.opus');

    const r = await normalizeLibraryLoudness(db, music, { apply: true });

    expect(r.failed).toBe(1);
    expect(r.errorSample).toContain('missing on disk');
  });

  it('writes nothing on a dry run but reports what it would do', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'A/Al/01 - Loud.opus';
    makeOpus(music, rel);
    seed(db, rel, { loudness: -10 });

    const r = await normalizeLibraryLoudness(db, music, { apply: false });

    expect(r.normalized).toBe(1);
    expect(readOutputGain(join(music, rel))).toBe(0);
  });

  it('resumes from a cursor without redoing work', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    for (let i = 1; i <= 4; i++) {
      const rel = `A/Al/0${i} - Track.opus`;
      makeOpus(music, rel);
      seed(db, rel, { loudness: -10 });
    }

    const first = await normalizeLibraryLoudness(db, music, { apply: true, limit: 2 });
    expect(first.stopped).toBe(true);
    const second = await normalizeLibraryLoudness(db, music, {
      apply: true,
      limit: 2,
      afterId: first.cursor,
    });

    expect(first.normalized + second.normalized).toBe(4);
    expect(second.cursor).not.toBe(first.cursor);
  });

  it('honours a different target', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'A/Al/01 - Loud.opus';
    makeOpus(music, rel);
    seed(db, rel, { loudness: -10 });

    await normalizeLibraryLoudness(db, music, { apply: true, targetLufs: -18 });

    expect(readOutputGain(join(music, rel))).toBeCloseTo(-8, 2);
  });
});
