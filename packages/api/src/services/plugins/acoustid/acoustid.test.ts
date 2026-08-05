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
});
