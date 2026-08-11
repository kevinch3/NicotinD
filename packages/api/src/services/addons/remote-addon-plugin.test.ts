import { describe, expect, it } from 'bun:test';
import { ADDON_PROTOCOL_VERSION, type AddonManifest, type PluginHostContext } from '@nicotind/core';
import type { AddonClient } from './client.js';
import { RemoteAddonPlugin } from './remote-addon-plugin.js';

const MANIFEST: AddonManifest = {
  id: 'fixture-addon',
  name: 'Fixture Addon',
  description: 'test',
  version: '0.1.0',
  protocolVersion: ADDON_PROTOCOL_VERSION,
  kind: 'acquisition',
  capabilities: ['search'],
  configFields: [{ key: 'username', label: 'Username', type: 'text' }],
  compliance: { disclaimer: 'Test addon', requiresConsent: true },
};

function stubClient(over: Partial<AddonClient> = {}): AddonClient & { configPushes: unknown[] } {
  const configPushes: unknown[] = [];
  return {
    baseUrl: 'http://addon:9999',
    configPushes,
    async getManifest() {
      return MANIFEST;
    },
    async getHealth() {
      return { ok: true, ready: true };
    },
    async getStatus() {
      return [{ key: 'peers', label: 'Peers', value: '42' }];
    },
    async putConfig(config: Record<string, unknown>) {
      configPushes.push(config);
    },
    ...over,
  } as AddonClient & { configPushes: unknown[] };
}

function ctx(config: Record<string, unknown> = {}): PluginHostContext {
  return {
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as unknown as PluginHostContext['logger'],
    config,
    allocStagingDir: () => '/tmp/x',
    emitProgress() {},
    emitLabel() {},
    emitTrack() {},
    storage: { get: () => null, set() {}, delete() {} },
  };
}

describe('RemoteAddonPlugin', () => {
  it('maps the addon manifest to a defaultEnabled:false plugin manifest', () => {
    const plugin = new RemoteAddonPlugin(MANIFEST, stubClient());
    expect(plugin.manifest.id).toBe('fixture-addon');
    expect(plugin.manifest.defaultEnabled).toBe(false);
    expect(plugin.manifest.configFields?.[0]?.key).toBe('username');
    expect(plugin.origin).toEqual({ remote: true, url: 'http://addon:9999' });
  });

  it('pushes the stored config down on init', async () => {
    const client = stubClient();
    const plugin = new RemoteAddonPlugin(MANIFEST, client);
    await plugin.init(ctx({ username: 'kevin' }));
    expect(client.configPushes).toEqual([{ username: 'kevin' }]);
  });

  it('init survives a failing config push', async () => {
    const client = stubClient({
      putConfig: async () => {
        throw new Error('down');
      },
    });
    const plugin = new RemoteAddonPlugin(MANIFEST, client);
    await plugin.init(ctx({ username: 'kevin' }));
  });

  it('skips the config push when there is nothing stored', async () => {
    const client = stubClient();
    const plugin = new RemoteAddonPlugin(MANIFEST, client);
    await plugin.init(ctx({}));
    expect(client.configPushes).toEqual([]);
  });

  it('isAvailable follows health', async () => {
    expect(await new RemoteAddonPlugin(MANIFEST, stubClient()).isAvailable()).toBe(true);
    expect(
      await new RemoteAddonPlugin(
        MANIFEST,
        stubClient({ getHealth: async () => ({ ok: true, ready: false }) }),
      ).isAvailable(),
    ).toBe(false);
    expect(
      await new RemoteAddonPlugin(
        MANIFEST,
        stubClient({
          getHealth: async () => {
            throw new Error('unreachable');
          },
        }),
      ).isAvailable(),
    ).toBe(false);
  });

  it('passes status through', async () => {
    const rows = await new RemoteAddonPlugin(MANIFEST, stubClient()).status();
    expect(rows[0]!.value).toBe('42');
  });
});
