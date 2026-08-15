import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ADDON_PROTOCOL_VERSION, type AddonManifest, type Plugin } from '@nicotind/core';
import { applySchema } from '../../db.js';
import { PluginRegistry } from '../plugins/registry.js';
import { AddonClient } from './client.js';
import { listAddonRegistrations, saveAddonRegistration } from './store.js';
import {
  loadRegisteredAddons,
  registerAddon,
  removeAddon,
  createPendingRegistration,
  promotePendingAddons,
  mintAddonToken,
} from './manager.js';

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

  it('rejects an addon that declares no capability this core implements', async () => {
    // A metadata capability: core consumes acquisition caps (search/browse/
    // download/resolve) from addons, not metadata ones, so this negotiates empty.
    await expect(
      registerAddon(registry, db, {
        url: 'http://addon:9999',
        token: 'tok',
        addedBy: 'admin',
        clientFactory: factoryFor(manifest({ kind: 'metadata', capabilities: ['lyrics'] })),
      }),
    ).rejects.toThrow(/no capability this server can use/);
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
      status: 'active',
    });
    saveAddonRegistration(db, {
      id: 'broken',
      url: 'http://x:1',
      token: 't',
      manifest: manifest({ id: 'broken', protocolVersion: '9.0.0' }),
      addedAt: 2,
      addedBy: 'admin',
      status: 'active',
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

  describe('one-click install (issue #517 PR2)', () => {
    const ENTRY = {
      id: 'fixture-addon',
      name: 'Fixture',
      kind: 'acquisition' as const,
      capabilities: ['search' as const],
      description: 'x',
      addonUrl: 'http://addon:9999',
    };

    it('mintAddonToken is opaque, prefixed, and unique', () => {
      const a = mintAddonToken();
      const b = mintAddonToken();
      expect(a).toMatch(/^nca_addon_[0-9a-f]{48}$/);
      expect(a).not.toBe(b);
    });

    it('createPendingRegistration writes a pending row not registered at boot', () => {
      const { token, reused } = createPendingRegistration(db, ENTRY, 'admin');
      expect(reused).toBe(false);
      expect(token).toMatch(/^nca_addon_/);
      const row = listAddonRegistrations(db).find((r) => r.id === 'fixture-addon')!;
      expect(row.status).toBe('pending');
      expect(row.catalogId).toBe('fixture-addon');
      // A pending row is skipped at boot (stub manifest, not yet reachable).
      loadRegisteredAddons(registry, db);
      expect(registry.get('fixture-addon')).toBeUndefined();
    });

    it('re-installing while pending returns the SAME token (idempotent)', () => {
      const first = createPendingRegistration(db, ENTRY, 'admin');
      const second = createPendingRegistration(db, ENTRY, 'admin');
      expect(second.reused).toBe(true);
      expect(second.token).toBe(first.token);
    });

    it('refuses to re-install an already-active addon', async () => {
      await registerAddon(registry, db, {
        url: 'http://addon:9999',
        token: 'tok',
        addedBy: 'admin',
        clientFactory: factoryFor(manifest()),
      });
      expect(() => createPendingRegistration(db, ENTRY, 'admin')).toThrow(/already installed/);
    });

    it('promotes a pending addon once its manifest is reachable', async () => {
      createPendingRegistration(db, ENTRY, 'admin');
      const promoted = await promotePendingAddons(registry, db, {
        clientFactory: factoryFor(manifest()),
      });
      expect(promoted).toEqual(['fixture-addon']);
      expect(listAddonRegistrations(db).find((r) => r.id === 'fixture-addon')?.status).toBe(
        'active',
      );
      expect(registry.get('fixture-addon')?.origin?.remote).toBe(true);
      // Activated, but still disabled — enabling stays the consent-gated step.
      expect(registry.get('fixture-addon')).toBeDefined();
    });

    it('leaves a pending addon pending when unreachable', async () => {
      createPendingRegistration(db, ENTRY, 'admin');
      const promoted = await promotePendingAddons(registry, db, {
        clientFactory: factoryFor(new Error('ECONNREFUSED')),
      });
      expect(promoted).toEqual([]);
      expect(listAddonRegistrations(db).find((r) => r.id === 'fixture-addon')?.status).toBe(
        'pending',
      );
    });

    it('refuses to promote when the URL serves a different manifest id', async () => {
      createPendingRegistration(db, ENTRY, 'admin');
      const promoted = await promotePendingAddons(registry, db, {
        clientFactory: factoryFor(manifest({ id: 'impostor' })),
      });
      expect(promoted).toEqual([]);
      expect(listAddonRegistrations(db).find((r) => r.id === 'fixture-addon')?.status).toBe(
        'pending',
      );
    });
  });
});
