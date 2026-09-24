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
import { setLibraryFormatSettings } from '../library-format-settings.js';
import { buildMaintenanceTasks, type MaintenanceRunContext } from './tasks.js';
import { songId } from '../library-scanner.js';
import { ffmpegAvailable } from '../transcode.js';
import { listTranscodeRuns } from '../transcode-run-store.js';
import { createQuarantineRun, listQuarantineRuns } from '../transcode-quarantine.js';

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
      opusHeaderGain: false,
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

  it('records a durable run row, with where the originals went', async () => {
    // The Admin panel's last outcome is wiped by the next task or any restart,
    // so without this an irreversible whole-library pass left only a
    // `maintenance.start` audit row saying it began.
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
      opusHeaderGain: false,
      transcodeLossless: { enabled: true, bitRate: 96 },
      runSync: null,
    });
    const task = tasks.find((t) => t.id === 'transcode-library')!;

    await task.run(ctx, task.parseParams(new URLSearchParams()));

    const runs = listTranscodeRuns(db);
    expect(runs.length).toBe(1);
    expect(runs[0]!.state).toBe('done');
    expect(runs[0]!.converted).toBe(1);
    expect(runs[0]!.quarantineRun).toContain('quarantine');
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
      opusHeaderGain: false,
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

describe('normalize-loudness is off until the flag says otherwise', () => {
  function tasksWith(opusHeaderGain: boolean) {
    // A schema'd DB, not a bare one: `available()` reads the library-format
    // setting to say whether the chosen format can be normalized at all, so a
    // bare database would exercise the fallback instead of the real path.
    const db = new Database(':memory:');
    applySchema(db);
    return buildMaintenanceTasks({
      db,
      lidarr: null,
      musicDir: '/music',
      dataDir: '/data',
      opusHeaderGain,
      transcodeLossless: { enabled: true, bitRate: 96 },
      runSync: null,
    });
  }

  it('reports unavailable, with the reason, when the flag is off', () => {
    // Normalizing a library one of its clients then ignores is a
    // half-normalized library, which is worse than an unnormalized one. The
    // reason has to reach the screen, not just the code.
    const task = tasksWith(false).find((t) => t.id === 'normalize-loudness')!;

    const available = task.available();

    expect(available).not.toBe(true);
    expect(String(available)).toContain('NICOTIND_OPUS_HEADER_GAIN');
    expect(String(available)).toContain('iOS 18.4');
  });

  it('becomes available once the flag is set', () => {
    expect(
      tasksWith(true)
        .find((t) => t.id === 'normalize-loudness')!
        .available(),
    ).toBe(true);
  });

  it('says WHY when the chosen library format has no gain field (#1256)', () => {
    // The trap #1256 names: a format selector that silently turns off loudness
    // normalization is worse than no selector, because the capability loss has
    // no symptom. So the reason has to reach the screen — offering a pass that
    // would visit nothing, or failing at run time, both hide it.
    const db = new Database(':memory:');
    applySchema(db);
    setLibraryFormatSettings(db, { format: 'mp3' });
    const task = buildMaintenanceTasks({
      db,
      lidarr: null,
      musicDir: '/music',
      dataDir: '/data',
      // Flag ON, so the only thing making it unavailable is the format.
      opusHeaderGain: true,
      transcodeLossless: { enabled: true, bitRate: 96 },
      runSync: null,
    }).find((t) => t.id === 'normalize-loudness')!;

    const available = task.available();

    expect(available).not.toBe(true);
    expect(String(available)).toContain('mp3');
    expect(String(available)).toContain('no in-header gain field');
  });
});

describe('prune-quarantine is the only thing that deletes originals (#1260)', () => {
  function setup() {
    const data = tmpDir('prune-');
    for (let day = 1; day <= 5; day++) createQuarantineRun(data, new Date(2026, 8, day));
    const task = buildMaintenanceTasks({
      db: new Database(':memory:'),
      lidarr: null,
      musicDir: '/music',
      dataDir: data,
      opusHeaderGain: false,
      transcodeLossless: { enabled: true, bitRate: 96 },
      runSync: null,
    }).find((t) => t.id === 'prune-quarantine')!;
    return { data, task };
  }

  it('is a dry run unless asked, and names the runs it would delete', async () => {
    const { data, task } = setup();
    const labels: string[] = [];
    const r = await task.run(
      { shouldStop: () => false, onProgress: (p) => labels.push(p.label) },
      task.parseParams(new URLSearchParams('')),
    );
    expect(r.detail).toEqual({ runsHeld: 5, runsToPrune: 2, runsPruned: 0 });
    expect(labels).toEqual(['transcode-20260902-000000', 'transcode-20260901-000000']);
    expect(listQuarantineRuns(data)).toHaveLength(5);
  });

  it('deletes the oldest runs past `keep` with ?apply=1', async () => {
    const { data, task } = setup();
    const r = await task.run(ctx, task.parseParams(new URLSearchParams('apply=1&keep=4')));
    expect(r.detail).toEqual({ runsHeld: 5, runsToPrune: 1, runsPruned: 1 });
    expect(listQuarantineRuns(data)).not.toContain('transcode-20260901-000000');
    expect(listQuarantineRuns(data)).toHaveLength(4);
  });
});

describe('normalize-loudness runs at the operator target (#1255)', () => {
  it('reads the target from the library format settings, per run', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    setLibraryFormatSettings(db, { targetLufs: -18 });
    const task = buildMaintenanceTasks({
      db,
      lidarr: null,
      musicDir: tmpDir('lufs-'),
      dataDir: '/data',
      opusHeaderGain: true,
      transcodeLossless: { enabled: true, bitRate: 96 },
      runSync: null,
    }).find((t) => t.id === 'normalize-loudness')!;
    const r = await task.run(ctx, task.parseParams(new URLSearchParams('dryRun=1')));
    expect(r.detail.targetLufs).toBe(-18);
  });
});
