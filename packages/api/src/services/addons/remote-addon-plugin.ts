import {
  createLogger,
  pluginManifestFromAddon,
  type AddonManifest,
  type AddonStatusRow,
  type Plugin,
  type PluginHostContext,
  type PluginManifest,
} from '@nicotind/core';
import type { AddonClient } from './client.js';

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
  readonly origin: { remote: true; url: string };

  constructor(
    readonly addonManifest: AddonManifest,
    private client: AddonClient,
  ) {
    this.manifest = pluginManifestFromAddon(addonManifest);
    this.origin = { remote: true, url: client.baseUrl };
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
