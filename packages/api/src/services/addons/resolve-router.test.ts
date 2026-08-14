import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../../db.js';
import { PluginRegistry } from '../plugins/registry.js';
import { registerBundledAddons } from './bundled/registry.js';
import { resolveAddonForUrl } from './resolve-router.js';
import { removeAddon } from './manager.js';

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
});
