import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawn as nodeSpawn } from 'node:child_process';
import { validatePluginManifest, type PluginHostContext } from '@nicotind/core';
import { _resetBinaryCache } from '../acquire/process.js';
import { SpotdlPlugin } from './index.js';

describe('SpotdlPlugin', () => {
  beforeEach(() => _resetBinaryCache());

  it('has a valid consent-gated acquisition manifest', () => {
    const p = new SpotdlPlugin({ enabled: true, binaryPath: 'spotdl' });
    expect(validatePluginManifest(p.manifest)).toEqual([]);
    expect(p.manifest.capabilities).toEqual(['resolve']);
    expect(p.manifest.requirements?.binaries).toEqual(['spotdl']);
    expect(p.manifest.compliance?.requiresConsent).toBe(true);
  });

  it('handles Spotify URLs only', () => {
    const p = new SpotdlPlugin({ enabled: true, binaryPath: 'spotdl' });
    expect(p.resolve.canHandle('https://open.spotify.com/album/x')).toBe(true);
    expect(p.resolve.canHandle('https://www.youtube.com/watch?v=x')).toBe(false);
  });

  it('reports availability from enabled flag + binary presence', async () => {
    expect(await new SpotdlPlugin({ enabled: false, binaryPath: 'bun' }).isAvailable()).toBe(false);
    expect(await new SpotdlPlugin({ enabled: true, binaryPath: 'bun' }).isAvailable()).toBe(true);
    expect(
      await new SpotdlPlugin({ enabled: true, binaryPath: '/no/such/binary-xyz' }).isAvailable(),
    ).toBe(false);
  });

  // resolve() drives the shared acquire engine through the injected spawn — no
  // real spotdl binary or process-global module mock required.
  describe('resolve', () => {
    let tmp: string;
    let stagingDir: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'nicotind-spotdl-'));
    });
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    /** Minimal host context: resolve() uses allocStagingDir, emitProgress, emitLabel, emitTrack. */
    function fakeCtx(
      progress: Array<{ done: number; total: number }>,
      labels: string[] = [],
      tracks: Array<{ title: string; status: string }> = [],
    ): PluginHostContext {
      return {
        allocStagingDir: (jobId: string) => {
          stagingDir = join(tmp, jobId);
          mkdirSync(stagingDir, { recursive: true });
          return stagingDir;
        },
        emitProgress: (_jobId: string, p: { done: number; total: number }) => progress.push(p),
        emitLabel: (_jobId: string, label: string) => labels.push(label),
        emitTrack: (_jobId: string, evt: { title: string; status: string }) => tracks.push(evt),
      } as unknown as PluginHostContext;
    }

    function fakeSpawn() {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = mock(() => true);
      const calls: Array<{ bin: string; args: string[] }> = [];
      const spawn = mock((bin: string, args: string[]) => {
        calls.push({ bin, args });
        return child;
      });
      return { spawn: spawn as unknown as typeof nodeSpawn, child, calls };
    }

    it('spawns the configured binary with the spotify URL + staging output template', async () => {
      const { spawn, child, calls } = fakeSpawn();
      const plugin = new SpotdlPlugin({ enabled: true, binaryPath: 'spotdl' }, { spawn });
      await plugin.init(fakeCtx([]));

      const url = 'https://open.spotify.com/album/abc';
      const done = plugin.resolve.resolve(url, 'job-1');
      // A file landed → success regardless of exit code.
      writeFileSync(join(stagingDir, 'song.mp3'), 'x');
      child.emit('close', 0);
      await done;

      expect(calls).toHaveLength(1);
      expect(calls[0]!.bin).toBe('spotdl');
      expect(calls[0]!.args[0]).toBe('download');
      expect(calls[0]!.args).toContain(url);
      expect(calls[0]!.args).toContain('--output');
      expect(calls[0]!.args.some((a) => a.startsWith(stagingDir))).toBe(true);
    });

    it('passes --overwrite skip so a resumed run does not re-download existing files', async () => {
      const { spawn, child, calls } = fakeSpawn();
      const plugin = new SpotdlPlugin({ enabled: true, binaryPath: 'spotdl' }, { spawn });
      await plugin.init(fakeCtx([]));

      const done = plugin.resolve.resolve('https://open.spotify.com/album/abc', 'job-skip');
      writeFileSync(join(stagingDir, 'song.mp3'), 'x');
      child.emit('close', 0);
      await done;

      const args = calls[0]!.args;
      expect(args[args.indexOf('--overwrite') + 1]).toBe('skip');
    });

    it('resolves with staged audio paths and forwards progress', async () => {
      const progress: Array<{ done: number; total: number }> = [];
      const { spawn, child } = fakeSpawn();
      const plugin = new SpotdlPlugin({ enabled: true, binaryPath: 'spotdl' }, { spawn });
      await plugin.init(fakeCtx(progress));

      const done = plugin.resolve.resolve('https://open.spotify.com/track/x', 'job-2');
      child.stdout.emit('data', Buffer.from('Found 1 songs in playlist\n'));
      child.stdout.emit('data', Buffer.from('Downloaded "Some Song"\n'));
      const file = join(stagingDir, 'track.mp3');
      writeFileSync(file, 'x');
      child.emit('close', 0);

      expect(await done).toEqual([file]);
      expect(progress.at(-1)).toEqual({ done: 1, total: 1 });
    });

    it('rejects with the captured error when the process produces nothing and exits non-zero', async () => {
      const { spawn, child } = fakeSpawn();
      const plugin = new SpotdlPlugin({ enabled: true, binaryPath: 'spotdl' }, { spawn });
      await plugin.init(fakeCtx([]));

      const done = plugin.resolve.resolve('https://open.spotify.com/track/x', 'job-3');
      child.stderr.emit('data', Buffer.from('ERROR: no results found\n'));
      child.emit('close', 1);

      await expect(done).rejects.toThrow('no results found');
    });

    it('passes --cookie-file when the configured cookies file exists', async () => {
      const cookies = join(tmp, 'youtube-cookies.txt');
      writeFileSync(cookies, '# Netscape HTTP Cookie File\n');
      const { spawn, child, calls } = fakeSpawn();
      const plugin = new SpotdlPlugin(
        { enabled: true, binaryPath: 'spotdl', cookiesFile: cookies },
        { spawn },
      );
      await plugin.init(fakeCtx([]));

      const done = plugin.resolve.resolve('https://open.spotify.com/track/x', 'job-c1');
      writeFileSync(join(stagingDir, 'song.mp3'), 'x');
      child.emit('close', 0);
      await done;

      const args = calls[0]!.args;
      expect(args[args.indexOf('--cookie-file') + 1]).toBe(cookies);
    });

    it('omits --cookie-file when the configured cookies file is missing', async () => {
      const { spawn, child, calls } = fakeSpawn();
      const plugin = new SpotdlPlugin(
        { enabled: true, binaryPath: 'spotdl', cookiesFile: join(tmp, 'no-such-cookies.txt') },
        { spawn },
      );
      await plugin.init(fakeCtx([]));

      const done = plugin.resolve.resolve('https://open.spotify.com/track/x', 'job-c2');
      writeFileSync(join(stagingDir, 'song.mp3'), 'x');
      child.emit('close', 0);
      await done;

      expect(calls[0]!.args).not.toContain('--cookie-file');
    });

    it('throws when resolving before init()', () => {
      const { spawn } = fakeSpawn();
      const plugin = new SpotdlPlugin({ enabled: true, binaryPath: 'spotdl' }, { spawn });
      expect(plugin.resolve.resolve('https://open.spotify.com/track/x', 'job-4')).rejects.toThrow(
        'not initialized',
      );
    });

    it('fires onLabel and onTrack callbacks from spotdl output', async () => {
      const progress: Array<{ done: number; total: number }> = [];
      const labels: string[] = [];
      const tracks: Array<{ title: string; status: string }> = [];
      const { spawn, child } = fakeSpawn();
      const plugin = new SpotdlPlugin({ enabled: true, binaryPath: 'spotdl' }, { spawn });
      await plugin.init(fakeCtx(progress, labels, tracks));

      const done = plugin.resolve.resolve('https://open.spotify.com/playlist/abc', 'job-label-track');
      // Simulate spotdl output: playlist title, then track downloads and skips
      child.stdout.emit('data', Buffer.from('Found 3 songs in playlist: My Mix\n'));
      child.stdout.emit('data', Buffer.from('Downloaded "Song A"\n'));
      child.stdout.emit('data', Buffer.from('Skipping "Song B"\n'));
      const file = join(stagingDir, 'song.mp3');
      writeFileSync(file, 'x');
      child.emit('close', 0);

      await done;
      expect(labels).toEqual(['My Mix']);
      expect(tracks).toEqual([
        { title: 'Song A', status: 'done' },
        { title: 'Song B', status: 'skipped' },
      ]);
    });
  });
});

describe('SpotdlPlugin binaryPath config', () => {
  beforeEach(() => _resetBinaryCache());

  it('exposes binaryPath as an editable config field', () => {
    const p = new SpotdlPlugin({ enabled: true, binaryPath: 'spotdl' });
    expect(p.manifest.configFields?.some((f) => f.key === 'binaryPath')).toBe(true);
    const parsed = p.manifest.configSchema!.safeParse({ binaryPath: '/usr/local/bin/spotdl' });
    expect(parsed.success).toBe(true);
  });
});
