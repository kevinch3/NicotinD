/**
 * Tests for ServiceReview (`GET /api/admin/review`):
 *   - admin-only (403 for non-admin)
 *   - aggregates every sub-fetch under `deps.subFns`
 *   - never drops the whole resource when a sub-fetch throws (graceful degrade
 *     into `errors[]` + per-field fallback)
 *   - injected `gpuProbe` / `os` shim propagates to `collectMetrics`
 */
import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import type { JwtPayload } from '@nicotind/core';
import { reviewRoutes, type ServiceReview } from './review.js';
import type { AuthEnv } from '../middleware/auth.js';
import type { MetricsSnapshot } from '../services/system-metrics.js';

function makeAdminUser(): JwtPayload {
  return { sub: 'admin1', username: 'boss', role: 'admin', iat: 0, exp: 0 };
}

function makeApp(
  subFns?: Parameters<typeof reviewRoutes>[0] extends infer T
    ? T extends { subFns?: infer S }
      ? S
      : never
    : never,
  deps?: Parameters<typeof reviewRoutes>[0],
  role: 'admin' | 'user' = 'admin',
) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { ...makeAdminUser(), role });
    await next();
  });
  app.route('/', reviewRoutes({ ...(deps ?? {}), subFns }));
  return app;
}

const emptyMetrics: MetricsSnapshot = {
  hardware: {
    cpuModel: 'Test',
    cores: 4,
    arch: 'x64',
    platform: 'linux',
    totalMemoryBytes: 8000,
    gpuDetected: null,
  },
  cpu: { percent: 25, cores: 4, model: 'Test' },
  memory: {
    totalBytes: 8000,
    usedBytes: 4000,
    freeBytes: 4000,
    processRssBytes: 1000,
    processHeapBytes: 500,
  },
  gpu: null,
};

