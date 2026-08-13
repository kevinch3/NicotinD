import type { Database } from 'bun:sqlite';
import { createLogger, negotiateCapabilities, validateAddonManifest } from '@nicotind/core';
import type { PluginRegistry } from '../plugins/registry.js';
import type { ProviderRegistry } from '../provider-registry.js';
import { AddonClient } from './client.js';
import type { AddonCircuitBreaker } from './circuit-breaker.js';
import { RemoteAddonPlugin } from './remote-addon-plugin.js';
import {
  deleteAddonRegistration,
  listAddonRegistrations,
  saveAddonRegistration,
  type AddonRegistration,
} from './store.js';

const log = createLogger('addon-manager');

/**
 * Addon capabilities this core version actually consumes (§2 negotiation). An
 * addon declaring only capabilities outside this set is useless here and is
 * rejected; capabilities beyond it are ignored, not errors (forward compat).
 * Widens as core learns to consume more (resolve, metadata kinds) in the
 * later sub-projects.
 */
export const CORE_IMPLEMENTED_ADDON_CAPABILITIES: ReadonlySet<string> = new Set([
  'search',
  'browse',
  'download',
]);

type ClientFactory = (url: string, token: string) => AddonClient;

const defaultClientFactory: ClientFactory = (url, token) =>
  new AddonClient({ baseUrl: url, token });

/**
 * Re-register every persisted addon at boot from its manifest snapshot (no
 * network — the addon may be down; its card renders and `isAvailable` reports
 * false). A row that no longer validates, or collides with a builtin id, is
 * skipped with a warning: boot never dies on a stale addon.
 */
export function loadRegisteredAddons(
  registry: PluginRegistry,
  db: Database,
  opts: {
    providerRegistry?: ProviderRegistry;
    clientFactory?: ClientFactory;
    breaker?: AddonCircuitBreaker;
  } = {},
): void {
  const clientFactory = opts.clientFactory ?? defaultClientFactory;
  for (const reg of listAddonRegistrations(db)) {
    const errors = validateAddonManifest(reg.manifest);
    if (errors.length > 0) {
      log.warn({ id: reg.id, errors }, 'skipping stored addon with invalid manifest');
      continue;
    }
    // Re-negotiate at boot: a stored addon whose capabilities this core no
    // longer implements is disabled with a stated reason, not silently broken.
    const { active } = negotiateCapabilities(
      reg.manifest.capabilities,
      CORE_IMPLEMENTED_ADDON_CAPABILITIES,
    );
    if (active.length === 0) {
      log.warn(
        { id: reg.id, declared: reg.manifest.capabilities },
        'disabling stored addon: no capability this core version can use',
      );
      continue;
    }
    try {
      const client = clientFactory(reg.url, reg.token);
      if (opts.breaker) {
        const breaker = opts.breaker;
        client.bindOutcome((outcome) => breaker.record(reg.id, outcome));
      }
      registry.register(new RemoteAddonPlugin(reg.manifest, client, opts.providerRegistry));
    } catch (err) {
      log.warn({ id: reg.id, err }, 'skipping stored addon that failed to register');
    }
  }
}

export interface RegisterAddonInput {
  url: string;
  token: string;
  addedBy: string;
  providerRegistry?: ProviderRegistry;
  clientFactory?: ClientFactory;
  breaker?: AddonCircuitBreaker;
}

/**
 * Register a remote addon: fetch + validate its manifest, persist the
 * registration, and add it to the live registry (disabled — enabling is the
 * admin's separate, consent-gated step, exactly like a builtin).
 */
export async function registerAddon(
  registry: PluginRegistry,
  db: Database,
  input: RegisterAddonInput,
): Promise<AddonRegistration> {
  const factory = input.clientFactory ?? defaultClientFactory;
  const client = factory(input.url, input.token);
  const manifest = await client.getManifest();
  const errors = validateAddonManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`addon manifest rejected: ${errors.join('; ')}`);
  }
  const { active, ignored } = negotiateCapabilities(
    manifest.capabilities,
    CORE_IMPLEMENTED_ADDON_CAPABILITIES,
  );
  if (active.length === 0) {
    throw new Error(
      `addon "${manifest.id}" declares no capability this server can use (declared: ${manifest.capabilities.join(', ') || 'none'})`,
    );
  }
  if (ignored.length > 0) {
    log.info({ id: manifest.id, ignored }, 'addon declares capabilities this core ignores');
  }
  if (registry.get(manifest.id)) {
    throw new Error(`a plugin with id "${manifest.id}" is already registered`);
  }
  const reg: AddonRegistration = {
    id: manifest.id,
    url: client.baseUrl,
    token: input.token,
    manifest,
    addedAt: Math.floor(Date.now() / 1000),
    addedBy: input.addedBy,
  };
  saveAddonRegistration(db, reg);
  if (input.breaker) {
    const breaker = input.breaker;
    breaker.reset(manifest.id); // fresh slate for a (re-)registered addon
    client.bindOutcome((outcome) => breaker.record(manifest.id, outcome));
  }
  registry.register(new RemoteAddonPlugin(manifest, client, input.providerRegistry));
  return reg;
}

/** The enabled remote acquisition addon that can download, if any (first wins). */
export function activeRemoteAcquisitionAddon(registry: PluginRegistry): RemoteAddonPlugin | null {
  for (const plugin of registry.getEnabled('acquisition')) {
    if (plugin instanceof RemoteAddonPlugin && plugin.manifest.capabilities.includes('download')) {
      return plugin;
    }
  }
  return null;
}

/** Remove a registered addon: disable, unregister, drop the persisted row. */
export async function removeAddon(
  registry: PluginRegistry,
  db: Database,
  id: string,
  breaker?: AddonCircuitBreaker,
): Promise<void> {
  const plugin = registry.get(id);
  if (!plugin) throw new Error(`unknown plugin "${id}"`);
  if (!plugin.origin?.remote) throw new Error(`plugin "${id}" is not a remote addon`);
  await registry.disable(id);
  await registry.unregister(id);
  deleteAddonRegistration(db, id);
  breaker?.reset(id);
}
