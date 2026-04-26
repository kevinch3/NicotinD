import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { systemRoutes } from './system.js';

describe('system routes', () => {
  let slskdMock: any;
  let app: Hono<any>;

  const navidromeMock = {
    system: { ping: mock(() => Promise.resolve(true)) },
  };
  const serviceManagerMock = {
    hasService: mock(() => false),
    getLogs: mock(() => Promise.resolve([])),
    restartService: mock(() => Promise.resolve()),
  };
  const configMock = {
    soulseek: { username: 'testuser', password: 'testpass' },
    mode: 'external',
  } as any;

  beforeEach(() => {
    slskdMock = {
      server: {
        getState: mock(() =>
          Promise.resolve({ isConnected: true, username: 'testuser', state: 'Connected' }),
        ),
      },
      application: {
        getInfo: mock(() => Promise.resolve({ version: '0.25.1', uptime: 3600 })),
      },
    };

    app = new Hono();
    app.route(
      '/',
      systemRoutes({ current: slskdMock }, navidromeMock as any, serviceManagerMock as any, configMock),
    );
  });

  it('GET /status includes slskd version and uptime', async () => {
    const res = await app.request('/status');
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.slskd.version).toBe('0.25.1');
    expect(data.slskd.uptime).toBe(3600);
    expect(data.slskd.healthy).toBe(true);
    expect(data.slskd.connected).toBe(true);
  });

  it('GET /status omits version/uptime when application.getInfo() throws but keeps healthy=true', async () => {
    slskdMock.application.getInfo = mock(() => Promise.reject(new Error('endpoint not found')));

    const res = await app.request('/status');
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.slskd.version).toBeUndefined();
    expect(data.slskd.uptime).toBeUndefined();
    expect(data.slskd.healthy).toBe(true);
  });

  it('GET /status marks slskd as unhealthy when getState throws', async () => {
    slskdMock.server.getState = mock(() => Promise.reject(new Error('refused')));

    const res = await app.request('/status');
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.slskd.healthy).toBe(false);
    expect(data.slskd.connected).toBe(false);
  });

  it('GET /status works when slskdRef is null', async () => {
    app = new Hono();
    app.route(
      '/',
      systemRoutes({ current: null }, navidromeMock as any, serviceManagerMock as any, configMock),
    );

    const res = await app.request('/status');
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.slskd.healthy).toBe(false);
  });
});
