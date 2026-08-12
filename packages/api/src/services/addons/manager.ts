import type { Database } from 'bun:sqlite';
import { createLogger, validateAddonManifest } from '@nicotind/core';
import type { PluginRegistry } from '../plugins/registry.js';
import { AddonClient } from './client.js';
import { RemoteAddonPlugin } from './remote-addon-plugin.js';
import {
  deleteAddonRegistration,
  listAddonRegistrations,
  saveAddonRegistration,
  type AddonRegistration,
} from './store.js';

const log = createLogger('addon-manager');

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
  clientFactory: ClientFactory = defaultClientFactory,
): void {
  for (const reg of listAddonRegistrations(db)) {
    const errors = validateAddonManifest(reg.manifest);
    if (errors.length > 0) {
      log.warn({ id: reg.id, errors }, 'skipping stored addon with invalid manifest');
      continue;
    }
    try {
      registry.register(new RemoteAddonPlugin(reg.manifest, clientFactory(reg.url, reg.token)));
    } catch (err) {
      log.warn({ id: reg.id, err }, 'skipping stored addon that failed to register');
    }
  }
}

export interface RegisterAddonInput {
  url: string;
  token: string;
  addedBy: string;
  clientFactory?: ClientFactory;
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
  registry.register(new RemoteAddonPlugin(manifest, client));
  return reg;
}

/** Remove a registered addon: disable, unregister, drop the persisted row. */
export async function removeAddon(
  registry: PluginRegistry,
  db: Database,
  id: string,
): Promise<void> {
  const plugin = registry.get(id);
  if (!plugin) throw new Error(`unknown plugin "${id}"`);
  if (!plugin.origin?.remote) throw new Error(`plugin "${id}" is not a remote addon`);
  await registry.disable(id);
  await registry.unregister(id);
  deleteAddonRegistration(db, id);
}
