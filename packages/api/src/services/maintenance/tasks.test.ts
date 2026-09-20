/**
 * Wiring tests for the maintenance task registry.
 *
 * The mechanisms these tasks call are tested next to those mechanisms. What is
 * tested here is that the task actually *reaches* them with the right options —
 * the gap that let quarantine ship, pass its own tests, and still delete every
 * original the Admin button converted.
 *
 * Real ffmpeg + a real schema, so the assertion is about files on disk rather
 * than about which arguments a spy received.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../db.js';
import { buildMaintenanceTasks, type MaintenanceRunContext } from './tasks.js';
import { songId } from '../library-scanner.js';
import { ffmpegAvailable } from '../transcode.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpDir(prefix: string): string {
  mkdirSync(tmpdir(), { recursive: true });
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

const ctx: MaintenanceRunContext = { shouldStop: () => false, onProgress: () => {} };

describe.skipIf(!ffmpegAvailable())('transcode-library keeps the originals', () => {
  it('quarantines the replaced file instead of deleting it', async () => {
    // The regression this exists for: `MaintenanceDeps` had no `dataDir`, and
    // `TranscodeAllOptions.dataDir` was optional, so the Admin task converted
    // the whole library with nothing to undo it. `check:transcode-quarantine`
    // guards the call site; this guards the behaviour.
    const musicDir = tmpDir('nicotind-mtask-music-');
    const dataDir = tmpDir('nicotind-mtask-data-');
    const db = new Database(':memory:');
    applySchema(db);

    const rel = 'The Artist/Album/01 - Song.flac';
    const abs = join(musicDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=channel_layout=mono:sample_rate=22050',
        '-t',
        '0.3',
        '-c:a',
        'flac',
        abs,
      ],
      { stdio: 'ignore' },
    );
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, suffix,
                                  size, duration, hidden, synced_at)
       VALUES (?, 'alb', 'Song', 'The Artist', 'art', ?, 'flac', 1000, 10, 0, 1)`,
      [songId(rel), rel],
    );

    const tasks = buildMaintenanceTasks({
      db,
      lidarr: null,
      musicDir,
      dataDir,
      transcodeLossless: { enabled: true, bitRate: 96 },
      runSync: null,
    });
    const task = tasks.find((t) => t.id === 'transcode-library');
    expect(task).toBeDefined();

    await task!.run(ctx, task!.parseParams(new URLSearchParams()));

    // Converted...
    expect(existsSync(join(musicDir, 'The Artist/Album/01 - Song.opus'))).toBe(true);
    expect(existsSync(abs)).toBe(false);
    // ...and the original is recoverable, at its library-relative path.
    const runs = readdirSync(join(dataDir, 'quarantine'));
    expect(runs.length).toBe(1);
    expect(existsSync(join(dataDir, 'quarantine', runs[0]!, rel))).toBe(true);
  });

  it('defaults to apply, so a bare click is the destructive one', () => {
    // `?dryRun=1` inverts into `apply`. Worth pinning: if that ever flipped,
    // the quarantine above is the only thing standing between a stray click
    // and an irreversible whole-library pass.
    const tasks = buildMaintenanceTasks({
      db: new Database(':memory:'),
      lidarr: null,
      musicDir: '/music',
      dataDir: '/data',
      transcodeLossless: { enabled: true, bitRate: 96 },
      runSync: null,
    });
    const task = tasks.find((t) => t.id === 'transcode-library')!;
    // `AnyMaintenanceTask` erases the param type, so the registry can hold
    // tasks with different shapes. Narrowing here is the cost of that.
    const parse = (q: string) => task.parseParams(new URLSearchParams(q)) as { apply: boolean };

    expect(parse('').apply).toBe(true);
    expect(parse('dryRun=1').apply).toBe(false);
  });
});
