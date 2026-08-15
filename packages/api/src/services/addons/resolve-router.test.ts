import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../../db.js';
import { PluginRegistry } from '../plugins/registry.js';
import { registerBundledAddons } from './bundled/registry.js';
import { resolveAddonForUrl } from './resolve-router.js';
import { removeAddon } from './manager.js';
import { RemoteAddonPlugin } from './remote-addon-plugin.js';
import { LocalAddonTransport } from './local-transport.js';
import type { BundledAddon } from './bundled/types.js';

function catchAllResolveAddon(): BundledAddon {
  return {
    manifest: {
      id: 'catch-all',
      name: 'Catch All',
      description: 'test',
      version: '1.0.0',
      protocolVersion: '1.0.0',
      kind: 'acquisition',
      capabilities: ['resolve'],
      urlPatterns: ['^https?://'],
      priority: -10,
      compliance: { disclaimer: 'test', requiresConsent: false },
    },
    createJob: async () => {
      throw new Error('not used');
    },
    getJob: async () => {
      throw new Error('not used');
    },
    listJobs: async () => [],
    cancelJob: async () => {},
    filePath: async () => '/tmp/x',
  };
}

describe('bundled archive addon + resolveAddonForUrl', () => {
  let db: Database;
  let registry: PluginRegistry;

  beforeEach(async () => {
    db = new Database(':memory:');
    applySchema(db);
    registry = new PluginRegistry({ db, dataDir: join(tmpdir(), `nic-${Date.now()}`) });
    registerBundledAddons(registry, { stagingDir: join(tmpdir(), `stg-${Date.now()}`) });
  });

  it('registers the bundled archive addon (present but disabled until enabled)', () => {
    const plugin = registry.get('bundled-archive');
    expect(plugin).toBeDefined();
    expect(plugin?.origin?.bundled).toBe(true);
    // Disabled by default → not resolvable yet.
    expect(resolveAddonForUrl(registry, 'https://archive.org/details/x')).toBeNull();
  });

  it('routes an archive url to the bundled addon once enabled, and a youtube url to none', async () => {
    await registry.enable('bundled-archive', 'test-user');
    expect(resolveAddonForUrl(registry, 'https://archive.org/details/x')?.addonManifest.id).toBe(
      'bundled-archive',
    );
    expect(resolveAddonForUrl(registry, 'https://www.youtube.com/watch?v=x')).toBeNull();
  });

  it('refuses to remove a bundled addon', async () => {
    await expect(removeAddon(registry, db, 'bundled-archive')).rejects.toThrow(/cannot be removed/);
  });

  it('prefers a higher-priority addon over a catch-all for an overlapping url', async () => {
    const addon = catchAllResolveAddon();
    registry.register(new RemoteAddonPlugin(addon.manifest, new LocalAddonTransport(addon)));
    await registry.enable('bundled-archive', 'u');
    await registry.enable('catch-all', 'u');
    // archive.org matches BOTH; archive (priority 0) beats the catch-all (-10).
    expect(resolveAddonForUrl(registry, 'https://archive.org/details/x')?.addonManifest.id).toBe(
      'bundled-archive',
    );
    // youtube matches only the catch-all.
    expect(
      resolveAddonForUrl(registry, 'https://www.youtube.com/watch?v=x')?.addonManifest.id,
    ).toBe('catch-all');
  });
});
