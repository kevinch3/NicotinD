import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  applyConfigFieldDefaults,
  validatePluginManifest,
  type PluginManifest,
} from './manifest.js';

function base(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'slskd',
    name: 'Soulseek (slskd)',
    description: 'P2P acquisition',
    kind: 'acquisition',
    capabilities: ['search', 'download'],
    defaultEnabled: false,
    ...overrides,
  };
}

describe('validatePluginManifest', () => {
  it('accepts a well-formed acquisition manifest', () => {
    expect(validatePluginManifest(base())).toEqual([]);
  });

  it('accepts a connectivity manifest', () => {
    expect(
      validatePluginManifest(
        base({ id: 'tailscale', kind: 'connectivity', capabilities: ['connectivity'] }),
      ),
    ).toEqual([]);
  });

  it('accepts a metadata lyrics manifest that default-enables', () => {
    expect(
      validatePluginManifest(
        base({
          id: 'lrclib',
          kind: 'metadata',
          capabilities: ['lyrics'],
          defaultEnabled: true,
        }),
      ),
    ).toEqual([]);
  });

  it('accepts a metadata genre manifest (Discogs shell)', () => {
    expect(
      validatePluginManifest(
        base({ id: 'discogs', kind: 'metadata', capabilities: ['genre'], defaultEnabled: false }),
      ),
    ).toEqual([]);
  });

  it('accepts artist-info as a valid metadata capability', () => {
    const errors = validatePluginManifest({
      id: 'test-artist-info',
      name: 'Test',
      description: 'test',
      kind: 'metadata',
      capabilities: ['artist-info'],
      defaultEnabled: false,
    });
    expect(errors).toEqual([]);
  });

  it('rejects a metadata capability not in the metadata kind', () => {
    const errs = validatePluginManifest(
      base({ id: 'lrclib', kind: 'metadata', capabilities: ['search'] }),
    );
    expect(errs.some((e) => e.includes('invalid for kind'))).toBe(true);
  });

  it('rejects a non-kebab-case id', () => {
    expect(validatePluginManifest(base({ id: 'Slsk D' }))).toContainEqual(
      expect.stringContaining('invalid plugin id'),
    );
  });

  it('rejects an empty capabilities list', () => {
    expect(validatePluginManifest(base({ capabilities: [] }))).toContainEqual(
      expect.stringContaining('no capabilities'),
    );
  });

  it('rejects a capability that does not belong to the kind', () => {
    const errs = validatePluginManifest(base({ kind: 'connectivity', capabilities: ['search'] }));
    expect(errs.some((e) => e.includes('invalid for kind'))).toBe(true);
  });

  it('rejects a default-enabled acquisition plugin (opt-in only)', () => {
    expect(validatePluginManifest(base({ defaultEnabled: true }))).toContainEqual(
      expect.stringContaining('opt-in only'),
    );
  });

  it('carries an optional zod config schema without complaint', () => {
    const m = base({ configSchema: z.object({ apiKey: z.string() }) });
    expect(validatePluginManifest(m)).toEqual([]);
  });
});

describe('applyConfigFieldDefaults', () => {
  const manifest = base({
    configFields: [
      { key: 'apiKey', label: 'API key', type: 'password' },
      { key: 'binaryPath', label: 'binary path', type: 'text', defaultValue: 'fpcalc' },
    ],
  });

  it('fills in the default when the stored value is a blank string', () => {
    // The bug: a form saved with the optional path left empty persists "",
    // which then overwrites the default and makes the probe run on "".
    expect(applyConfigFieldDefaults(manifest, { binaryPath: '' })).toEqual({
      binaryPath: 'fpcalc',
    });
  });

  it('fills in the default when the key is absent entirely', () => {
    expect(applyConfigFieldDefaults(manifest, {})).toEqual({ binaryPath: 'fpcalc' });
  });

  it('treats a whitespace-only value as blank', () => {
    expect(applyConfigFieldDefaults(manifest, { binaryPath: '   ' })).toEqual({
      binaryPath: 'fpcalc',
    });
  });

  it('keeps a real stored value', () => {
    expect(applyConfigFieldDefaults(manifest, { binaryPath: '/usr/bin/fpcalc' })).toEqual({
      binaryPath: '/usr/bin/fpcalc',
    });
  });

  it('leaves a blank field that declares no default alone, so a secret stays clearable', () => {
    expect(applyConfigFieldDefaults(manifest, { apiKey: '', binaryPath: 'fpcalc' })).toEqual({
      apiKey: '',
      binaryPath: 'fpcalc',
    });
  });

  it('passes through unrelated keys untouched', () => {
    expect(applyConfigFieldDefaults(manifest, { other: 7, binaryPath: 'x' })).toEqual({
      other: 7,
      binaryPath: 'x',
    });
  });

  it('is a no-op for a manifest with no configFields', () => {
    expect(applyConfigFieldDefaults(base(), { a: 1 })).toEqual({ a: 1 });
  });
});
