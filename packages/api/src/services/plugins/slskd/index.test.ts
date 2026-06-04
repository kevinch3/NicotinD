import { describe, expect, it, mock } from 'bun:test';
import { validatePluginManifest } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import type { SlskdRef } from '../../../index.js';
import { ProviderRegistry } from '../../provider-registry.js';
import { SlskdPlugin } from './index.js';

function makeSlskdRef(enqueue = mock(async () => {})): {
  ref: SlskdRef;
  enqueue: typeof enqueue;
} {
  const ref: SlskdRef = {
    current: { transfers: { enqueue } } as unknown as Slskd,
  };
  return { ref, enqueue };
}

describe('SlskdPlugin', () => {
  it('has a valid, consent-gated acquisition manifest', () => {
    const plugin = new SlskdPlugin({ current: null }, new ProviderRegistry());
    expect(validatePluginManifest(plugin.manifest)).toEqual([]);
    expect(plugin.manifest.kind).toBe('acquisition');
    expect(plugin.manifest.capabilities).toEqual(['search', 'browse', 'download']);
    expect(plugin.manifest.compliance?.requiresConsent).toBe(true);
  });

  it('registers its provider on init and removes it on dispose', async () => {
    const registry = new ProviderRegistry();
    const plugin = new SlskdPlugin({ current: null }, registry);

    expect(registry.getByType('network')).toHaveLength(0);
    expect(registry.getBrowseProvider()).toBeNull();

    await plugin.init();
    expect(registry.getByType('network')).toHaveLength(1);
    expect(registry.getBrowseProvider()).not.toBeNull();

    await plugin.dispose();
    expect(registry.getByType('network')).toHaveLength(0);
    expect(registry.getBrowseProvider()).toBeNull();
  });

  it('reports availability from the slskd ref', async () => {
    expect(await new SlskdPlugin({ current: null }, new ProviderRegistry()).isAvailable()).toBe(false);
    const { ref } = makeSlskdRef();
    expect(await new SlskdPlugin(ref, new ProviderRegistry()).isAvailable()).toBe(true);
  });

  it('download capability delegates to slskd transfers.enqueue', async () => {
    const { ref, enqueue } = makeSlskdRef();
    const plugin = new SlskdPlugin(ref, new ProviderRegistry());
    const files = [{ filename: 'a.flac', size: 100 }];
    await plugin.download.enqueue('peer', files);
    expect(enqueue).toHaveBeenCalledWith('peer', files);
  });
});
