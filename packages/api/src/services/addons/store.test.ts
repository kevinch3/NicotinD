import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ADDON_PROTOCOL_VERSION, type AddonManifest } from '@nicotind/core';
import { applySchema } from '../../db.js';
import {
  deleteAddonRegistration,
  listAddonRegistrations,
  saveAddonRegistration,
  type AddonRegistration,
} from './store.js';

const MANIFEST: AddonManifest = {
  id: 'fixture-addon',
  name: 'Fixture Addon',
  description: 'test',
  version: '0.1.0',
  protocolVersion: ADDON_PROTOCOL_VERSION,
  kind: 'acquisition',
  capabilities: ['search'],
};

function reg(over: Partial<AddonRegistration> = {}): AddonRegistration {
  return {
    id: 'fixture-addon',
    url: 'http://addon:9999',
    token: 'tok',
    manifest: MANIFEST,
    addedAt: 1_700_000_000,
    addedBy: 'admin',
    ...over,
  };
}

describe('addon registration store', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('round-trips a registration', () => {
    saveAddonRegistration(db, reg());
    const rows = listAddonRegistrations(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.manifest.name).toBe('Fixture Addon');
    expect(rows[0]!.token).toBe('tok');
  });

  it('upserts on the same id', () => {
    saveAddonRegistration(db, reg());
    saveAddonRegistration(db, reg({ url: 'http://other:1' }));
    const rows = listAddonRegistrations(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe('http://other:1');
  });

  it('deletes a registration', () => {
    saveAddonRegistration(db, reg());
    deleteAddonRegistration(db, 'fixture-addon');
    expect(listAddonRegistrations(db)).toHaveLength(0);
  });

  it('skips a row whose manifest_json is corrupt', () => {
    saveAddonRegistration(db, reg());
    db.run(`UPDATE addon_registrations SET manifest_json = 'not json' WHERE id = ?`, [
      'fixture-addon',
    ]);
    expect(listAddonRegistrations(db)).toHaveLength(0);
  });
});
