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
  subFns?: Parameters<typeof reviewRoutes>[1] extends infer T ? (T extends { subFns?: infer S } ? S : never) : never,
  deps?: Parameters<typeof reviewRoutes>[1],
  role: 'admin' | 'user' = 'admin',
) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { ...makeAdminUser(), role });
    await next();
  });
  app.route('/', reviewRoutes({ current: null } as never, { ...(deps ?? {}), subFns }));
  return app;
}

const emptyMetrics: MetricsSnapshot = {
  hardware: { cpuModel: 'Test', cores: 4, arch: 'x64', platform: 'linux', totalMemoryBytes: 8000, gpuDetected: null },
  cpu: { percent: 25, cores: 4, model: 'Test' },
  memory: { totalBytes: 8000, usedBytes: 4000, freeBytes: 4000, processRssBytes: 1000, processHeapBytes: 500 },
  gpu: null,
};

describe('GET /api/admin/review', () => {
  it('rejects a non-admin caller with 403', async () => {
    const app = makeApp({}, undefined, 'user');
    const res = await app.request('/');
    expect(res.status).toBe(403);
  });

  it('returns the full ServiceReview shape with all sub-fetches happy', async () => {
    const subFns = {
      collectMetrics: mock(async () => emptyMetrics),
      systemStatus: mock(async () => ({ healthy: true, connected: true, username: 'me', version: '0.25.1', uptime: 60 })),
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
      backupsList: mock(() => [{ name: 'n1', createdAt: 1, sizeBytes: 1024, files: ['db'] }] as unknown as Array<{ name: string; createdAt: number; sizeBytes: number; files: string[] }>),
      processingSummary: mock(() => ({
        phase: 'idle' as const,
        currentTask: null,
        processed: 0,
        failed: 0,
        total: 0,
        skipped: 0,
        quarantined: 0,
        taskPending: { bpm: 0, genre: 0, key: 0, energy: 0, 'audio-features': 0, 'artist-image': 0, 'artist-identity': 0, licence: 0, 'genre-audio': 0 },
        availability: { bpm: true as const, genre: true as const, key: true as const, energy: true as const, 'audio-features': true as const, 'artist-image': true as const, 'artist-identity': true as const, licence: true as const, 'genre-audio': true as const },
        startedAt: null,
        updatedAt: null,
      })),
      incompleteJobCount: mock(() => 0),
      untrackedCount: mock(() => 0),
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
    expect(data.services.slskd.healthy).toBe(true);
    expect(data.services.slskd.connected).toBe(true);
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
      systemStatus: mock(async () => {
        throw new Error('slskd down');
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
    expect(data.errors.some((e) => e.startsWith('systemStatus'))).toBe(true);
    expect(data.errors.some((e) => e.startsWith('scanStatus'))).toBe(true);
    expect(data.errors.some((e) => e.startsWith('backups'))).toBe(true);
    expect(data.errors.some((e) => e.startsWith('incompleteJobsCount'))).toBe(true);
    expect(data.errors.some((e) => e.startsWith('untrackedCount'))).toBe(true);
    expect(data.errors.some((e) => e.startsWith('auditTail'))).toBe(true);
    // Fallbacks preserved.
    expect(data.load.cpu.percent).toBe(0);
    expect(data.library.indexedSongCount).toBe(0);
    expect(data.services.slskd.healthy).toBe(false);
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
      systemStatus: mock(async () => ({ healthy: false, connected: false })),
      scanStatus: mock(async () => ({ scanning: false, count: 0 })),
      indexSongCount: mock(() => 0),
      updateCheck: mock(async () => null),
      backupsList: mock(() => [] as unknown as Array<{ name: string; createdAt: number; sizeBytes: number; files: string[] }>),
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
      collectMetrics: mock(async (): Promise<MetricsSnapshot> => ({ ...emptyMetrics, gpu: null, hardware: { ...emptyMetrics.hardware, gpuDetected: null } })),
      systemStatus: mock(async () => ({ healthy: false, connected: false })),
      scanStatus: mock(async () => ({ scanning: false, count: 0 })),
      indexSongCount: mock(() => 0),
      updateCheck: mock(async () => null),
      backupsList: mock(() => [] as unknown as Array<{ name: string; createdAt: number; sizeBytes: number; files: string[] }>),
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
});