describe('GET /api/admin/review', () => {
  it('carries the maintenance slice from the runner (issue #622)', async () => {
    const status = { phase: 'running', taskId: 'metadata-optimize', visited: 3, total: 10 };
    const app = makeApp(undefined, {
      maintenance: { getStatus: () => status as never },
    });
    const res = await app.request('/', { headers: { 'x-role': 'admin' } });
    const body = (await res.json()) as {
      maintenance: typeof status;
      library: { scanning: boolean };
    };
    expect(body.maintenance).toMatchObject({ taskId: 'metadata-optimize', visited: 3 });
    // A metadata pass is not a scan, so the library indicator stays false.
    expect(body.library.scanning).toBe(false);
  });

  it('reports library.scanning from the runner — the old key had no writer', async () => {
    const app = makeApp(undefined, {
      maintenance: { getStatus: () => ({ taskId: 'library-sync' }) as never },
    });
    const res = await app.request('/', { headers: { 'x-role': 'admin' } });
    expect(((await res.json()) as { library: { scanning: boolean } }).library.scanning).toBe(true);
  });

  it('degrades the maintenance slice to null when the runner throws', async () => {
    const app = makeApp(undefined, {
      maintenance: {
        getStatus: () => {
          throw new Error('boom');
        },
      },
    });
    const res = await app.request('/', { headers: { 'x-role': 'admin' } });
    const body = (await res.json()) as { maintenance: unknown };
    expect(body.maintenance).toBeNull();
  });

  it('reports a null maintenance slice when no runner is wired', async () => {
    const res = await makeApp().request('/', { headers: { 'x-role': 'admin' } });
    expect(((await res.json()) as { maintenance: unknown }).maintenance).toBeNull();
  });

  it('rejects a non-admin caller with 403', async () => {
    const app = makeApp({}, undefined, 'user');
    const res = await app.request('/');
    expect(res.status).toBe(403);
  });

  it('returns the full ServiceReview shape with all sub-fetches happy', async () => {
    const subFns = {
      collectMetrics: mock(async () => emptyMetrics),
      scanStatus: mock(async () => ({ scanning: false, count: 1234 })),
      indexSongCount: mock(() => 1234),
      updateCheck: mock(async () => ({
        currentVersion: '0.1.234',
        latestVersion: '0.1.235',
        updateAvailable: true,
        checkedAt: 1,
        releaseUrl: 'https://x',
        versionHistory: [{ version: '0.1.234', firstSeenAt: 1 }],
      })),
      backupsList: mock(
        () =>
          [{ name: 'n1', createdAt: 1, sizeBytes: 1024, files: ['db'] }] as unknown as Array<{
            name: string;
            createdAt: number;
            sizeBytes: number;
            files: string[];
          }>,
      ),
      processingSummary: mock(() => ({
        phase: 'idle' as const,
        currentTask: null,
        processed: 0,
        failed: 0,
        total: 0,
        skipped: 0,
        quarantined: 0,
        taskPending: {
          bpm: 0,
          genre: 0,
          key: 0,
          energy: 0,
          'audio-features': 0,
          descriptors: 0,
          'artist-image': 0,
          'artist-info': 0,
          'artist-identity': 0,
          licence: 0,
          'genre-audio': 0,
          'genre-discogs': 0,
          popularity: 0,
          'artist-origin': 0,
        },
        availability: {
          bpm: true as const,
          genre: true as const,
          key: true as const,
          energy: true as const,
          'audio-features': true as const,
          descriptors: true as const,
          'artist-image': true as const,
          'artist-info': true as const,
          'artist-identity': true as const,
          licence: true as const,
          'genre-audio': true as const,
          'genre-discogs': true as const,
          popularity: true as const,
          'artist-origin': true as const,
        },
        startedAt: null,
        updatedAt: null,
      })),
      incompleteJobCount: mock(() => 0),
      untrackedCount: mock(() => 0),
      // Default gatherer needs the global DB (initDatabase); stub it so this
      // file is green standalone, not only inside the full suite.
      orphanRows: mock(() => []),
      playEvents: mock(() => 0),
      artistImages: mock(() => ({ visible: 0, withPortrait: 0, missing: 0, manualOverride: 0 })),
      downloadReviews: mock(() => ({ pending: 0, oldestCreated: null })),
      reviewFlags: mock(() => []),
      auditTail: mock(() => []),
      incompleteJobs: mock(() => []),
      untracked: mock(() => []),
    };
    const app = makeApp(subFns, { version: '0.1.234' });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const data = (await res.json()) as ServiceReview;
    expect(data.version).toBe('0.1.234');
    expect(data.library.scanning).toBe(false);
    expect(data.library.indexedSongCount).toBe(1234);
    expect(data.incompleteJobsCount).toBe(0);
    expect(data.untrackedCount).toBe(0);
    expect(data.updateCheck?.latestVersion).toBe('0.1.235');
    expect(data.backups).toHaveLength(1);
    expect(data.backupsSummary.total).toBe(1);
    expect(data.processing?.phase).toBe('idle');
    expect(data.load.cpu.percent).toBe(25);
    expect(data.hardware.cores).toBe(4);
    expect(data.errors).toEqual([]);
  });

  it('degrades to per-field fallback + errors[] when sub-fetches throw', async () => {
    const subFns = {
      collectMetrics: mock(async () => {
        throw new Error('metrics broken');
      }),
      scanStatus: mock(async () => {
        throw new Error('db busy');
      }),
      indexSongCount: mock(() => {
        throw new Error('count failed');
      }),
      updateCheck: mock(async () => null),
      backupsList: mock(() => {
        throw new Error('backups dir missing');
      }),
      processingSummary: mock(() => null),
      incompleteJobCount: mock(() => {
        throw new Error('count failed');
      }),
      untrackedCount: mock(() => {
        throw new Error('count failed');
      }),
      auditTail: mock(() => {
        throw new Error('audit broken');
      }),
      incompleteJobs: mock(() => {
        throw new Error('incomplete list broken');
      }),
      untracked: mock(() => {
        throw new Error('untracked list broken');
      }),
    };
    const app = makeApp(subFns, { version: '0.1.234' });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const data = (await res.json()) as ServiceReview;
    expect(data.errors.length).toBeGreaterThanOrEqual(7);
    expect(data.errors.some((e) => e.startsWith('metrics'))).toBe(true);
    expect(data.errors.some((e) => e.startsWith('scanStatus'))).toBe(true);
    expect(data.errors.some((e) => e.startsWith('backups'))).toBe(true);
    expect(data.errors.some((e) => e.startsWith('incompleteJobsCount'))).toBe(true);
    expect(data.errors.some((e) => e.startsWith('untrackedCount'))).toBe(true);
    expect(data.errors.some((e) => e.startsWith('auditTail'))).toBe(true);
    // Fallbacks preserved.
    expect(data.load.cpu.percent).toBe(0);
    expect(data.library.indexedSongCount).toBe(0);
    expect(data.incompleteJobsCount).toBe(0);
    expect(data.untrackedCount).toBe(0);
    expect(data.auditTail).toEqual([]);
    expect(data.backups).toEqual([]);
    expect(data.backupsSummary.total).toBe(0);
  });

  it('surfaces the GPU snapshot via the injected gpuProbe shim', async () => {
    const subFns = {
      collectMetrics: mock(async (): Promise<MetricsSnapshot> => ({
        ...emptyMetrics,
        gpu: { vendor: 'nvidia', percent: 33, name: 'RTX 4090' },
        hardware: { ...emptyMetrics.hardware, gpuDetected: { vendor: 'nvidia', name: 'RTX 4090' } },
      })),
      scanStatus: mock(async () => ({ scanning: false, count: 0 })),
      indexSongCount: mock(() => 0),
      updateCheck: mock(async () => null),
      backupsList: mock(
        () =>
          [] as unknown as Array<{
            name: string;
            createdAt: number;
            sizeBytes: number;
            files: string[];
          }>,
      ),
      processingSummary: mock(() => null),
      incompleteJobCount: mock(() => 0),
      untrackedCount: mock(() => 0),
      auditTail: mock(() => []),
      incompleteJobs: mock(() => []),
      untracked: mock(() => []),
    };
    const app = makeApp(subFns);
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const data = (await res.json()) as ServiceReview;
    expect(data.load.gpu?.vendor).toBe('nvidia');
    expect(data.load.gpu?.percent).toBe(33);
    expect(data.load.gpu?.name).toBe('RTX 4090');
    expect(data.hardware.gpuDetected?.vendor).toBe('nvidia');
  });

  it('hides the GPU snapshot when the probe returns null', async () => {
    const subFns = {
      collectMetrics: mock(async (): Promise<MetricsSnapshot> => ({
        ...emptyMetrics,
        gpu: null,
        hardware: { ...emptyMetrics.hardware, gpuDetected: null },
      })),
      scanStatus: mock(async () => ({ scanning: false, count: 0 })),
      indexSongCount: mock(() => 0),
      updateCheck: mock(async () => null),
      backupsList: mock(
        () =>
          [] as unknown as Array<{
            name: string;
            createdAt: number;
            sizeBytes: number;
            files: string[];
          }>,
      ),
      processingSummary: mock(() => null),
      incompleteJobCount: mock(() => 0),
      untrackedCount: mock(() => 0),
      auditTail: mock(() => []),
      incompleteJobs: mock(() => []),
      untracked: mock(() => []),
    };
    const app = makeApp(subFns);
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const data = (await res.json()) as ServiceReview;
    expect(data.load.gpu).toBeNull();
    expect(data.hardware.gpuDetected).toBeNull();
  });

  it('reports the analysis sidecar as unconfigured when no client is wired', async () => {
    const app = makeApp({
      collectMetrics: mock(async () => emptyMetrics),
      scanStatus: mock(async () => ({ scanning: false, count: 0 })),
      indexSongCount: mock(() => 0),
      updateCheck: mock(async () => null),
      backupsList: mock(() => [] as never),
      processingSummary: mock(() => null),
      incompleteJobCount: mock(() => 0),
      untrackedCount: mock(() => 0),
      // Default gatherer needs the global DB (initDatabase); stub it so this
      // file is green standalone, not only inside the full suite.
      orphanRows: mock(() => []),
      playEvents: mock(() => 0),
      artistImages: mock(() => ({ visible: 0, withPortrait: 0, missing: 0, manualOverride: 0 })),
      downloadReviews: mock(() => ({ pending: 0, oldestCreated: null })),
      reviewFlags: mock(() => []),
      auditTail: mock(() => []),
      incompleteJobs: mock(() => []),
      untracked: mock(() => []),
    });
    const data = (await (await app.request('/')).json()) as ServiceReview;

    expect(data.services.analysis).toEqual({ configured: false, healthy: false });
    // An absent sidecar is the default deployment, not a fault.
    expect(data.errors).toEqual([]);
  });

  it('probes the sidecar when a client is wired', async () => {
    const healthy = mock(async () => true);
    const app = new Hono<AuthEnv>();
    app.use('*', async (c, next) => {
      c.set('user', makeAdminUser());
      await next();
    });
    app.route('/', reviewRoutes({ analysisClient: { healthy } }));

    const data = (await (await app.request('/')).json()) as ServiceReview;

    expect(healthy).toHaveBeenCalled();
    expect(data.services.analysis).toEqual({ configured: true, healthy: true });
  });

  it('degrades to unhealthy without dropping the snapshot when the probe throws', async () => {
    const app = new Hono<AuthEnv>();
    app.use('*', async (c, next) => {
      c.set('user', makeAdminUser());
      await next();
    });
    app.route(
      '/',
      reviewRoutes({
        analysisClient: {
          healthy: async () => {
            throw new Error('sidecar down');
          },
        },
      }),
    );

    const res = await app.request('/');
    const data = (await res.json()) as ServiceReview;

    expect(res.status).toBe(200);
    expect(data.services.analysis).toEqual({ configured: false, healthy: false });
    expect(data.errors.join(' ')).toMatch(/analysisStatus/);
  });
});

