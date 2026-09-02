import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeparationRejectedError, SeparationUnavailableError } from './separator-client.js';
import { _resetStemStoreForTests, type StemProducer } from './stem-store.js';
import {
  SEPARATION_COLD_START_SEC,
  SEPARATION_RTF,
  STEM_QUEUE_MAX,
  STEM_TRANSIENT_FAILURE_TTL_MS,
  VocalSeparationService,
  estimateEtaSec,
  separateTimeoutMs,
} from './vocal-separation.js';

describe('separateTimeoutMs', () => {
  it('is floored, scales with ~3x the measured RTF, and is capped', () => {
    expect(separateTimeoutMs(30)).toBe(120_000);
    expect(separateTimeoutMs(210)).toBe(Math.round(210 * SEPARATION_RTF * 3 * 1000 + 60_000));
    expect(separateTimeoutMs(100_000)).toBe(900_000);
  });
});

describe('estimateEtaSec', () => {
  it('is the remaining time of the running job for the job itself', () => {
    const eta = estimateEtaSec({
      running: { durationSec: 200, startedAt: 0 },
      thisIsRunning: true,
      thisDurationSec: 200,
      aheadDurations: [],
      now: 20_000,
    });
    expect(eta).toBe(Math.ceil(200 * SEPARATION_RTF - 20));
  });

  it('sums the running remainder, everything ahead, and itself for a queued job', () => {
    const eta = estimateEtaSec({
      running: { durationSec: 200, startedAt: 0 },
      thisIsRunning: false,
      thisDurationSec: 100,
      aheadDurations: [300],
      now: 10_000,
    });
    expect(eta).toBe(
      Math.ceil(200 * SEPARATION_RTF - 10 + 300 * SEPARATION_RTF + 100 * SEPARATION_RTF),
    );
  });

  it('adds a cold start when nothing is running (the worker may be idle-released)', () => {
    const eta = estimateEtaSec({
      running: null,
      thisIsRunning: false,
      thisDurationSec: 100,
      aheadDurations: [],
      now: 0,
    });
    expect(eta).toBe(Math.ceil(100 * SEPARATION_RTF + SEPARATION_COLD_START_SEC));
  });

  it('never reports less than one second', () => {
    expect(
      estimateEtaSec({
        running: { durationSec: 10, startedAt: 0 },
        thisIsRunning: true,
        thisDurationSec: 10,
        aheadDurations: [],
        now: 60_000,
      }),
    ).toBe(1);
  });
});

/** A producer whose completion the test controls, one deferred per call. */
function controlledProducer() {
  const pending: Array<{ relPath: string; resolve: () => void; reject: (e: Error) => void }> = [];
  const producer: StemProducer = (relPath) =>
    new Promise<Response>((resolve, reject) => {
      pending.push({
        relPath,
        resolve: () =>
          resolve(
            new Response(new Uint8Array(4096).fill(1), {
              headers: { 'content-type': 'audio/flac' },
            }),
          ),
        reject,
      });
    });
  return { producer, pending };
}

const tick = () => new Promise((r) => setTimeout(r, 10));
/** Bounded wait for a state the job runner reaches asynchronously (a stream write + rename). */
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await tick();
  }
}

