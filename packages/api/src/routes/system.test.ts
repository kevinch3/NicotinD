import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { systemRoutes } from './system.js';

describe('system routes', () => {
  let app: Hono;

  const serviceManagerMock = {
    hasService: mock(() => false),
    getLogs: mock(() => Promise.resolve([])),
    restartService: mock(() => Promise.resolve()),
  };
  const configMock = {
    soulseek: { username: 'testuser', password: 'testpass' },
    mode: 'external',
  };

  beforeEach(() => {
    app = new Hono();
    app.route(
      '/',
      systemRoutes(
        serviceManagerMock as unknown as Parameters<typeof systemRoutes>[0],
        configMock as unknown as Parameters<typeof systemRoutes>[1],
      ),
    );
  });

  it('GET /status reports the server version + uptime (slskd is the addon business now)', async () => {
    const res = await app.request('/status');
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown> & {
      nicotind: { version: string; uptime: number };
    };
    expect(data.nicotind.version).toBeDefined();
    expect('slskd' in data).toBe(false);
  });

  // Regression: `scanRunning` used to test only `taskId === 'library-sync'`, but
  // MaintenanceService deliberately RETAINS taskId after a pass so the admin UI can
  // show "last run". So once any scan had run, /scan/status answered `scanning:true`
  // forever — a predicate answering "was the last task a scan?" instead of "is one
  // running?". The e2e suite was the first consumer to actually poll it.
  it('GET /scan/status reports scanning:false once the maintenance pass goes idle', async () => {
    let status = { phase: 'running' as string, taskId: 'library-sync' as string | null };
    const withMaintenance = () => {
      const a = new Hono();
      a.route(
        '/',
        systemRoutes(
          serviceManagerMock as unknown as Parameters<typeof systemRoutes>[0],
          configMock as unknown as Parameters<typeof systemRoutes>[1],
          {
            maintenance: {
              getStatus: () => status,
              start: () => 'started',
            } as unknown as NonNullable<Parameters<typeof systemRoutes>[2]>['maintenance'],
          } as Parameters<typeof systemRoutes>[2],
        ),
      );
      return a;
    };

    const running = await (await withMaintenance().request('/scan/status')).json();
    expect((running as { scanning: boolean }).scanning).toBe(true);

    // The pass finishes: phase goes idle, taskId is intentionally left behind.
    status = { phase: 'idle', taskId: 'library-sync' };
    const idle = await (await withMaintenance().request('/scan/status')).json();
    expect((idle as { scanning: boolean }).scanning).toBe(false);

    // A different task running is not a library scan either.
    status = { phase: 'running', taskId: 'metadata-optimize' };
    const other = await (await withMaintenance().request('/scan/status')).json();
    expect((other as { scanning: boolean }).scanning).toBe(false);
  });

  it('GET /disk reports total/free/used bytes for the music dir', async () => {
    app = new Hono();
    app.route(
      '/',
      systemRoutes(
        serviceManagerMock as unknown as Parameters<typeof systemRoutes>[0],
        configMock as unknown as Parameters<typeof systemRoutes>[1],
        {
          musicDir: '/music',
          // 1000 blocks * 1024 = ~1 MiB total, 400 avail => 600 used.
          statfs: () => ({ bsize: 1024, blocks: 1000, bavail: 400 }),
        },
      ),
    );

    const res = await app.request('/disk');
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.total).toBe(1000 * 1024);
    expect(data.free).toBe(400 * 1024);
    expect(data.used).toBe(600 * 1024);
  });

  it('GET /disk returns 500 when statfs throws', async () => {
    app = new Hono();
    app.route(
      '/',
      systemRoutes(
        serviceManagerMock as unknown as Parameters<typeof systemRoutes>[0],
        configMock as unknown as Parameters<typeof systemRoutes>[1],
        {
          musicDir: '/nonexistent',
          statfs: () => {
            throw new Error('ENOENT');
          },
        },
      ),
    );

    const res = await app.request('/disk');
    expect(res.status).toBe(500);
  });
});
