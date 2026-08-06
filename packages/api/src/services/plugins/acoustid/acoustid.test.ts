import { describe, expect, it, beforeEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { spawn as nodeSpawn } from 'node:child_process';
import { AcoustidPlugin } from './index.js';
import { _resetBinaryCache } from '../acquire/process.js';

// Injected spawn fake (NOT mock.module — that leaks node:child_process globally).
class FakeStream extends EventEmitter {}
class FakeProc extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  emitData(chunk: string): void {
    this.stdout.emit('data', Buffer.from(chunk));
  }
  emitStderr(chunk: string): void {
    this.stderr.emit('data', Buffer.from(chunk));
  }
  /** The binary isn't there — node reports spawn failure, never a close code. */
  failToSpawn(message = 'spawn fpcalc ENOENT'): void {
    this.emit('error', new Error(message));
  }
  finish(code: number): void {
    this.emit('close', code);
  }
}

const FPCALC_JSON = JSON.stringify({ duration: 180, fingerprint: 'AQAB...fake' });

function fakeSpawn(behavior: (proc: FakeProc) => void): typeof nodeSpawn {
  return ((..._args: unknown[]) => {
    const proc = new FakeProc();
    // Defer so the caller can attach listeners before events fire.
    queueMicrotask(() => behavior(proc));
    return proc as unknown as ReturnType<typeof nodeSpawn>;
  }) as typeof nodeSpawn;
}

const LOOKUP_RESPONSE = {
  status: 'ok',
  results: [
    {
      id: 'acoustid-uuid-1',
      score: 0.93,
      recordings: [
        {
          id: 'mb-recording-1',
          title: 'Test Title',
          artists: [{ name: 'Test Artist' }],
          releases: [
            {
              id: 'mb-release-1',
              title: 'Test Album',
              date: { year: 2001 },
              artists: [{ name: 'Test Artist' }],
            },
          ],
        },
      ],
    },
  ],
};

