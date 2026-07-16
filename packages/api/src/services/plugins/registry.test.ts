import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { Plugin, PluginManifest, PluginHostContext } from '@nicotind/core';
import { applySchema } from '../../db.js';
import { PluginRegistry } from './registry.js';

// A configurable fixture plugin that records lifecycle calls. Capabilities are
// stub objects — the registry only cares that the accessor is present and that
// the manifest declares the capability.
function makePlugin(
  manifest: PluginManifest,
  opts: { available?: boolean } = {},
): Plugin & {
  initCalls: PluginHostContext[];
  disposeCalls: number;
} {
  const initCalls: PluginHostContext[] = [];
  return {
    manifest,
    initCalls,
    disposeCalls: 0,
    async init(ctx) {
      initCalls.push(ctx);
    },
    async isAvailable() {
      return opts.available ?? true;
    },
    async dispose() {
      this.disposeCalls++;
    },
    ...(manifest.capabilities.includes('search')
      ? { search: { search: async () => ({ results: null }) } }
      : {}),
    ...(manifest.capabilities.includes('download')
      ? { download: { enqueue: async () => {} } }
      : {}),
    ...(manifest.capabilities.includes('resolve')
      ? {
          resolve: {
            canHandle: (url: string) => url.includes('example.com'),
            resolve: async () => [],
          },
        }
      : {}),
  };
}

const acquisitionManifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'slskd',
  name: 'slskd',
  description: 'P2P',
  kind: 'acquisition',
  capabilities: ['search', 'download'],
  defaultEnabled: false,
  compliance: {
    disclaimer: 'P2P networks carry legal risk in some countries.',
    requiresConsent: true,
  },
  ...over,
});

