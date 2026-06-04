import { describe, expect, it, beforeEach } from 'bun:test';
import { validatePluginManifest } from '@nicotind/core';
import { _resetBinaryCache } from '../acquire/process.js';
import { SpotdlPlugin } from './index.js';

describe('SpotdlPlugin', () => {
  beforeEach(() => _resetBinaryCache());

  it('has a valid consent-gated acquisition manifest', () => {
    const p = new SpotdlPlugin({ enabled: true, binaryPath: 'spotdl' });
    expect(validatePluginManifest(p.manifest)).toEqual([]);
    expect(p.manifest.capabilities).toEqual(['resolve']);
    expect(p.manifest.requirements?.binaries).toEqual(['spotdl']);
    expect(p.manifest.compliance?.requiresConsent).toBe(true);
  });

  it('handles Spotify URLs only', () => {
    const p = new SpotdlPlugin({ enabled: true, binaryPath: 'spotdl' });
    expect(p.resolve.canHandle('https://open.spotify.com/album/x')).toBe(true);
    expect(p.resolve.canHandle('https://www.youtube.com/watch?v=x')).toBe(false);
  });

  it('reports availability from enabled flag + binary presence', async () => {
    expect(await new SpotdlPlugin({ enabled: false, binaryPath: 'bun' }).isAvailable()).toBe(false);
    expect(await new SpotdlPlugin({ enabled: true, binaryPath: 'bun' }).isAvailable()).toBe(true);
    expect(
      await new SpotdlPlugin({ enabled: true, binaryPath: '/no/such/binary-xyz' }).isAvailable(),
    ).toBe(false);
  });
});
