import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../db.js';
import { PluginRegistry } from './registry.js';
import { registerBuiltinPlugins, type BuiltinPluginDeps } from './builtin.js';
import { SpotdlPlugin } from './spotdl/index.js';
import type { SlskdRef } from '../../index.js';
import type { ProviderRegistry } from '../provider-registry.js';
import type { NicotinDConfig } from '@nicotind/core';

/** Minimal acquire config — only the fields the builtin registration reads. */
function makeDeps(over: Partial<BuiltinPluginDeps> = {}): BuiltinPluginDeps {
  const config = {
    dataDir: '/tmp/nicotind-test',
    acquire: {
      spotdl: { enabled: false, binaryPath: 'spotdl', cookiesFile: '' },
      archive: { enabled: false, preferredFormats: [] },
      spotify: { enabled: false, clientId: '', clientSecret: '' },
      ytdlp: { enabled: false, binaryPath: 'yt-dlp', format: '', extraArgs: [], cookiesFile: '' },
    },
  } as unknown as NicotinDConfig;
  return {
    config,
    dataDir: '/tmp/nicotind-test',
    slskdRef: { current: null } as SlskdRef,
    providerRegistry: {} as ProviderRegistry,
    ...over,
  };
}

describe('registerBuiltinPlugins', () => {
  let db: Database;
  let plugins: PluginRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    plugins = new PluginRegistry({ db, dataDir: '/tmp/nicotind-test' });
    registerBuiltinPlugins(plugins, makeDeps());
  });

  it('registers every built-in plugin exactly once', () => {
    expect(
      plugins
        .getAll()
        .map((p) => p.manifest.id)
        .sort(),
    ).toEqual(['archive', 'lrclib', 'slskd', 'spotdl', 'spotify', 'ytdlp']);
  });

  // Regression: spotdl was constructed without `{ registry }`, so its live read
  // of the spotify plugin's stored credentials never happened and the documented
  // SPOTIPY_* forwarding was dead code. The bug lived in the wiring, not in
  // `spotifyEnvFor` (which was correct and unit-tested all along) — so the test
  // has to assert against the instance the registration actually built.
  it('wires the registry into spotdl so it reads the spotify credentials live', () => {
    const spotdl = plugins.get('spotdl') as SpotdlPlugin;
    expect(spotdl.spotifyEnv()).toBeNull(); // nothing stored yet

    plugins.setConfig('spotify', { clientId: 'id-123', clientSecret: 'secret-456' });

    expect(spotdl.spotifyEnv()).toEqual({
      SPOTIPY_CLIENT_ID: 'id-123',
      SPOTIPY_CLIENT_SECRET: 'secret-456',
    });
  });

  it('leaves spotdl on its built-in shared client when only one credential is stored', () => {
    const spotdl = plugins.get('spotdl') as SpotdlPlugin;
    plugins.setConfig('spotify', { clientId: 'id-123' });
    expect(spotdl.spotifyEnv()).toBeNull();
  });
});
