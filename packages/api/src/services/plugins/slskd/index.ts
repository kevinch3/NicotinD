import type {
  Plugin,
  PluginManifest,
  SearchCapability,
  BrowseCapability,
  DownloadCapability,
  DownloadFileRequest,
} from '@nicotind/core';
import { createLogger } from '@nicotind/core';
import type { SlskdRef } from '../../../index.js';
import type { ProviderRegistry } from '../../provider-registry.js';
import { SlskdSearchProvider } from '../../providers/slskd-provider.js';

const log = createLogger('plugin:slskd');

const DISCLAIMER =
  'Soulseek is a peer-to-peer file-sharing network. By enabling it you take ' +
  'responsibility for ensuring your use complies with copyright and other laws ' +
  'in your jurisdiction. NicotinD does not host, index, or distribute any ' +
  'content — it only drives the slskd client you connect.';

/**
 * Acquisition plugin wrapping the slskd (Soulseek) client. It owns a single
 * `SlskdSearchProvider` and (de)registers it in the legacy `ProviderRegistry`
 * on enable/disable — so the unified-search network lane, the downloads enqueue
 * route, and user-browse all light up only while this plugin is enabled, with no
 * changes to those routes. The richer hunt/fallback/retry engine continues to
 * use the slskd client directly for now (see docs/plugins.md roadmap).
 */
export class SlskdPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: 'slskd',
    name: 'Soulseek (slskd)',
    description:
      'Search and download music from the Soulseek peer-to-peer network via slskd. ' +
      'Powers network search, album hunt, and the watchlist.',
    kind: 'acquisition',
    capabilities: ['search', 'browse', 'download'],
    compliance: { disclaimer: DISCLAIMER, requiresConsent: true },
    defaultEnabled: false,
  };

  private provider: SlskdSearchProvider;
  readonly search: SearchCapability;
  readonly browse: BrowseCapability;
  readonly download: DownloadCapability;

  constructor(
    private slskdRef: SlskdRef,
    private providerRegistry: ProviderRegistry,
  ) {
    this.provider = new SlskdSearchProvider(slskdRef);
    this.search = this.provider;
    this.browse = this.provider;
    this.download = {
      enqueue: (sourceRef: string, files: DownloadFileRequest[]) => {
        if (!this.provider.download) throw new Error('slskd download unavailable');
        return this.provider.download(sourceRef, files);
      },
    };
  }

  async init(): Promise<void> {
    // Expose the slskd provider to the search/download/browse routes.
    this.providerRegistry.register(this.provider);
    log.info('slskd plugin enabled — network search + downloads active');
  }

  async dispose(): Promise<void> {
    this.providerRegistry.unregister(this.provider.name);
    log.info('slskd plugin disabled — network acquisition inactive');
  }

  async isAvailable(): Promise<boolean> {
    return this.slskdRef.current !== null;
  }
}