describe('AcoustidPlugin', () => {
  beforeEach(() => _resetBinaryCache());

  it('is unavailable without an api key', async () => {
    const plugin = new AcoustidPlugin({});
    expect(await plugin.isAvailable()).toBe(false);
  });

  it('identifyTrack maps an AcoustID response', async () => {
    const spawnFn = fakeSpawn((proc) => {
      proc.emitData(FPCALC_JSON);
      proc.finish(0);
    });
    const fetchFn = (async () =>
      new Response(JSON.stringify(LOOKUP_RESPONSE), { status: 200 })) as unknown as typeof fetch;

    const plugin = new AcoustidPlugin({ apiKey: 'test-key' }, { spawnFn, fetchFn });
    const result = await plugin.identify.identifyTrack('/music/track.flac');

    // The engine's return type carries a couple of extra fields
    // (`albumArtist`/`trackNumber`) that only `library-organizer.ts` uses —
    // the `IdentifyCapability` contract only promises the core fields.
    expect(result).toMatchObject({
      acoustId: 'acoustid-uuid-1',
      score: 0.93,
      artist: 'Test Artist',
      album: 'Test Album',
      title: 'Test Title',
      year: 2001,
      recordingId: 'mb-recording-1',
      releaseId: 'mb-release-1',
    });
  });

  it('identifyTrack returns null when fpcalc exits non-zero', async () => {
    const spawnFn = fakeSpawn((proc) => {
      proc.finish(1);
    });
    const fetchFn = (async () => {
      throw new Error('should never be called');
    }) as unknown as typeof fetch;

    const plugin = new AcoustidPlugin({ apiKey: 'test-key' }, { spawnFn, fetchFn });
    const result = await plugin.identify.identifyTrack('/music/track.flac');

    expect(result).toBeNull();
  });

  // Issue #414: identifyTrack's null collapsed four different situations into
  // one; identifyTrackDetailed names them, because they ask the curator for
  // opposite actions (retag vs install a binary vs discard a corrupt file vs
  // retry later).
  describe('identifyTrackDetailed outcome taxonomy (issue #414)', () => {
    const neverFetch = (async () => {
      throw new Error('should never be called');
    }) as unknown as typeof fetch;

    it('reports a match', async () => {
      const spawnFn = fakeSpawn((proc) => {
        proc.emitData(FPCALC_JSON);
        proc.finish(0);
      });
      const fetchFn = (async () =>
        new Response(JSON.stringify(LOOKUP_RESPONSE), { status: 200 })) as unknown as typeof fetch;
      const plugin = new AcoustidPlugin({ apiKey: 'test-key' }, { spawnFn, fetchFn });

      const outcome = await plugin.identify.identifyTrackDetailed!('/music/track.flac');
      expect(outcome.kind).toBe('match');
      expect(outcome.kind === 'match' && outcome.result.acoustId).toBe('acoustid-uuid-1');
    });

    it('distinguishes a genuine no-match (AcoustID answered, empty)', async () => {
      const spawnFn = fakeSpawn((proc) => {
        proc.emitData(FPCALC_JSON);
        proc.finish(0);
      });
      const fetchFn = (async () =>
        new Response(JSON.stringify({ status: 'ok', results: [] }), {
          status: 200,
        })) as unknown as typeof fetch;
      const plugin = new AcoustidPlugin({ apiKey: 'test-key' }, { spawnFn, fetchFn });

      expect(await plugin.identify.identifyTrackDetailed!('/music/track.flac')).toEqual({
        kind: 'no-match',
      });
    });

    it('distinguishes a missing fpcalc binary from anything file-related', async () => {
      const spawnFn = fakeSpawn((proc) => proc.failToSpawn());
      const plugin = new AcoustidPlugin({ apiKey: 'test-key' }, { spawnFn, fetchFn: neverFetch });

      const outcome = await plugin.identify.identifyTrackDetailed!('/music/track.flac');
      expect(outcome.kind).toBe('fpcalc-missing');
      expect(outcome.kind !== 'match' && outcome.detail).toContain('ENOENT');
    });

    it('reports an undecodable file and carries fpcalc stderr out with it', async () => {
      const spawnFn = fakeSpawn((proc) => {
        proc.emitStderr('ERROR: could not decode audio: invalid data found\n');
        proc.finish(1);
      });
      const plugin = new AcoustidPlugin({ apiKey: 'test-key' }, { spawnFn, fetchFn: neverFetch });

      const outcome = await plugin.identify.identifyTrackDetailed!('/music/track.flac');
      expect(outcome.kind).toBe('undecodable');
      // The stderr tail is the whole point — a curator sees why the file failed.
      expect(outcome.kind !== 'match' && outcome.detail).toContain('could not decode audio');
    });

    it('treats exit-0-with-no-fingerprint as a file problem, not a no-match', async () => {
      const spawnFn = fakeSpawn((proc) => {
        proc.emitData(JSON.stringify({ duration: 0, fingerprint: '' }));
        proc.finish(0);
      });
      const plugin = new AcoustidPlugin({ apiKey: 'test-key' }, { spawnFn, fetchFn: neverFetch });

      expect((await plugin.identify.identifyTrackDetailed!('/music/track.flac')).kind).toBe(
        'undecodable',
      );
    });

    it('reports an AcoustID HTTP failure as transient, never as no-match', async () => {
      const spawnFn = fakeSpawn((proc) => {
        proc.emitData(FPCALC_JSON);
        proc.finish(0);
      });
      const fetchFn = (async () =>
        new Response('nope', { status: 503 })) as unknown as typeof fetch;
      const plugin = new AcoustidPlugin({ apiKey: 'test-key' }, { spawnFn, fetchFn });

      const outcome = await plugin.identify.identifyTrackDetailed!('/music/track.flac');
      expect(outcome.kind).toBe('source-error');
      expect(outcome.kind !== 'match' && outcome.detail).toContain('503');
    });

    it('an unconfigured plugin is a source-error, not a no-match', async () => {
      const plugin = new AcoustidPlugin({});
      expect((await plugin.identify.identifyTrackDetailed!('/music/track.flac')).kind).toBe(
        'source-error',
      );
    });

    it('plain identifyTrack still returns match-or-null (unchanged contract)', async () => {
      const spawnFn = fakeSpawn((proc) => {
        proc.emitStderr('boom');
        proc.finish(1);
      });
      const plugin = new AcoustidPlugin({ apiKey: 'test-key' }, { spawnFn, fetchFn: neverFetch });
      expect(await plugin.identify.identifyTrack('/music/track.flac')).toBeNull();
    });
  });
});
