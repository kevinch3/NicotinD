import { z } from 'zod';
import type { Plugin, PluginManifest, PluginHostContext } from '@nicotind/core';

export interface SpotifyPluginConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
}

const DISCLAIMER =
  'The Spotify Web API is used to look up album metadata only — no audio is ' +
  'downloaded from Spotify. Downloads of matched albums go through spotDL ' +
  '(which fetches audio from YouTube); enable the spotDL plugin to download.';

/**
 * Metadata-only acquisition plugin: it backs the **Spotify fallback search lane**
 * (`/api/spotify/search`, served by `SpotifySearchService`) but downloads nothing
 * itself — the lane hands a matched album's `open.spotify.com` URL to
 * `/api/acquire`, where the **spotDL** resolve plugin acquires it. So this plugin
 * declares only `search`; it has no `resolve`/`download` and never competes in
 * `getEnabledForUrl`. Its job is to gate the lane (enable + credentials) and hold
 * the Spotify app client id/secret. Pure JS — no binary requirement.
 */
export class SpotifyPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: 'spotify',
    name: 'Spotify (metadata)',
    description:
      'Find albums via the Spotify catalog as a fallback, then download them with spotDL.',
    kind: 'acquisition',
    capabilities: ['search'],
    requirements: { binaries: [] },
    configSchema: z
      .object({
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
      })
      .partial(),
    configFields: [
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        placeholder: 'Spotify app Client ID',
        help: 'Create an app at developer.spotify.com → Dashboard, then paste its Client ID and Secret.',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        placeholder: 'Spotify app Client Secret',
      },
    ],
    compliance: { disclaimer: DISCLAIMER, requiresConsent: false },
    defaultEnabled: false,
  };

  private cfg: SpotifyPluginConfig;

  constructor(config: SpotifyPluginConfig) {
    this.cfg = config;
  }

  async init(ctx: PluginHostContext): Promise<void> {
    this.cfg = { ...this.cfg, ...(ctx.config as Partial<SpotifyPluginConfig>) };
  }

  async isAvailable(): Promise<boolean> {
    // No binary — availability tracks the config flag plus configured creds, so
    // the admin card shows "Unavailable" until a client id/secret is entered.
    return this.cfg.enabled && Boolean(this.cfg.clientId) && Boolean(this.cfg.clientSecret);
  }
}
