import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { Plugin, PluginManifest } from '@nicotind/core';
import { applySchema } from '../db.js';
import { PluginRegistry } from './plugins/registry.js';
import {
  applyConfigImport,
  CONFIG_EXPORT_KIND,
  CONFIG_EXPORT_VERSION,
  ConfigImportError,
  exportConfig,
  planConfigImport,
  validateConfigArtifact,
} from './config-export.js';

/** A minimal plugin with a text + password config field. */
function makePlugin(id: string): Plugin {
  const manifest: PluginManifest = {
    id,
    name: id,
    description: 'test',
    kind: 'metadata',
    capabilities: ['genre'],
    defaultEnabled: false,
    configSchema: z
      .object({ clientId: z.string().optional(), clientSecret: z.string().optional() })
      .passthrough(),
    configFields: [
      { key: 'clientId', label: 'Client ID', type: 'text' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password' },
    ],
  };
  return {
    manifest,
    async init() {},
    async isAvailable() {
      return true;
    },
    async dispose() {},
  };
}

describe('config-export', () => {
  let db: Database;
  let registry: PluginRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    registry = new PluginRegistry({ db, dataDir: '/tmp/nicotind-cfg-test' });
    registry.register(makePlugin('spotify'));
  });

  it('exports app_settings + plugins with secrets redacted', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('processing', ?)`, [
      JSON.stringify({ enabled: true, batchSize: 25 }),
    ]);
    registry.setConfig('spotify', { clientId: 'abc', clientSecret: 'super-secret' });

    const artifact = exportConfig(db, registry, { appVersion: '1.2.3', now: 0 });

    expect(artifact.kind).toBe(CONFIG_EXPORT_KIND);
    expect(artifact.version).toBe(CONFIG_EXPORT_VERSION);
    expect(artifact.appVersion).toBe('1.2.3');
    expect(artifact.settings.processing).toEqual({ enabled: true, batchSize: 25 });

    const spotify = artifact.plugins.find((p) => p.id === 'spotify');
    expect(spotify).toBeDefined();
    expect(spotify!.config).toEqual({ clientId: 'abc' }); // non-secret only
    expect(spotify!.config.clientSecret).toBeUndefined(); // never exported
    expect(spotify!.redactedSecrets).toEqual(['clientSecret']);
  });

  it('never lets a secret value appear anywhere in the serialized artifact', () => {
    registry.setConfig('spotify', { clientId: 'abc', clientSecret: 'TOP-SECRET-XYZ' });
    const json = JSON.stringify(exportConfig(db, registry));
    expect(json).not.toContain('TOP-SECRET-XYZ');
  });

  it('validateConfigArtifact rejects wrong kind / version / shape', () => {
    expect(() => validateConfigArtifact(null)).toThrow(ConfigImportError);
    expect(() => validateConfigArtifact({ kind: 'nope' })).toThrow(/wrong "kind"/);
    expect(() =>
      validateConfigArtifact({ kind: CONFIG_EXPORT_KIND, version: 999, settings: {}, plugins: [] }),
    ).toThrow(/Unsupported config version/);
    expect(() =>
      validateConfigArtifact({ kind: CONFIG_EXPORT_KIND, version: 1, settings: [], plugins: [] }),
    ).toThrow(/"settings" must be an object/);
  });

  it('planConfigImport reports create/update/unchanged + unknown-plugin warning', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('processing', ?)`, [
      JSON.stringify({ enabled: true }),
    ]);
    const artifact = {
      kind: CONFIG_EXPORT_KIND,
      version: 1,
      appVersion: null,
      exportedAt: 'x',
      settings: { processing: { enabled: true }, streaming: { transcode: false } },
      plugins: [
        { id: 'spotify', enabled: true, config: { clientId: 'x' }, redactedSecrets: ['clientSecret'], consentAt: null, consentUser: null },
        { id: 'ghost', enabled: true, config: {}, redactedSecrets: [], consentAt: null, consentUser: null },
      ],
    };
    const plan = planConfigImport(db, registry, artifact);
    const byKey = Object.fromEntries(plan.settings.map((s) => [s.key, s.action]));
    expect(byKey.processing).toBe('unchanged');
    expect(byKey.streaming).toBe('create');
    // unknown plugin warned; redacted-secret re-entry warned for the enabled known one
    expect(plan.warnings.some((w) => w.includes('ghost'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('spotify') && w.includes('secret'))).toBe(true);
  });

  it('applyConfigImport is idempotent and merges plugin config (keeps existing secret)', async () => {
    // Host already has the secret; the import (redacted) must not wipe it.
    registry.setConfig('spotify', { clientSecret: 'existing' });
    const artifact = exportConfig(db, registry); // clientId absent, secret redacted
    // Simulate a source that also set a non-secret field.
    artifact.plugins = artifact.plugins.map((p) =>
      p.id === 'spotify' ? { ...p, enabled: true, config: { clientId: 'imported' } } : p,
    );

    const r1 = await applyConfigImport(db, registry, artifact, { consentUser: 'admin' });
    expect(r1.pluginsConfigured).toBe(1);
    const merged = registry.getConfig('spotify');
    expect(merged.clientId).toBe('imported');
    expect(merged.clientSecret).toBe('existing'); // secret preserved via merge
    expect(registry.isEnabled('spotify')).toBe(true);

    // Re-import: same values, still valid, no throw.
    const r2 = await applyConfigImport(db, registry, artifact, { consentUser: 'admin' });
    expect(r2.settingsWritten).toBe(r1.settingsWritten);
    expect(registry.getConfig('spotify').clientSecret).toBe('existing');
  });

  it('applyConfigImport writes app_settings', async () => {
    const artifact = {
      kind: CONFIG_EXPORT_KIND,
      version: 1,
      appVersion: null,
      exportedAt: 'x',
      settings: { streaming: { transcode: true } },
      plugins: [],
    };
    const res = await applyConfigImport(db, registry, artifact, { consentUser: 'admin' });
    expect(res.settingsWritten).toBe(1);
    const row = db
      .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
      .get('streaming');
    expect(JSON.parse(row!.value)).toEqual({ transcode: true });
  });
});
