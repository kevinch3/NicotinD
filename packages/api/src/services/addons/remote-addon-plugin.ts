import {
  createLogger,
  pluginManifestFromAddon,
  type AddonManifest,
  type AddonStatusRow,
  type BrowseCapability,
  type DownloadCapability,
  type Plugin,
  type PluginHostContext,
  type PluginManifest,
  type SearchCapability,
} from '@nicotind/core';
import type { AddonTransport } from './transport.js';
import type { ProviderRegistry } from '../provider-registry.js';
import { AddonSearchProvider } from './search-provider.js';

const log = createLogger('remote-addon');

/**
 * Adapts a remote acquisition addon (docs/acquisition-addon-protocol.md) into
 * the in-process `Plugin` interface, so the registry, gate middleware, and the
 * whole Extensions UI (card, consent, config form, status pill) treat it like
 * any builtin. Phase 0 covers the manage/observe loop; capability providers
 * (search/jobs) arrive with the phase-2 cutover.
 */
export class RemoteAddonPlugin implements Plugin {
  readonly manifest: PluginManifest;
  readonly origin: { remote: true; url: string; bundled?: boolean };
  readonly search?: SearchCapability;
  readonly browse?: BrowseCapability;
  readonly download?: DownloadCapability;

  private provider?: AddonSearchProvider;

  constructor(
    readonly addonManifest: AddonManifest,
    readonly client: AddonTransport,
    private providerRegistry?: ProviderRegistry,
  ) {
    this.manifest = pluginManifestFromAddon(addonManifest);
    // A `local:` transport target marks a bundled first-party addon (in-process,
    // ships with core) — non-removable, unlike a user-registered remote addon.
    const bundled = client.baseUrl.startsWith('local:');
    this.origin = bundled
      ? { remote: true, url: client.baseUrl, bundled: true }
      : { remote: true, url: client.baseUrl };
    // Capability accessors mirror what the manifest declares, all served by one
    // provider adapter — same shape as SlskdPlugin, so the search/browse/
    // enqueue routes light up for a remote addon with zero route changes.
    if (this.manifest.capabilities.includes('search')) {
      const canBrowse = this.manifest.capabilities.includes('browse');
      this.provider = new AddonSearchProvider(this.manifest.id, client, { canBrowse });
      this.search = this.provider;
      if (canBrowse) this.browse = this.provider;
      if (this.manifest.capabilities.includes('download')) {
        this.download = {
          // The capability is fire-and-forget (Promise<void>); the receipt the
          // provider returns is for the enqueue ROUTE, which pre-maps the
          // poller from it (#673) — discard it here explicitly.
          enqueue: async (sourceRef, files) => {
            await this.provider!.download(sourceRef, files);
          },
        };
      }
    }
  }

  async init(ctx: PluginHostContext): Promise<void> {
    // Core owns addon config (it survives addon container recreation); push it
    // down on every (re-)init. A down addon must not fail enable/boot — it
    // will pull nothing until the next config save or re-init reaches it.
    if (Object.keys(ctx.config).length > 0) {
      try {
        await this.client.putConfig(ctx.config);
      } catch (err) {
        log.warn({ id: this.manifest.id, err }, 'config push to addon failed');
      }
    }
    if (this.provider && this.providerRegistry) {
      this.providerRegistry.register(this.provider);
      log.info({ id: this.manifest.id }, 'addon search provider registered');
    }
  }

  async dispose(): Promise<void> {
    if (this.provider && this.providerRegistry) {
      this.providerRegistry.unregister(this.provider.name);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const health = await this.client.getHealth();
      return health.ok && health.ready;
    } catch {
      return false;
    }
  }

  /** Live status rows for the generic addon status panel. */
  status(): Promise<AddonStatusRow[]> {
    return this.client.getStatus();
  }
}