describe('VocalSeparationService', () => {
  let dir = '';
  let cacheDir = '';
  let clock = 0;
  const tracks: Record<string, { abs: string; rel: string }> = {};

  beforeEach(() => {
    _resetStemStoreForTests();
    clock = 1_000_000;
    dir = mkdtempSync(join(tmpdir(), 'nicotind-vsep-'));
    cacheDir = join(dir, 'stem-cache');
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
      const abs = join(dir, `${name}.mp3`);
      writeFileSync(abs, 'x'.repeat(2048));
      tracks[name] = { abs, rel: `${name}.mp3` };
    }
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function make(overrides: Partial<ConstructorParameters<typeof VocalSeparationService>[0]> = {}) {
    const { producer, pending } = controlledProducer();
    const service = new VocalSeparationService({
      client: { healthy: async () => true, healthySnapshot: () => true },
      toggle: { enabled: () => true },
      stemCacheDir: cacheDir,
      ffmpegAvailable: () => true,
      producer,
      validate: async () => true,
      now: () => clock,
      ...overrides,
    });
    return { service, pending };
  }

  it('reports the structural reasons before touching the sidecar', async () => {
    const t = tracks.a;
    expect((await make({ client: null }).service.ensure(t.abs, t.rel, 200)).state).toBe(
      'unavailable',
    );
    expect(await make({ client: null }).service.ensure(t.abs, t.rel, 200)).toMatchObject({
      reason: 'not-configured',
    });
    expect(
      await make({ toggle: { enabled: () => false } }).service.ensure(t.abs, t.rel, 200),
    ).toMatchObject({
      reason: 'disabled',
    });
    expect(
      await make({ ffmpegAvailable: () => false }).service.ensure(t.abs, t.rel, 200),
    ).toMatchObject({
      reason: 'no-ffmpeg',
    });
    expect(
      await make({
        client: { healthy: async () => false, healthySnapshot: () => false },
      }).service.ensure(t.abs, t.rel, 200),
    ).toMatchObject({ reason: 'unhealthy' });
  });

  it('status() never enqueues; ensure() runs the job and both converge on ready', async () => {
    const { service, pending } = make();
    const t = tracks.a;
    expect(service.status(t.abs, 200)).toEqual({ state: 'idle' });
    expect(pending.length).toBe(0);

    const first = await service.ensure(t.abs, t.rel, 200);
    expect(first.state).toBe('preparing');
    await tick();
    expect(pending.length).toBe(1);
    // A second ensure joins the same job.
    expect((await service.ensure(t.abs, t.rel, 200)).state).toBe('preparing');
    expect(pending.length).toBe(1);

    pending[0].resolve();
    await until(() => service.status(t.abs, 200).state === 'ready');
    expect(service.readyStemPath(t.abs)).not.toBeNull();
  });

  it('serialises the GPU: the second track queues behind the first with a position and an ETA', async () => {
    const { service, pending } = make();
    await service.ensure(tracks.a.abs, tracks.a.rel, 200);
    const second = await service.ensure(tracks.b.abs, tracks.b.rel, 100);
    expect(second).toMatchObject({ state: 'queued', queuePosition: 1 });
    expect((second as { etaSec: number }).etaSec).toBeGreaterThan(Math.ceil(100 * SEPARATION_RTF));
    await tick();
    expect(pending.length).toBe(1); // b has not been sent to the sidecar yet

    pending[0].resolve();
    await until(() => service.status(tracks.a.abs, 200).state === 'ready');
    await until(() => pending.length === 2);
    expect(service.status(tracks.b.abs, 100).state).toBe('preparing');
    pending[1].resolve();
    await until(() => service.status(tracks.b.abs, 100).state === 'ready');
  });

  it('refuses beyond STEM_QUEUE_MAX with busy', async () => {
    const { service } = make();
    const names = Object.keys(tracks);
    // one running + STEM_QUEUE_MAX queued fill the sidecar's plate
    for (const name of names.slice(0, STEM_QUEUE_MAX + 1)) {
      const t = tracks[name];
      expect((await service.ensure(t.abs, t.rel, 100)).state).not.toBe('unavailable');
    }
    const extra = tracks[names[STEM_QUEUE_MAX + 1]];
    expect(await service.ensure(extra.abs, extra.rel, 100)).toEqual({
      state: 'unavailable',
      reason: 'busy',
    });
  });

  it('a rejected file is remembered as failed and never re-sent', async () => {
    const { service, pending } = make();
    const t = tracks.a;
    await service.ensure(t.abs, t.rel, 200);
    await tick();
    pending[0].reject(new SeparationRejectedError('undecodable'));
    await until(() => service.status(t.abs, 200).state === 'failed');
    expect(service.status(t.abs, 200)).toEqual({ state: 'failed', reason: 'rejected' });
    expect(await service.ensure(t.abs, t.rel, 200)).toEqual({
      state: 'failed',
      reason: 'rejected',
    });
    expect(pending.length).toBe(1);
  });

  it('a transient fault is remembered for a TTL, then retried', async () => {
    const { service, pending } = make();
    const t = tracks.a;
    await service.ensure(t.abs, t.rel, 200);
    await tick();
    pending[0].reject(new SeparationUnavailableError('worker died'));
    await until(() => service.status(t.abs, 200).state === 'failed');
    const failed = service.status(t.abs, 200);
    expect(failed).toMatchObject({ state: 'failed', reason: 'transient' });
    expect((failed as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(0);
    expect((await service.ensure(t.abs, t.rel, 200)).state).toBe('failed');
    expect(pending.length).toBe(1);

    clock += STEM_TRANSIENT_FAILURE_TTL_MS + 1;
    expect((await service.ensure(t.abs, t.rel, 200)).state).toBe('preparing');
    await until(() => pending.length === 2);
  });
});
