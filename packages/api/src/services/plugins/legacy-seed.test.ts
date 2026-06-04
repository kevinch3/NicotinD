import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Plugin, PluginManifest } from '@nicotind/core';
import { applySchema } from '../../db.js';
import { PluginRegistry } from './registry.js';
import { seedLegacyAcquisitionPlugins } from './legacy-seed.js';

function acqPlugin(id: string): Plugin {
  const manifest: PluginManifest = {
    id,
    name: id,
    description: 'x',
    kind: 'acquisition',
    capabilities: ['download'],
    defaultEnabled: false,
  };
  return {
    manifest,
    async init() {},
    async isAvailable() {
      return true;
    },
  };
}

function makeRegistry(db: Database): PluginRegistry {
  const r = new PluginRegistry({ db, dataDir: '/tmp/x' });
  r.register(acqPlugin('slskd'));
  r.register(acqPlugin('ytdlp'));
  r.register(acqPlugin('spotdl'));
  return r;
}

const FULL = { slskdConfigured: true, ytdlpEnabled: true, spotdlEnabled: true };

describe('seedLegacyAcquisitionPlugins', () => {
  let db: Database;
  let registry: PluginRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    registry = makeRegistry(db);
  });

  function addUser() {
    db.run(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'admin', 'h')`);
  }

  it('seeds configured plugins enabled on an existing install (users present)', () => {
    addUser();
    seedLegacyAcquisitionPlugins(registry, db, FULL);
    expect(registry.isEnabled('slskd')).toBe(true);
    expect(registry.isEnabled('ytdlp')).toBe(true);
    expect(registry.isEnabled('spotdl')).toBe(true);
  });

  it('leaves a fresh install (no users) default-off', () => {
    seedLegacyAcquisitionPlugins(registry, db, FULL);
    expect(registry.isEnabled('slskd')).toBe(false);
    expect(registry.isEnabled('ytdlp')).toBe(false);
    expect(registry.isEnabled('spotdl')).toBe(false);
  });

  it('only seeds the plugins that were actually configured', () => {
    addUser();
    seedLegacyAcquisitionPlugins(registry, db, { slskdConfigured: false, ytdlpEnabled: true, spotdlEnabled: false });
    expect(registry.isEnabled('slskd')).toBe(false);
    expect(registry.isEnabled('ytdlp')).toBe(true);
    expect(registry.isEnabled('spotdl')).toBe(false);
  });

  it('runs exactly once — a fresh install that later gains a user is not retro-enabled', () => {
    // First boot: fresh (no users) → marks migrated, seeds nothing.
    seedLegacyAcquisitionPlugins(registry, db, FULL);
    // User registers, server restarts → second call must be a no-op.
    addUser();
    seedLegacyAcquisitionPlugins(registry, db, FULL);
    expect(registry.isEnabled('slskd')).toBe(false);
    expect(registry.isEnabled('ytdlp')).toBe(false);
  });

  it('does not override an admin choice on subsequent boots', () => {
    addUser();
    seedLegacyAcquisitionPlugins(registry, db, FULL);
    // Admin disables slskd; a later boot must not re-enable it.
    db.run(`UPDATE plugins SET enabled = 0 WHERE id = 'slskd'`);
    seedLegacyAcquisitionPlugins(registry, db, FULL);
    expect(registry.isEnabled('slskd')).toBe(false);
  });
});
