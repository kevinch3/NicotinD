import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runAcquireProcess,
  acquireEnv,
  isBinaryAvailable,
  invalidateBinaryCache,
  _resetBinaryCache,
  parseYtdlpProgress,
  parseYtdlpPlaylistTitle,
  parseYtdlpTrackEvent,
  parseSpotdlProgress,
  parseSpotdlTrackEvent,
  parseSpotdlPlaylistTitle,
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

describe('parseSpotdlTrackEvent', () => {
  it('returns {title, status: done} for a Downloaded line', () => {
    expect(parseSpotdlTrackEvent('Downloaded "Song Name"')).toEqual({
      title: 'Song Name',
      status: 'done',
    });
  });

  it('returns {title, status: skipped} for a Skipping line', () => {
    expect(parseSpotdlTrackEvent('Skipping "Existing Song"')).toEqual({
      title: 'Existing Song',
      status: 'skipped',
    });
  });

  it('is case-insensitive', () => {
    expect(parseSpotdlTrackEvent('downloaded "lowercase"')).toEqual({
      title: 'lowercase',
      status: 'done',
    });
  });

  it('returns null for unrelated lines', () => {
    expect(parseSpotdlTrackEvent('Found 5 songs')).toBeNull();
    expect(parseSpotdlTrackEvent('')).toBeNull();
  });
});

describe('parseSpotdlPlaylistTitle', () => {
  it('extracts the playlist title from a "Found N songs in playlist" line', () => {
    expect(parseSpotdlPlaylistTitle('Found 42 songs in playlist: My Mix')).toBe('My Mix');
  });

  it('is case-insensitive', () => {
    expect(parseSpotdlPlaylistTitle('found 3 songs in playlist: lowercase mix')).toBe(
      'lowercase mix',
    );
  });

  it('returns null when there is no playlist name', () => {
    expect(parseSpotdlPlaylistTitle('Found 42 songs')).toBeNull();
    expect(parseSpotdlPlaylistTitle('Downloaded "Song Name"')).toBeNull();
  });
});