/**
 * Issue #274. The slices used to be destructured positionally out of one
 * `Promise.all`, so adding one meant editing the name list and the array in
 * exact lockstep. A mismatch is invisible to the type-checker where slices
 * share a type — `incompleteJobsCount`/`untrackedCount` are both `number`, and
 * `incompleteJobs`/`untracked` are both arrays of objects — so a swap would
 * type-check cleanly and just produce a wrong Admin panel.
 *
 * Distinct sentinels per gatherer make that impossible to introduce silently.
 */
describe('GET /api/admin/review — every slice lands in its own field (#274)', () => {
  it('does not cross-wire the same-typed slices', async () => {
    const subFns = {
      collectMetrics: mock(async () => emptyMetrics),
      // The two `number` slices: distinct values, so a swap flips them.
      incompleteJobCount: mock(() => 11),
      untrackedCount: mock(() => 22),
      // The two object-array slices: distinguishable by shape AND content.
      incompleteJobs: mock(() => [{ id: 'incomplete-sentinel' }]),
      untracked: mock(() => [{ id: 'untracked-sentinel' }]),
      orphanRows: mock(() => [{ table: 'orphan-sentinel', rows: 1, orphans: 1 }]),
      playEvents: mock(() => 7),
      artistImages: mock(() => ({ visible: 0, withPortrait: 0, missing: 0, manualOverride: 0 })),
      downloadReviews: mock(() => ({ pending: 7, oldestCreated: '2026-08-01T00:00:00.000Z' })),
      reviewFlags: mock(() => []),
      auditTail: mock(() => [{ id: 'audit-sentinel' }]),
      backupsList: mock(async () => [{ name: 'backup-sentinel' }]),
    } as never;

    const res = await makeApp(subFns).request('/');
    const body = (await res.json()) as ServiceReview;

    expect(body.incompleteJobsCount).toBe(11);
    expect(body.untrackedCount).toBe(22);
    expect(body.incompleteJobs[0]).toMatchObject({ id: 'incomplete-sentinel' });
    expect(body.untracked[0]).toMatchObject({ id: 'untracked-sentinel' });
    expect(body.orphanRows[0]).toMatchObject({ table: 'orphan-sentinel' });
    // A same-typed number next to incompleteJobsCount/untrackedCount — exactly
    // the swap `allNamed` exists to prevent (#274), so assert it lands.
    expect(body.playEvents).toBe(7);
    expect(body.downloadReviews).toEqual({ pending: 7, oldestCreated: '2026-08-01T00:00:00.000Z' });
    expect(body.auditTail[0]).toMatchObject({ id: 'audit-sentinel' });
    expect(body.backups[0]).toMatchObject({ name: 'backup-sentinel' });
  });
});
