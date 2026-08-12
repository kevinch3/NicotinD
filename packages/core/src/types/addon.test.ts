import { describe, expect, it } from 'bun:test';
import {
  addonAlbumSearchRequestSchema,
  addonJobRequestSchema,
  addonSearchRequestSchema,
  ADDON_PROTOCOL_VERSION,
  addonManifestSchema,
  addonProtocolSupported,
  validateAddonManifest,
  type AddonManifest,
} from './addon.js';

function base(overrides: Partial<AddonManifest> = {}): AddonManifest {
  return {
    id: 'fixture-addon',
    name: 'Fixture Addon',
    description: 'A test acquisition addon',
    version: '0.1.0',
    protocolVersion: ADDON_PROTOCOL_VERSION,
    kind: 'acquisition',
    capabilities: ['search'],
    ...overrides,
  };
}

describe('addonProtocolSupported', () => {
  it('accepts any 1.x version', () => {
    expect(addonProtocolSupported('1.0.0')).toBe(true);
    expect(addonProtocolSupported('1.9.3')).toBe(true);
  });

  it('rejects other majors and garbage', () => {
    expect(addonProtocolSupported('2.0.0')).toBe(false);
    expect(addonProtocolSupported('0.9.0')).toBe(false);
    expect(addonProtocolSupported('not-a-version')).toBe(false);
  });
});

describe('validateAddonManifest', () => {
  it('passes a valid manifest', () => {
    expect(validateAddonManifest(base())).toEqual([]);
  });

  it('rejects an unsupported protocol version', () => {
    const errs = validateAddonManifest(base({ protocolVersion: '2.0.0' }));
    expect(errs.some((e) => e.includes('protocol'))).toBe(true);
  });

  it('rejects a bad id', () => {
    const errs = validateAddonManifest(base({ id: 'Bad Id' }));
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects a capability invalid for the kind', () => {
    const errs = validateAddonManifest(base({ capabilities: ['lyrics'] }));
    expect(errs.some((e) => e.includes('capability'))).toBe(true);
  });
});

describe('addonManifestSchema', () => {
  it('parses a minimal valid manifest', () => {
    const parsed = addonManifestSchema.parse(base());
    expect(parsed.id).toBe('fixture-addon');
  });

  it('parses optional fields', () => {
    const parsed = addonManifestSchema.parse(
      base({
        configFields: [{ key: 'username', label: 'Username', type: 'text' }],
        statusFields: [{ key: 'peers', label: 'Peers' }],
        compliance: { disclaimer: 'Test', requiresConsent: true },
        urlPatterns: ['^https://example\\.com/'],
      }),
    );
    expect(parsed.statusFields?.[0]?.key).toBe('peers');
    expect(parsed.compliance?.requiresConsent).toBe(true);
  });

  it('rejects a manifest missing protocolVersion', () => {
    const rest: Record<string, unknown> = { ...base() };
    delete rest.protocolVersion;
    expect(() => addonManifestSchema.parse(rest)).toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => addonManifestSchema.parse('nope')).toThrow();
  });
});

describe('addon job/search request schemas', () => {
  it('accepts an album job request', () => {
    const parsed = addonJobRequestSchema.parse({
      intent: 'album',
      artist: 'A',
      album: 'B',
      canonicalTracks: [{ title: 'T1' }],
      wantedTracks: [{ title: 'T1' }],
      minMatchPct: 80,
    });
    expect(parsed.intent).toBe('album');
  });

  it('rejects an unknown intent and an out-of-range matchPct', () => {
    expect(() => addonJobRequestSchema.parse({ intent: 'url' })).toThrow();
    expect(() => addonJobRequestSchema.parse({ intent: 'album', minMatchPct: 101 })).toThrow();
  });

  it('accepts search + albums/search requests', () => {
    expect(addonSearchRequestSchema.parse({ query: 'x' }).query).toBe('x');
    expect(
      addonAlbumSearchRequestSchema.parse({
        artist: 'A',
        album: 'B',
        canonicalTracks: [],
      }).album,
    ).toBe('B');
  });
});
