import { describe, expect, it } from 'bun:test';
import { validatePluginManifest, type Plugin, type PluginHostContext } from '@nicotind/core';
import { SpotifyPlugin, type SpotifyPluginConfig } from './index.js';

const cfg = (over: Partial<SpotifyPluginConfig> = {}): SpotifyPluginConfig => ({
  enabled: true,
  clientId: 'id',
  clientSecret: 'secret',
  ...over,
});

function fakeCtx(config: Record<string, unknown>): PluginHostContext {
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as PluginHostContext['logger'],
    config,
    allocStagingDir: (id) => id,
    emitProgress() {},
    emitLabel() {},
    storage: { get: () => null, set() {}, delete() {} },
  };
}

describe('SpotifyPlugin', () => {
  it('has a valid manifest (metadata-only, search capability, default-off)', () => {
    const p: Plugin = new SpotifyPlugin(cfg());
    expect(validatePluginManifest(p.manifest)).toEqual([]);
    expect(p.manifest.id).toBe('spotify');
    expect(p.manifest.capabilities).toEqual(['search']);
    expect(p.manifest.defaultEnabled).toBe(false);
    // No resolve/download — download is spotDL's job.
    expect(p.resolve).toBeUndefined();
    expect(p.download).toBeUndefined();
  });

  it('exposes config fields for the admin form, with the secret as a password', () => {
    const fields = new SpotifyPlugin(cfg()).manifest.configFields ?? [];
    expect(fields.map((f) => f.key)).toEqual(['clientId', 'clientSecret']);
    expect(fields.find((f) => f.key === 'clientSecret')?.type).toBe('password');
    expect(fields.find((f) => f.key === 'clientId')?.type).toBe('text');
  });

  it('isAvailable only when enabled AND both credentials are present', async () => {
    expect(await new SpotifyPlugin(cfg()).isAvailable()).toBe(true);
    expect(await new SpotifyPlugin(cfg({ enabled: false })).isAvailable()).toBe(false);
    expect(await new SpotifyPlugin(cfg({ clientId: '' })).isAvailable()).toBe(false);
    expect(await new SpotifyPlugin(cfg({ clientSecret: '' })).isAvailable()).toBe(false);
  });

  it('init merges stored config over the constructor defaults', async () => {
    const p = new SpotifyPlugin(cfg({ clientId: '', clientSecret: '' }));
    expect(await p.isAvailable()).toBe(false);
    await p.init(fakeCtx({ clientId: 'stored-id', clientSecret: 'stored-secret' }));
    expect(await p.isAvailable()).toBe(true);
  });
});