describe('PluginRegistry', () => {
  let db: Database;
  let registry: PluginRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    registry = new PluginRegistry({ db, dataDir: '/tmp/nicotind-test' });
  });

  it('rejects an invalid manifest at registration', () => {
    expect(() => registry.register(makePlugin(acquisitionManifest({ id: 'Bad Id' })))).toThrow(
      /invalid plugin manifest/,
    );
  });

  it('rejects a duplicate id', () => {
    registry.register(makePlugin(acquisitionManifest()));
    expect(() => registry.register(makePlugin(acquisitionManifest()))).toThrow(
      /already registered/,
    );
  });

  it('is disabled by default and exposes no capability', () => {
    registry.register(makePlugin(acquisitionManifest()));
    expect(registry.isEnabled('slskd')).toBe(false);
    expect(registry.getEnabledWithCapability('search')).toHaveLength(0);
    expect(registry.getEnabled('acquisition')).toHaveLength(0);
  });

  it('enables a plugin, initializes it once, and records consent', async () => {
    const plugin = makePlugin(acquisitionManifest());
    registry.register(plugin);

    await registry.enable('slskd', 'admin-user-id');

    expect(registry.isEnabled('slskd')).toBe(true);
    expect(plugin.initCalls).toHaveLength(1);
    expect(registry.getEnabledWithCapability('search')).toHaveLength(1);

    const row = db
      .query<
        { consent_user: string; consent_at: number },
        [string]
      >(`SELECT consent_user, consent_at FROM plugins WHERE id = ?`)
      .get('slskd');
    expect(row?.consent_user).toBe('admin-user-id');
    expect(row?.consent_at).toBeGreaterThan(0);

    // Idempotent: enabling again does not re-init.
    await registry.enable('slskd', 'admin-user-id');
    expect(plugin.initCalls).toHaveLength(1);
  });

  it('does not record consent for a plugin that does not require it', async () => {
    registry.register(
      makePlugin(
        acquisitionManifest({
          id: 'ytdlp',
          capabilities: ['resolve', 'download'],
          compliance: { disclaimer: 'x', requiresConsent: false },
        }),
      ),
    );
    await registry.enable('ytdlp', 'admin');
    const row = db
      .query<
        { consent_user: string | null },
        [string]
      >(`SELECT consent_user FROM plugins WHERE id = ?`)
      .get('ytdlp');
    expect(row?.consent_user).toBeNull();
  });

  it('disables a plugin and disposes it', async () => {
    const plugin = makePlugin(acquisitionManifest());
    registry.register(plugin);
    await registry.enable('slskd', 'admin');
    await registry.disable('slskd');

    expect(registry.isEnabled('slskd')).toBe(false);
    expect(plugin.disposeCalls).toBe(1);
    expect(registry.getEnabledWithCapability('search')).toHaveLength(0);
  });

  it('initEnabled re-initializes persisted-enabled plugins after a restart', async () => {
    // First "process": enable + persist.
    const first = new PluginRegistry({ db, dataDir: '/tmp/x' });
    first.register(makePlugin(acquisitionManifest()));
    await first.enable('slskd', 'admin');

    // Second "process": fresh registry over the same db.
    const second = new PluginRegistry({ db, dataDir: '/tmp/x' });
    const plugin = makePlugin(acquisitionManifest());
    second.register(plugin);
    expect(plugin.initCalls).toHaveLength(0);
    await second.initEnabled();
    expect(plugin.initCalls).toHaveLength(1);
    expect(second.isEnabled('slskd')).toBe(true);
  });

  it('routes a URL to the first enabled resolve-capable plugin that handles it', async () => {
    registry.register(
      makePlugin(
        acquisitionManifest({
          id: 'ytdlp',
          capabilities: ['resolve', 'download'],
          compliance: { disclaimer: 'x', requiresConsent: false },
        }),
      ),
    );
    expect(registry.getEnabledForUrl('https://example.com/v')).toBeUndefined(); // disabled
    await registry.enable('ytdlp', 'admin');
    expect(registry.getEnabledForUrl('https://example.com/v')?.manifest.id).toBe('ytdlp');
    expect(registry.getEnabledForUrl('https://other.test/v')).toBeUndefined();
  });

  it('validates config against the manifest schema', () => {
    registry.register(
      makePlugin(
        acquisitionManifest({
          id: 'ytdlp',
          capabilities: ['resolve', 'download'],
          configSchema: z.object({ format: z.enum(['mp3', 'opus']) }),
          compliance: { disclaimer: 'x', requiresConsent: false },
        }),
      ),
    );
    expect(() => registry.setConfig('ytdlp', { format: 'flac' })).toThrow();
    const saved = registry.setConfig('ytdlp', { format: 'mp3' });
    expect(saved).toEqual({ format: 'mp3' });
    expect(registry.getConfig('ytdlp')).toEqual({ format: 'mp3' });
  });

  it('merges a partial config update over the stored config (preserves other keys)', () => {
    registry.register(
      makePlugin(
        acquisitionManifest({
          id: 'spotify',
          capabilities: ['search'],
          configSchema: z
            .object({ clientId: z.string().optional(), clientSecret: z.string().optional() })
            .partial(),
          compliance: { disclaimer: 'x', requiresConsent: false },
        }),
      ),
    );
    registry.setConfig('spotify', { clientId: 'id', clientSecret: 'secret' });
    // Update only clientId — the secret must survive (the "blank password = keep" UX).
    const merged = registry.setConfig('spotify', { clientId: 'id2' });
    expect(merged).toEqual({ clientId: 'id2', clientSecret: 'secret' });
    expect(registry.getConfig('spotify')).toEqual({ clientId: 'id2', clientSecret: 'secret' });
  });

  it('setConfig re-initializes an enabled plugin so new config takes effect live', async () => {
    const plugin = makePlugin(
      acquisitionManifest({
        id: 'spotify',
        capabilities: ['search'],
        configSchema: z.object({ clientId: z.string().optional() }).partial(),
        compliance: { disclaimer: 'x', requiresConsent: false },
      }),
    );
    registry.register(plugin);
    await registry.enable('spotify', 'admin');
    expect(plugin.initCalls).toHaveLength(1);

    registry.setConfig('spotify', { clientId: 'abc' });
    await registry.flushReinit();

    expect(plugin.disposeCalls).toBe(1);
    expect(plugin.initCalls).toHaveLength(2);
    expect(plugin.initCalls[1]!.config).toEqual({ clientId: 'abc' });
  });

  it('setConfig does not initialize a disabled plugin', async () => {
    const plugin = makePlugin(
      acquisitionManifest({
        id: 'spotify',
        capabilities: ['search'],
        configSchema: z.object({ clientId: z.string().optional() }).partial(),
        compliance: { disclaimer: 'x', requiresConsent: false },
      }),
    );
    registry.register(plugin);

    registry.setConfig('spotify', { clientId: 'abc' });
    await registry.flushReinit();

    expect(plugin.initCalls).toHaveLength(0);
  });

  it('list() echoes configFields + configured flags but redacts password values', async () => {
    registry.register(
      makePlugin(
        acquisitionManifest({
          id: 'spotify',
          capabilities: ['search'],
          configSchema: z
            .object({ clientId: z.string().optional(), clientSecret: z.string().optional() })
            .partial(),
          configFields: [
            { key: 'clientId', label: 'Client ID', type: 'text' },
            { key: 'clientSecret', label: 'Client Secret', type: 'password' },
          ],
          compliance: { disclaimer: 'x', requiresConsent: false },
        }),
      ),
    );
    registry.setConfig('spotify', { clientId: 'id', clientSecret: 'secret' });
    const info = (await registry.list()).find((p) => p.id === 'spotify')!;
    expect(info.configFields?.map((f) => f.key)).toEqual(['clientId', 'clientSecret']);
    expect(info.configured).toEqual({ clientId: true, clientSecret: true });
    // Non-secret value is prefilled; the secret is omitted from the payload entirely.
    expect(info.config).toEqual({ clientId: 'id' });
    expect(JSON.stringify(info)).not.toContain('secret');
  });

  it('list() reports enabled/available/needsConfig state', async () => {
    registry.register(
      makePlugin(
        acquisitionManifest({
          id: 'ytdlp',
          capabilities: ['resolve', 'download'],
          configSchema: z.object({ format: z.string() }),
          compliance: { disclaimer: 'x', requiresConsent: false },
        }),
        { available: false },
      ),
    );
    const before = await registry.list();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      id: 'ytdlp',
      enabled: false,
      available: false,
      needsConfig: true,
    });

    registry.setConfig('ytdlp', { format: 'mp3' });
    await registry.enable('ytdlp', 'admin');
    const after = await registry.list();
    expect(after[0]).toMatchObject({ enabled: true, needsConfig: false });
  });
});
