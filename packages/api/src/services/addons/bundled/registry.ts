import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, negotiateCapabilities, validateAddonManifest } from '@nicotind/core';
import type { PluginRegistry } from '../../plugins/registry.js';
import type { ProviderRegistry } from '../../provider-registry.js';
import type { AddonCircuitBreaker } from '../circuit-breaker.js';
import { CORE_IMPLEMENTED_ADDON_CAPABILITIES } from '../manager.js';
import { RemoteAddonPlugin } from '../remote-addon-plugin.js';
import { LocalAddonTransport } from '../local-transport.js';
import type { BundledAddon } from './types.js';
import { makeArchiveBundledAddon } from './archive/index.js';

const log = createLogger('bundled-addons');

export interface BundledAddonDeps {
  /** The acquire staging base; each bundled addon downloads under a subdir. */
  stagingDir: string;
  providerRegistry?: ProviderRegistry;
  breaker?: AddonCircuitBreaker;
}

/**
 * Register the first-party bundled addons through the same registry path as an
 * external addon: each is a `RemoteAddonPlugin` over a `LocalAddonTransport`, so
 * it flows through the identical job-poller/feed lanes. No `addon_registrations`
 * row (they are code, not a user-installed URL) and non-removable (see the
 * `bundled` origin flag). Registered disabled — the admin enables it like any
 * consent-gated plugin (a one-click, zero-install first-party source).
 */
export function registerBundledAddons(registry: PluginRegistry, deps: BundledAddonDeps): void {
  const archiveStaging = join(deps.stagingDir, 'bundled-archive');
  // why: a bundled addon's job store is in-memory, so whatever is staged here
  // belongs to a previous process and no job can ever deliver it — on prod a
  // deploy mid-download left 1.9 GB of it (#1892).
  rmSync(archiveStaging, { recursive: true, force: true });
  const addons: BundledAddon[] = [makeArchiveBundledAddon({ stagingDir: archiveStaging })];
  for (const addon of addons) {
    const id = addon.manifest.id;
    const errors = validateAddonManifest(addon.manifest);
    if (errors.length > 0) {
      log.warn({ id, errors }, 'skipping bundled addon with invalid manifest');
      continue;
    }
    const { active } = negotiateCapabilities(
      addon.manifest.capabilities,
      CORE_IMPLEMENTED_ADDON_CAPABILITIES,
    );
    if (active.length === 0) {
      log.warn({ id }, 'skipping bundled addon: no capability this core can use');
      continue;
    }
    if (registry.get(id)) {
      log.warn({ id }, 'bundled addon id already registered; skipping');
      continue;
    }
    const transport = new LocalAddonTransport(addon);
    if (deps.breaker) {
      const breaker = deps.breaker;
      transport.bindOutcome((outcome) => breaker.record(id, outcome));
    }
    registry.register(new RemoteAddonPlugin(addon.manifest, transport, deps.providerRegistry));
    log.info({ id }, 'registered bundled addon');
  }
}
