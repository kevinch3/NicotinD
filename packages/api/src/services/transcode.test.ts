import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as realCpNamespace from 'node:child_process';
import * as realFsNamespace from 'node:fs';

// Snapshot the real modules BEFORE mocking so we can restore them afterward —
// bun's mock.module is process-global and not auto-restored, so leaving these
// stubs in place would break later test files that spawn processes / touch fs.
const realCp = { ...realCpNamespace };
const realFs = { ...realFsNamespace };

// Mutable knobs the mocks read, reset per test.
let execThrows = false;
let lastProc: FakeProc | null = null;
let lastSpawnArgs: string[] | null = null;
const renamed: Array<{ from: string; to: string }> = [];
const unlinked: string[] = [];

class FakeProc extends EventEmitter {
  stderr = new EventEmitter();
}

mock.module('node:child_process', () => ({
  execFileSync: () => {
    if (execThrows) throw new Error('ffmpeg: command not found');
    return Buffer.from('');
  },
  spawn: (_cmd: string, args: string[]) => {
    lastSpawnArgs = args;
    lastProc = new FakeProc();
    return lastProc;
  },
}));

mock.module('node:fs', () => ({
  // A transcode temp file (`…​.tmp-<pid>-<now>`) is always treated as present so
  // the cleanup path exercises unlink; renamed targets are otherwise absent.
  existsSync: (p: string) => p.includes('.tmp-'),
  renameSync: (from: string, to: string) => {
    renamed.push({ from, to });
  },
  unlinkSync: (p: string) => {
    unlinked.push(p);
  },
}));

// Import the SUT AFTER the mocks are registered.
const {
  ffmpegAvailable,
  _resetFfmpegProbe,
  transcodeToFile,
  transcodeExt,
  transcodeContentType,
} = await import('./transcode.js');

afterAll(() => {
  mock.module('node:child_process', () => realCp);
  mock.module('node:fs', () => realFs);
});

beforeEach(() => {
  execThrows = false;
  lastProc = null;
  lastSpawnArgs = null;
  renamed.length = 0;
  unlinked.length = 0;
  _resetFfmpegProbe();
});

describe('format contract (pure)', () => {
  it('maps each format to its cache extension', () => {
    expect(transcodeExt('mp3')).toBe('mp3');
    expect(transcodeExt('opus')).toBe('opus');
    expect(transcodeExt('aac')).toBe('aac');
  });

  it('advertises the correct Content-Type per format (aac must not be sniffed)', () => {
    expect(transcodeContentType('mp3')).toBe('audio/mpeg');
    expect(transcodeContentType('opus')).toBe('audio/ogg');
    expect(transcodeContentType('aac')).toBe('audio/aac');
  });
});

describe('ffmpegAvailable', () => {
  it('returns true when the probe succeeds and caches the result', () => {
    expect(ffmpegAvailable()).toBe(true);
    // Once cached, flipping the probe to throw has no effect until reset.
    execThrows = true;
    expect(ffmpegAvailable()).toBe(true);
  });

  it('returns false when the ffmpeg probe throws', () => {
    execThrows = true;
    expect(ffmpegAvailable()).toBe(false);
  });
});

describe('transcodeToFile', () => {
  it('atomically renames the temp file into place on exit code 0', async () => {
    const p = transcodeToFile('/in.flac', '/out.mp3', 'mp3', 192);
    lastProc!.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
    expect(renamed).toHaveLength(1);
    expect(renamed[0]!.to).toBe('/out.mp3');
    expect(renamed[0]!.from).toStartWith('/out.mp3.tmp-');
    expect(unlinked).toHaveLength(0); // success never cleans up
  });

  it('rejects with the ffmpeg message and cleans up the temp on a non-zero exit', async () => {
    const p = transcodeToFile('/in.flac', '/out.mp3', 'mp3', 192, false);
    lastProc!.stderr.emit('data', Buffer.from('boom'));
    lastProc!.emit('close', 1);
    await expect(p).rejects.toThrow(/ffmpeg exited 1: boom/);
    expect(unlinked.some((u) => u.startsWith('/out.mp3.tmp-'))).toBe(true);
    expect(renamed).toHaveLength(0);
  });

  it('rejects and cleans up when the process errors (e.g. ffmpeg missing)', async () => {
    const p = transcodeToFile('/in.flac', '/out.mp3', 'mp3', 192);
    lastProc!.emit('error', new Error('spawn ENOENT'));
    await expect(p).rejects.toThrow(/ENOENT/);
    expect(unlinked.some((u) => u.startsWith('/out.mp3.tmp-'))).toBe(true);
  });

  it('omits the -af filter when vocal removal is off', async () => {
    const p = transcodeToFile('/in.flac', '/out.mp3', 'mp3', 192, false);
    lastProc!.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
    expect(lastSpawnArgs).not.toContain('-af');
  });

  it('applies the center-channel cancellation filter when vocal removal is on', async () => {
    const p = transcodeToFile('/in.flac', '/out.mp3', 'mp3', 192, true);
    lastProc!.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
    const af = lastSpawnArgs!.indexOf('-af');
    expect(af).toBeGreaterThanOrEqual(0);
    // Center cancellation: each output channel is the L/R difference, so anything
    // panned dead-center (typically lead vocals) cancels out.
    expect(lastSpawnArgs![af + 1]).toBe('pan=stereo|c0=c0-c1|c1=c1-c0');
  });
});
