import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runAcquireProcess,
  parseYtdlpProgress,
  parseYtdlpPlaylistTitle,
  parseSpotdlProgress,
  collectAudioPaths,
  type RunAcquireOptions,
} from './process.js';

// Injected spawn fake (NOT mock.module — that leaks node:child_process globally).
class FakeStream extends EventEmitter {}
class FakeProc extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  emitData(chunk: string): void {
    this.stdout.emit('data', Buffer.from(chunk));
  }
  finish(code: number): void {
    this.emit('close', code);
  }
}

let fakeProc: FakeProc;
const spawnMock = mock((..._args: unknown[]) => {
  fakeProc = new FakeProc();
  return fakeProc;
});

let stagingBase: string;

function run(extra: Partial<RunAcquireOptions> = {}) {
  return runAcquireProcess({
    binaryPath: 'yt-dlp',
    args: ['https://example.com/v'],
    stagingDir: stagingBase,
    spawn: spawnMock as unknown as RunAcquireOptions['spawn'],
    ...extra,
  });
}

function seedAudio(relPath: string): void {
  const dest = join(stagingBase, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, new Uint8Array([0]));
}

describe('parseYtdlpProgress', () => {
  it('parses a percentage line', () => {
    expect(parseYtdlpProgress('[download]  67.3% of 5MiB', { done: 0, total: 100 })).toEqual({
      done: 67,
      total: 100,
    });
  });
  it('parses a playlist item counter', () => {
    expect(
      parseYtdlpProgress('[download] Downloading item 3 of 12', { done: 0, total: 100 }),
    ).toEqual({ done: 3, total: 12 });
  });
  it('keeps current on an unrecognized line', () => {
    expect(parseYtdlpProgress('blah', { done: 5, total: 9 })).toEqual({ done: 5, total: 9 });
  });
});

describe('parseYtdlpPlaylistTitle', () => {
  it('extracts the playlist title', () => {
    expect(parseYtdlpPlaylistTitle('[download] Downloading playlist: My Playlist Title')).toBe(
      'My Playlist Title',
    );
  });
  it('returns null for non-playlist lines', () => {
    expect(parseYtdlpPlaylistTitle('[download]  45.2% of 5MiB')).toBeNull();
    expect(parseYtdlpPlaylistTitle('[download] Downloading item 1 of 10')).toBeNull();
    expect(parseYtdlpPlaylistTitle('')).toBeNull();
  });
});

describe('parseSpotdlProgress', () => {
  const start = { done: 0, total: 100 };

  it('sets total from "Found N songs in playlist" line', () => {
    expect(parseSpotdlProgress('Found 42 songs in playlist: My Mix', start)).toEqual({
      done: 0,
      total: 42,
    });
  });

  it('sets total from "Downloading N songs to" line', () => {
    expect(parseSpotdlProgress('Downloading 10 songs to /staging', start)).toEqual({
      done: 0,
      total: 10,
    });
  });

  it('increments done for Downloaded lines', () => {
    expect(parseSpotdlProgress('Downloaded "Song Name"', { done: 2, total: 10 })).toEqual({
      done: 3,
      total: 10,
    });
  });

  it('increments done for Skipping lines', () => {
    expect(parseSpotdlProgress('Skipping "Existing Song"', { done: 1, total: 10 })).toEqual({
      done: 2,
      total: 10,
    });
  });

  it('is case-insensitive for Found/Downloaded/Skipping', () => {
    expect(parseSpotdlProgress('found 5 songs in playlist', start)).toEqual({ done: 0, total: 5 });
    expect(parseSpotdlProgress('downloaded "x"', { done: 0, total: 5 })).toEqual({
      done: 1,
      total: 5,
    });
  });

  it('ignores zero-count Found lines', () => {
    expect(parseSpotdlProgress('Found 0 songs', start)).toEqual(start);
  });

  it('keeps current on unrecognized lines', () => {
    expect(parseSpotdlProgress('INFO: something else', { done: 3, total: 10 })).toEqual({
      done: 3,
      total: 10,
    });
  });
});

