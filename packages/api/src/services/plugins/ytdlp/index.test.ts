import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validatePluginManifest, type PluginHostContext } from '@nicotind/core';
import { _resetBinaryCache, isBinaryAvailable } from '../acquire/process.js';
import { YtdlpPlugin, type YtdlpPluginConfig } from './index.js';

class FakeProc extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  finish(code: number) {
    this.emit('close', code);
  }
}
let fakeProc: FakeProc;
const spawnMock = mock((..._args: unknown[]) => {
  fakeProc = new FakeProc();
  return fakeProc;
});

let staging: string;
function fakeCtx(): PluginHostContext {
  return {
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as unknown as PluginHostContext['logger'],
    config: {},
    allocStagingDir(jobId) {
      const dir = join(staging, jobId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    emitProgress() {},
    emitLabel() {},
    emitTrack() {},
    storage: { get: () => null, set() {}, delete() {} },
  };
}

const cfg = (over: Partial<YtdlpPluginConfig> = {}): YtdlpPluginConfig => ({
  enabled: true,
  binaryPath: 'yt-dlp',
  format: 'bestaudio',
  extraArgs: [],
  ...over,
});

describe('YtdlpPlugin', () => {
  beforeEach(() => {
    _resetBinaryCache();
    spawnMock.mockClear();
    mkdirSync(tmpdir(), { recursive: true });
    staging = mkdtempSync(join(tmpdir(), 'nd-ytp-'));
  });
  afterEach(() => rmSync(staging, { recursive: true, force: true }));

  it('has a valid consent-gated acquisition manifest', () => {
    const p = new YtdlpPlugin(cfg());
    expect(validatePluginManifest(p.manifest)).toEqual([]);
    expect(p.manifest.capabilities).toEqual(['resolve']);
    expect(p.manifest.requirements?.binaries).toEqual(['yt-dlp']);
    expect(p.manifest.compliance?.requiresConsent).toBe(true);
  });

  it('handles non-Spotify URLs only', () => {
    const p = new YtdlpPlugin(cfg());
    expect(p.resolve.canHandle('https://www.youtube.com/watch?v=x')).toBe(true);
    expect(p.resolve.canHandle('https://open.spotify.com/track/x')).toBe(false);
  });

  it('reports availability from enabled flag + binary presence', async () => {
    expect(await new YtdlpPlugin(cfg({ enabled: false, binaryPath: 'bun' })).isAvailable()).toBe(
      false,
    );
    expect(await new YtdlpPlugin(cfg({ enabled: true, binaryPath: 'bun' })).isAvailable()).toBe(
      true,
    );
    expect(
      await new YtdlpPlugin(
        cfg({ enabled: true, binaryPath: '/no/such/binary-xyz' }),
      ).isAvailable(),
    ).toBe(false);
  });

  it('builds yt-dlp args (extract-audio, format, extraArgs) and returns staged files', async () => {
    const p = new YtdlpPlugin(cfg({ format: 'mp3', extraArgs: ['--sleep-requests', '1'] }), {
      spawn: spawnMock as never,
    });
    await p.init(fakeCtx());
    const done = p.resolve.resolve('https://youtu.be/abc', 'j1');
    fakeProc.finish(0);
    await done;

    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('yt-dlp');
    expect(args).toContain('--extract-audio');
    expect(args).toContain('--audio-format');
    expect(args).toContain('mp3');
    expect(args).toContain('--sleep-requests');
    // Partly-unavailable playlists must not fail the whole job.
    expect(args).toContain('--ignore-errors');
  });

  it('adds --print track-marker flags to the yt-dlp args', async () => {
    const p = new YtdlpPlugin(cfg(), { spawn: spawnMock as never });
    await p.init(fakeCtx());
    const done = p.resolve.resolve('https://youtu.be/abc', 'j-print');
    fakeProc.finish(0);
    await done;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const startTemplate = 'before_dl:TRACK_START::%(artist)s - %(title)s\t%(filename)s';
    const doneTemplate = 'after_move:TRACK_DONE::%(artist)s - %(title)s\t%(filename)s';
    expect(args).toContain(startTemplate);
    expect(args).toContain(doneTemplate);
    // Both come after their own --print flag.
    expect(args[args.indexOf(startTemplate) - 1]).toBe('--print');
    expect(args[args.indexOf(doneTemplate) - 1]).toBe('--print');
  });

  it('fires onTrack via ctx.emitTrack on TRACK_START/TRACK_DONE stdout lines', async () => {
    const emitTrack = mock((_jobId: string, _event: unknown) => {});
    const ctx = { ...fakeCtx(), emitTrack };
    const p = new YtdlpPlugin(cfg(), { spawn: spawnMock as never });
    await p.init(ctx);
    const done = p.resolve.resolve('https://youtu.be/abc', 'j-track');
    // yt-dlp's --print WHEN:TEMPLATE syntax only controls *when* the line is
    // printed — the printed stdout line is just TEMPLATE evaluated, with no
    // "before_dl:"/"after_move:" prefix. Mirror that exactly here.
    fakeProc.stdout.emit(
      'data',
      Buffer.from('TRACK_START::Some Artist - Some Title\tSome Artist - Some Title.opus\n'),
    );
    fakeProc.stdout.emit(
      'data',
      Buffer.from('TRACK_DONE::Some Artist - Some Title\tSome Artist - Some Title.opus\n'),
    );
    fakeProc.finish(0);
    await done;

    // The `path` must reach emitTrack intact — the host's acquire_job_tracks
    // insert (and thus playlist materialization) depends on it.
    expect(emitTrack).toHaveBeenCalledTimes(2);
    expect(emitTrack.mock.calls[0]).toEqual([
      'j-track',
      {
        title: 'Some Artist - Some Title',
        status: 'downloading',
        path: 'Some Artist - Some Title.opus',
      },
    ]);
    expect(emitTrack.mock.calls[1]).toEqual([
      'j-track',
      {
        title: 'Some Artist - Some Title',
        status: 'done',
        path: 'Some Artist - Some Title.opus',
      },
    ]);
  });

  it('passes --cookies when the configured cookies file exists', async () => {
    const cookies = join(staging, 'youtube-cookies.txt');
    writeFileSync(cookies, '# Netscape HTTP Cookie File\n');
    const p = new YtdlpPlugin(cfg({ cookiesFile: cookies }), { spawn: spawnMock as never });
    await p.init(fakeCtx());
    const done = p.resolve.resolve('https://youtu.be/abc', 'j2');
    fakeProc.finish(0);
    await done;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args[args.indexOf('--cookies') + 1]).toBe(cookies);
  });

  it('omits --cookies when the configured cookies file is missing', async () => {
    const p = new YtdlpPlugin(cfg({ cookiesFile: join(staging, 'no-such-cookies.txt') }), {
      spawn: spawnMock as never,
    });
    await p.init(fakeCtx());
    const done = p.resolve.resolve('https://youtu.be/abc', 'j3');
    fakeProc.finish(0);
    await done;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--cookies');
  });
});

describe('YtdlpPlugin binaryPath config', () => {
  beforeEach(() => _resetBinaryCache());

  it('exposes binaryPath as an editable config field', () => {
    const p = new YtdlpPlugin(cfg());
    expect(p.manifest.configFields?.some((f) => f.key === 'binaryPath')).toBe(true);
    const parsed = p.manifest.configSchema!.safeParse({ binaryPath: '/opt/homebrew/bin/yt-dlp' });
    expect(parsed.success).toBe(true);
  });

  it('init clears a stale cached negative for the configured binary', async () => {
    // Seed the cache with "not installed" for a custom path, as if probed
    // before the user installed the binary.
    const failing = (() => {
      throw new Error('not found');
    }) as unknown as Parameters<typeof isBinaryAvailable>[1];
    expect(isBinaryAvailable('yt-dlp-custom', failing)).toBe(false);

    const p = new YtdlpPlugin(cfg());
    const ctx = fakeCtx();
    (ctx as { config: Record<string, unknown> }).config = { binaryPath: 'yt-dlp-custom' };
    await p.init(ctx);

    // Cache was invalidated by init — a fresh probe now runs (and succeeds).
    const succeeding = (() => Buffer.from('')) as unknown as Parameters<
      typeof isBinaryAvailable
    >[1];
    expect(isBinaryAvailable('yt-dlp-custom', succeeding)).toBe(true);
  });
});
