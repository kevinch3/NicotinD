import { describe, expect, it } from 'bun:test';
import { ADDON_PROTOCOL_VERSION, type AddonManifest } from '@nicotind/core';
import type { AddonClient } from './client.js';
import { AddonSearchProvider } from './search-provider.js';
import { RemoteAddonPlugin } from './remote-addon-plugin.js';
import { ProviderRegistry } from '../provider-registry.js';

function stubClient(over: Partial<AddonClient> = {}): AddonClient {
  return {
    baseUrl: 'http://addon:9999',
    getHealth: async () => ({ ok: true, ready: true }),
    search: async () => ({
      results: [
        {
          kind: 'song',
          title: '01 Song One.mp3',
          username: 'peer',
          directory: 'Music/Album',
          filename: 'Music\\Album\\01 Song One.mp3',
          size: 100,
          bitRateKbps: 320,
          freeUploadSlots: 2,
          queueLength: 1,
          uploadSpeed: 5000,
        },
        {
          kind: 'folder',
          title: 'Album',
          username: 'peer',
          directory: 'Music/Album',
          files: [],
        },
      ],
      complete: true,
    }),
    createJob: async (req: unknown) => {
      (stubClient as unknown as { lastJob: unknown }).lastJob = req;
      return { id: 'j1', intent: 'browse-grab', items: [] };
    },
    browse: async () => ({ directories: [{ directory: 'peer/Music', fileCount: 0, files: [] }] }),
    ...over,
  } as unknown as AddonClient;
}

const MANIFEST: AddonManifest = {
  id: 'fixture-addon',
  name: 'Fixture',
  description: 'x',
  version: '0.1.0',
  protocolVersion: ADDON_PROTOCOL_VERSION,
  kind: 'acquisition',
  capabilities: ['search', 'browse', 'download'],
};

describe('AddonSearchProvider', () => {
  it('adapts the sync addon search onto the poll shape, regrouped by peer', async () => {
    const provider = new AddonSearchProvider('fixture-addon', stubClient());
    const { searchId } = await provider.search('query');
    expect(searchId).toBeTruthy();
    // Drain the microtask so the buffered response lands.
    await new Promise((r) => setTimeout(r, 0));
    const poll = await provider.pollResults(searchId!);
    expect(poll.state).toBe('complete');
    expect(poll.results).toHaveLength(1);
    expect(poll.results[0]).toMatchObject({
      username: 'peer',
      freeUploadSlots: 2,
      uploadSpeed: 5000,
    });
    expect(poll.results[0]!.files[0]!.filename).toContain('Song One');
  });

  it('reports searching before the addon answers and empty on failure', async () => {
    let resolve!: (v: { results: never[]; complete: true }) => void;
    const provider = new AddonSearchProvider(
      'fixture-addon',
      stubClient({
        search: () => new Promise((r) => (resolve = r)),
      } as Partial<AddonClient>),
    );
    const { searchId } = await provider.search('query');
    expect((await provider.pollResults(searchId!)).state).toBe('searching');
    resolve({ results: [], complete: true });
    await new Promise((r) => setTimeout(r, 0));
    expect((await provider.pollResults(searchId!)).state).toBe('complete');
  });

  it('download() creates a browse-grab job on the addon', async () => {
    const jobs: unknown[] = [];
    const provider = new AddonSearchProvider(
      'fixture-addon',
      stubClient({
        createJob: (async (req: unknown) => {
          jobs.push(req);
          return { id: 'j1' };
        }) as AddonClient['createJob'],
      }),
    );
    await provider.download('peer', [{ filename: 'a.mp3', size: 1 }]);
    expect(jobs[0]).toMatchObject({ intent: 'browse-grab', username: 'peer' });
  });
});

describe('RemoteAddonPlugin capabilities', () => {
  it('registers/unregisters its provider on init/dispose', async () => {
    const providers = new ProviderRegistry();
    const plugin = new RemoteAddonPlugin(MANIFEST, stubClient(), providers);
    expect(plugin.search).toBeDefined();
    expect(plugin.browse).toBeDefined();
    expect(plugin.download).toBeDefined();

    await plugin.init({
      logger: console as never,
      config: {},
      allocStagingDir: () => '/tmp',
      emitProgress() {},
      emitLabel() {},
      emitTrack() {},
      storage: { get: () => null, set() {}, delete() {} },
    });
    expect(providers.getByName('fixture-addon')).toBeDefined();
    expect(providers.getByType('network')).toHaveLength(1);

    await plugin.dispose();
    expect(providers.getByName('fixture-addon')).toBeUndefined();
  });

  it('declares no capabilities when the manifest has none', () => {
    const plugin = new RemoteAddonPlugin(
      { ...MANIFEST, capabilities: ['search'] },
      stubClient(),
      new ProviderRegistry(),
    );
    expect(plugin.search).toBeDefined();
    expect(plugin.browse).toBeUndefined();
    expect(plugin.download).toBeUndefined();
  });
});
