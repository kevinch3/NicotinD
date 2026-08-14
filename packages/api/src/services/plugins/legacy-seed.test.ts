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
  // yt-dlp is an external addon now; spotdl is the only in-process acquisition
  // plugin the legacy migration still seeds.
  r.register(acqPlugin('spotdl'));
  return r;
}

const FULL = { spotdlEnabled: true };

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
    expect(registry.isEnabled('spotdl')).toBe(true);
  });

  it('leaves a fresh install (no users) default-off', () => {
    seedLegacyAcquisitionPlugins(registry, db, FULL);
    expect(registry.isEnabled('spotdl')).toBe(false);
  });

  it('only seeds the plugins that were actually configured', () => {
    addUser();
    seedLegacyAcquisitionPlugins(registry, db, { spotdlEnabled: false });
    expect(registry.isEnabled('spotdl')).toBe(false);
  });

  it('runs exactly once — a fresh install that later gains a user is not retro-enabled', () => {
    // First boot: fresh (no users) → marks migrated, seeds nothing.
    seedLegacyAcquisitionPlugins(registry, db, FULL);
    // User registers, server restarts → second call must be a no-op.
    addUser();
    seedLegacyAcquisitionPlugins(registry, db, FULL);
    expect(registry.isEnabled('spotdl')).toBe(false);
  });

  it('does not override an admin choice on subsequent boots', () => {
    addUser();
    seedLegacyAcquisitionPlugins(registry, db, FULL);
    // Admin disables spotdl; a later boot must not re-enable it.
    db.run(`UPDATE plugins SET enabled = 0 WHERE id = 'spotdl'`);
    seedLegacyAcquisitionPlugins(registry, db, FULL);
    expect(registry.isEnabled('spotdl')).toBe(false);
  });
});