describe('runAcquireProcess', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    mkdirSync(tmpdir(), { recursive: true });
    stagingBase = mkdtempSync(join(tmpdir(), 'nd-acq-'));
  });
  afterEach(() => rmSync(stagingBase, { recursive: true, force: true }));

  it('spawns the binary with the given args', async () => {
    const r = run();
    fakeProc.finish(0);
    await r.done;
    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('yt-dlp');
    expect(args).toContain('https://example.com/v');
  });

  it('resolves with collected audio paths on exit 0', async () => {
    const r = run();
    seedAudio('Artist/Album/track.mp3');
    fakeProc.finish(0);
    const paths = await r.done;
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain('track.mp3');
  });

  it('reports progress through onProgress', async () => {
    const seen: number[] = [];
    const r = run({ onProgress: (p) => seen.push(p.done) });
    fakeProc.emitData('[download]  42.0% of 1MiB\n');
    fakeProc.finish(0);
    await r.done;
    expect(seen).toContain(42);
  });

  it('calls onLabel once when a playlist title line appears', async () => {
    const labels: string[] = [];
    const r = run({ onLabel: (l) => labels.push(l) });
    fakeProc.emitData('[download] Downloading playlist: My Mix\n');
    fakeProc.emitData('[download] Downloading playlist: Should be ignored\n');
    fakeProc.finish(0);
    await r.done;
    expect(labels).toEqual(['My Mix']);
  });

  it('rejects with stderr tail on a non-zero exit', async () => {
    const r = run();
    fakeProc.emitData('ERROR: boom\n');
    fakeProc.finish(1);
    await expect(r.done).rejects.toThrow(/boom/);
  });

  it('prefers ERROR: lines over progress spam in the rejection', async () => {
    const r = run();
    fakeProc.emitData('ERROR: [youtube] xyz: Video unavailable\n');
    // Reams of progress output that would otherwise crowd out the real cause.
    for (let i = 0; i < 50; i++) fakeProc.emitData(`[download]  ${i}.0% of 2MiB\n`);
    fakeProc.finish(1);
    await expect(r.done).rejects.toThrow(/Video unavailable/);
  });

  it('resolves with files on a non-zero exit when some downloaded (partial playlist)', async () => {
    // yt-dlp exits 1 because a playlist item was unavailable, but the rest
    // downloaded — we must keep them, not discard the whole job.
    const r = run();
    seedAudio('Artist/Album/track.mp3');
    fakeProc.emitData('ERROR: [youtube] dead: Video unavailable\n');
    fakeProc.finish(1);
    const paths = await r.done;
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain('track.mp3');
  });

  it('cancel sends SIGTERM', async () => {
    const r = run();
    const kill = mock(() => true);
    (fakeProc as unknown as { kill: typeof kill }).kill = kill;
    expect(r.cancel()).toBe(true);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    fakeProc.finish(0);
    await r.done.catch(() => {});
  });
});

describe('collectAudioPaths', () => {
  beforeEach(() => {
    mkdirSync(tmpdir(), { recursive: true });
    stagingBase = mkdtempSync(join(tmpdir(), 'nd-acq-'));
  });
  afterEach(() => rmSync(stagingBase, { recursive: true, force: true }));

  it('finds audio files recursively and ignores non-audio', () => {
    seedAudio('a/track.flac');
    seedAudio('a/cover.jpg');
    seedAudio('b/c/song.mp3');
    const paths = collectAudioPaths(stagingBase).sort();
    expect(paths.some((p) => p.endsWith('track.flac'))).toBe(true);
    expect(paths.some((p) => p.endsWith('song.mp3'))).toBe(true);
    expect(paths.some((p) => p.endsWith('cover.jpg'))).toBe(false);
  });
});
