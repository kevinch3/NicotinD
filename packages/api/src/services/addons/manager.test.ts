import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ADDON_PROTOCOL_VERSION, type AddonManifest, type Plugin } from '@nicotind/core';
import { applySchema } from '../../db.js';
import { PluginRegistry } from '../plugins/registry.js';
import { AddonClient } from './client.js';
import { listAddonRegistrations, saveAddonRegistration } from './store.js';
import { loadRegisteredAddons, registerAddon, removeAddon } from './manager.js';

function manifest(over: Partial<AddonManifest> = {}): AddonManifest {
  return {
    id: 'fixture-addon',
    name: 'Fixture Addon',
    description: 'test',
    version: '0.1.0',
    protocolVersion: ADDON_PROTOCOL_VERSION,
    kind: 'acquisition',
    capabilities: ['search'],
    ...over,
  };
}

/** An AddonClient whose manifest fetch is canned — no network. */
function factoryFor(m: AddonManifest | Error) {
  return (url: string, token: string) => {
    const client = new AddonClient({ baseUrl: url, token });
    client.getManifest = async () => {
      if (m instanceof Error) throw m;
      return m;
    };
    return client;
  };
}

const BUILTIN: Plugin = {
  manifest: {
    id: 'builtin',
    name: 'Builtin',
    description: 'x',
    kind: 'acquisition',
    capabilities: ['search'],
    defaultEnabled: false,
  },
  async init() {},
  async isAvailable() {
    return true;
  },
};

describe('addon manager', () => {
  let db: Database;
  let registry: PluginRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    registry = new PluginRegistry({ db, dataDir: '/tmp/nicotind-test' });
    registry.register(BUILTIN);
  });

  it('registers an addon: persists the row and registers the plugin', async () => {
    const reg = await registerAddon(registry, db, {
      url: 'http://addon:9999/',
      token: 'tok',
      addedBy: 'admin',
      clientFactory: factoryFor(manifest()),
    });
    expect(reg.id).toBe('fixture-addon');
    expect(listAddonRegistrations(db)).toHaveLength(1);
    expect(registry.get('fixture-addon')?.origin?.remote).toBe(true);
  });

  it('rejects an unsupported protocol version', async () => {
    await expect(
      registerAddon(registry, db, {
        url: 'http://addon:9999',
        token: 'tok',
        addedBy: 'admin',
        clientFactory: factoryFor(manifest({ protocolVersion: '2.0.0' })),
      }),
    ).rejects.toThrow(/protocol/);
    expect(listAddonRegistrations(db)).toHaveLength(0);
  });

  it('rejects an id collision with an existing plugin', async () => {
    await expect(
      registerAddon(registry, db, {
        url: 'http://addon:9999',
        token: 'tok',
        addedBy: 'admin',
        clientFactory: factoryFor(manifest({ id: 'builtin' })),
      }),
    ).rejects.toThrow(/already/);
  });

  it('loads registered addons at boot and skips invalid rows', () => {
    saveAddonRegistration(db, {
      id: 'fixture-addon',
      url: 'http://addon:9999',
      token: 'tok',
      manifest: manifest(),
      addedAt: 1,
      addedBy: 'admin',
    });
    saveAddonRegistration(db, {
      id: 'broken',
      url: 'http://x:1',
      token: 't',
      manifest: manifest({ id: 'broken', protocolVersion: '9.0.0' }),
      addedAt: 2,
      addedBy: 'admin',
    });
    loadRegisteredAddons(registry, db);
    expect(registry.get('fixture-addon')).toBeDefined();
    expect(registry.get('broken')).toBeUndefined();
  });

  it('removeAddon refuses a builtin and fully removes an addon', async () => {
    await registerAddon(registry, db, {
      url: 'http://addon:9999',
      token: 'tok',
      addedBy: 'admin',
      clientFactory: factoryFor(manifest()),
    });
    await expect(removeAddon(registry, db, 'builtin')).rejects.toThrow(/not a remote addon/);
    await removeAddon(registry, db, 'fixture-addon');
    expect(registry.get('fixture-addon')).toBeUndefined();
    expect(listAddonRegistrations(db)).toHaveLength(0);
  });
});