describe('parseYtdlpTrackEvent', () => {
  it('returns {title, status: downloading} for a TRACK_START marker', () => {
    expect(parseYtdlpTrackEvent('TRACK_START::My Song Title')).toEqual({
      title: 'My Song Title',
      status: 'downloading',
      path: undefined,
    });
  });

  it('returns {title, status: done} for a TRACK_DONE marker', () => {
    expect(parseYtdlpTrackEvent('TRACK_DONE::My Song Title')).toEqual({
      title: 'My Song Title',
      status: 'done',
      path: undefined,
    });
  });

  it('trims surrounding whitespace from the title', () => {
    expect(parseYtdlpTrackEvent('TRACK_START::  Padded Title  ')).toEqual({
      title: 'Padded Title',
      status: 'downloading',
      path: undefined,
    });
  });

  it('extracts the filename when present after a tab separator', () => {
    expect(parseYtdlpTrackEvent('TRACK_START::Artist - My Song\ttrack01.opus')).toEqual({
      title: 'Artist - My Song',
      status: 'downloading',
      path: 'track01.opus',
    });
    expect(parseYtdlpTrackEvent('TRACK_DONE::Artist - My Song\ttrack01.opus')).toEqual({
      title: 'Artist - My Song',
      status: 'done',
      path: 'track01.opus',
    });
  });

  it('keeps "::" inside a title intact (tab, not "::", delimits the filename)', () => {
    // A title containing "::" propagates into the yt-dlp filename too — a
    // "::"-based delimiter would mis-split both fields. The tab separator
    // splits at the LAST tab so the title keeps its "::" verbatim.
    expect(
      parseYtdlpTrackEvent(
        'TRACK_START::Nujabes - Aruarian :: Dance\tNujabes - Aruarian :: Dance.opus',
      ),
    ).toEqual({
      title: 'Nujabes - Aruarian :: Dance',
      status: 'downloading',
      path: 'Nujabes - Aruarian :: Dance.opus',
    });
  });

  it('returns null for non-marker lines', () => {
    expect(parseYtdlpTrackEvent('[download]  45.2% of 5MiB')).toBeNull();
    expect(parseYtdlpTrackEvent('some TRACK_START::mid-line text')).toBeNull();
    expect(parseYtdlpTrackEvent('')).toBeNull();
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

  it('calls onTrack for every track event line, unlike the single-shot onLabel', async () => {
    const events: Array<{ title: string; status: string; path?: string }> = [];
    const r = run({ onTrack: (event) => events.push(event) });
    fakeProc.emitData('Downloaded "Song A"\n');
    fakeProc.emitData('Skipping "Song B"\n');
    fakeProc.emitData('Downloaded "Song A"\n'); // re-download/retag: fires again, not suppressed
    fakeProc.finish(0);
    await r.done;
    expect(events).toEqual([
      { title: 'Song A', status: 'done' },
      { title: 'Song B', status: 'skipped' },
      { title: 'Song A', status: 'done' },
    ]);
  });

  it('forwards the full TrackEvent (path included) for yt-dlp marker lines', async () => {
    // The `path` must survive this seam: the host's emitTrack keys the
    // acquire_job_tracks row on it, and dropping it here (the original bug)
    // silently disabled playlist materialization for every yt-dlp/spotdl job.
    const events: Array<{ title: string; status: string; path?: string }> = [];
    const r = run({ onTrack: (event) => events.push(event) });
    fakeProc.emitData('TRACK_START::My Song\ttrack01.opus\n');
    fakeProc.emitData('TRACK_DONE::My Song\ttrack01.opus\n');
    fakeProc.finish(0);
    await r.done;
    expect(events).toEqual([
      { title: 'My Song', status: 'downloading', path: 'track01.opus' },
      { title: 'My Song', status: 'done', path: 'track01.opus' },
    ]);
  });

  it('does not call onTrack for unrelated lines', async () => {
    const events: unknown[] = [];
    const r = run({ onTrack: (event) => events.push(event) });
    fakeProc.emitData('[download]  42.0% of 1MiB\n');
    fakeProc.finish(0);
    await r.done;
    expect(events).toEqual([]);
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

describe('acquireEnv', () => {
  it('prepends well-known user bin dirs missing from PATH', () => {
    const env = acquireEnv({ PATH: '/usr/bin:/bin', HOME: '/home/u' });
    const parts = env.PATH!.split(':');
    expect(parts).toContain('/opt/homebrew/bin');
    expect(parts).toContain('/usr/local/bin');
    expect(parts).toContain('/home/u/.local/bin');
    // Original entries preserved, extras prepended (so an explicit PATH
    // install still wins over nothing, and existing resolution is unchanged).
    expect(env.PATH!.endsWith('/usr/bin:/bin')).toBe(true);
  });

  it('does not duplicate dirs already on PATH', () => {
    const env = acquireEnv({ PATH: '/usr/local/bin:/usr/bin', HOME: '/home/u' });
    const occurrences = env.PATH!.split(':').filter((p) => p === '/usr/local/bin');
    expect(occurrences).toHaveLength(1);
  });

  it('prepends the bundled ffmpeg dir first when NICOTIND_FFMPEG_PATH is set', () => {
    const env = acquireEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      NICOTIND_FFMPEG_PATH: '/opt/app/resources/bin/ffmpeg',
    });
    expect(env.PATH!.split(':')[0]).toBe('/opt/app/resources/bin');
  });

  it('keeps unrelated env vars intact', () => {
    const env = acquireEnv({ PATH: '/usr/bin', HOME: '/home/u', FOO: 'bar' });
    expect(env.FOO).toBe('bar');
  });
});

describe('runAcquireProcess env', () => {
  beforeEach(() => {
    stagingBase = mkdtempSync(join(tmpdir(), 'nd-acq-'));
  });
  afterEach(() => rmSync(stagingBase, { recursive: true, force: true }));

  it('spawns the downloader with the augmented PATH env', async () => {
    const r = run();
    const call = spawnMock.mock.calls[spawnMock.mock.calls.length - 1] as unknown[];
    const options = call[2] as { env?: NodeJS.ProcessEnv };
    expect(options.env?.PATH).toBeDefined();
    expect(options.env!.PATH!.split(':')).toContain('/usr/local/bin');
    fakeProc.finish(0);
    await r.done.catch(() => {});
  });
});

describe('isBinaryAvailable', () => {
  beforeEach(() => _resetBinaryCache());

  it('probes with the augmented env and caches the result', () => {
    const execCalls: Array<{ env?: NodeJS.ProcessEnv }> = [];
    const exec = ((_bin: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      execCalls.push(opts);
      return Buffer.from('');
    }) as unknown as Parameters<typeof isBinaryAvailable>[1];

    expect(isBinaryAvailable('fake-dl', exec)).toBe(true);
    expect(isBinaryAvailable('fake-dl', exec)).toBe(true);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]!.env?.PATH?.split(':')).toContain('/usr/local/bin');
  });

  it('invalidateBinaryCache clears a cached negative so a new install is seen', () => {
    let installed = false;
    const exec = ((_bin: string) => {
      if (!installed) throw new Error('not found');
      return Buffer.from('');
    }) as unknown as Parameters<typeof isBinaryAvailable>[1];

    expect(isBinaryAvailable('fake-dl', exec)).toBe(false);
    installed = true;
    expect(isBinaryAvailable('fake-dl', exec)).toBe(false); // still cached
    invalidateBinaryCache('fake-dl');
    expect(isBinaryAvailable('fake-dl', exec)).toBe(true);
  });
});
