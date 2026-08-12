import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Slskd } from '@nicotind/slskd-client';
import { applySchema } from './db.js';
import { readStoredConfig, resolveConfig, storeConfig } from './config.js';
import { createAddonApp } from './server.js';

function stubSlskd(over: { connected?: boolean; throwOnState?: boolean } = {}): Slskd {
  return {
    server: {
      getState: async () => {
        if (over.throwOnState) throw new Error('down');
        return { isConnected: over.connected ?? true, state: 'Connected', username: 'me' };
      },
    },
  } as unknown as Slskd;
}

function makeApp(over: { token?: string; slskd?: Slskd } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const app = createAddonApp({
    db,
    slskdRef: { current: over.slskd ?? stubSlskd() },
    token: over.token ?? 'tok',
  });
  return { app, db };
}

describe('addon config store', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('persists pushed keys and ignores unknown ones', () => {
    storeConfig(db, { soulseekUsername: 'kevin', bogus: 'x' });
    expect(readStoredConfig(db)).toEqual({ soulseekUsername: 'kevin' });
  });

  it('stored config overrides env; env fills the rest', () => {
    storeConfig(db, { slskdUrl: 'http://stored:1' });
    const config = resolveConfig(db, {
      SLSKD_ADDON_TOKEN: 't',
      SLSKD_ADDON_SLSKD_URL: 'http://env:2',
      SLSKD_ADDON_SOULSEEK_USERNAME: 'envuser',
    });
    expect(config.slskdUrl).toBe('http://stored:1');
    expect(config.soulseekUsername).toBe('envuser');
    expect(config.token).toBe('t');
  });
});

describe('addon server (protocol v1 base routes)', () => {
  it('serves the manifest unauthenticated', async () => {
    const { app } = makeApp();
    const res = await app.request('/addon/v1/manifest');
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as { id: string; protocolVersion: string };
    expect(manifest.id).toBe('slskd');
    expect(manifest.protocolVersion).toBe('1.0.0');
  });

  it('health reflects slskd reachability', async () => {
    const up = await makeApp().app.request('/addon/v1/health');
    expect((await up.json()) as object).toMatchObject({ ok: true, ready: true });

    const down = await makeApp({ slskd: stubSlskd({ throwOnState: true }) }).app.request(
      '/addon/v1/health',
    );
    expect((await down.json()) as object).toMatchObject({ ok: true, ready: false });
  });

  it('guards status/config behind the bearer token', async () => {
    const { app } = makeApp();
    expect((await app.request('/addon/v1/status')).status).toBe(401);
    const ok = await app.request('/addon/v1/status', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(ok.status).toBe(200);
    const rows = (await ok.json()) as Array<{ key: string; value: string }>;
    expect(rows[0]).toMatchObject({ key: 'connection', value: 'Connected' });
  });

  it('rejects everything when no token is configured', async () => {
    const { app } = makeApp({ token: '' });
    const res = await app.request('/addon/v1/status', {
      headers: { Authorization: 'Bearer ' },
    });
    expect(res.status).toBe(401);
  });

  it('PUT config persists and notifies', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    let notified = 0;
    const app = createAddonApp({
      db,
      slskdRef: { current: stubSlskd() },
      token: 'tok',
      onConfigChanged: () => notified++,
    });
    const res = await app.request('/addon/v1/config', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ soulseekUsername: 'kevin' }),
    });
    expect(res.status).toBe(204);
    expect(readStoredConfig(db)).toEqual({ soulseekUsername: 'kevin' });
    expect(notified).toBe(1);
  });
});
