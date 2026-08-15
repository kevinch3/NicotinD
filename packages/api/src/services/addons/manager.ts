import { randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import {
  createLogger,
  negotiateCapabilities,
  validateAddonManifest,
  type AddonManifest,
} from '@nicotind/core';
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
  'resolve',
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
    // A pending catalog install (issue #517 PR2) has only a stub manifest until
    // its container is up — the promoter registers it for real once reachable.
    if (reg.status === 'pending') continue;
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
    status: 'active',
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

/**
 * Mint an opaque install token (issue #517 PR2). It is the addon's outbound
 * bearer, baked into the generated compose snippet's env — so it is a shared
 * secret, stored plaintext like every other registration token. Uses the same
 * entropy source as `mintAgentToken`.
 */
export function mintAddonToken(): string {
  return `nca_addon_${randomBytes(24).toString('hex')}`;
}

/** A catalog entry's minimal install shape (avoids a core→catalog type dep). */
export interface PendingInstallInput {
  /** Catalog id — becomes the registration id (must equal the addon manifest id). */
  id: string;
  name: string;
  kind: AddonManifest['kind'];
  capabilities: AddonManifest['capabilities'];
  description: string;
  addonUrl: string;
}

/**
 * Write a `pending` registration for a catalog install before the container is
 * up. Idempotent: re-installing while still pending returns the SAME token (so
 * a re-click doesn't rotate the token out from under an admin mid-paste). If an
 * `active` registration already exists, throws — it's already installed.
 *
 * The stored manifest is a catalog **stub** (never validated — pending rows are
 * skipped at boot); `promotePendingAddons` replaces it with the real fetched
 * manifest on activation.
 */
export function createPendingRegistration(
  db: Database,
  entry: PendingInstallInput,
  addedBy: string,
): { token: string; reused: boolean } {
  const existing = listAddonRegistrations(db).find((r) => r.id === entry.id);
  if (existing?.status === 'active') {
    throw new Error(`addon "${entry.id}" is already installed`);
  }
  if (existing?.status === 'pending') {
    return { token: existing.token, reused: true };
  }
  const token = mintAddonToken();
  const stub: AddonManifest = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    version: '0.0.0',
    protocolVersion: '0.0.0',
    kind: entry.kind,
    capabilities: entry.capabilities,
  };
  saveAddonRegistration(db, {
    id: entry.id,
    url: entry.addonUrl,
    token,
    manifest: stub,
    addedAt: Math.floor(Date.now() / 1000),
    addedBy,
    status: 'pending',
    catalogId: entry.id,
  });
  return { token, reused: false };
}

export interface PromoteOptions {
  providerRegistry?: ProviderRegistry;
  clientFactory?: ClientFactory;
  breaker?: AddonCircuitBreaker;
}

/**
 * Try to activate every `pending` registration (issue #517 PR2). For each, fetch
 * the live manifest; on success — and only if its id matches the pending row and
 * it validates + negotiates a usable capability — flip the row to `active` with
 * the real manifest and register the plugin (disabled; enabling stays the
 * admin's consent-gated step). An unreachable/invalid addon stays pending and is
 * retried next tick. Returns the ids promoted this pass.
 */
export async function promotePendingAddons(
  registry: PluginRegistry,
  db: Database,
  opts: PromoteOptions = {},
): Promise<string[]> {
  const clientFactory = opts.clientFactory ?? defaultClientFactory;
  const promoted: string[] = [];
  for (const reg of listAddonRegistrations(db)) {
    if (reg.status !== 'pending') continue;
    let manifest: AddonManifest;
    const client = clientFactory(reg.url, reg.token);
    try {
      manifest = await client.getManifest();
    } catch {
      continue; // container not up yet — retry next tick
    }
    // Guard: the reachable addon must be the one we installed. A different addon
    // answering this URL must not silently claim the pending registration.
    if (manifest.id !== reg.id) {
      log.warn(
        { expected: reg.id, got: manifest.id, url: reg.url },
        'pending addon URL served a different manifest id — leaving pending',
      );
      continue;
    }
    const errors = validateAddonManifest(manifest);
    if (errors.length > 0) {
      log.warn({ id: reg.id, errors }, 'pending addon manifest invalid — leaving pending');
      continue;
    }
    const { active } = negotiateCapabilities(
      manifest.capabilities,
      CORE_IMPLEMENTED_ADDON_CAPABILITIES,
    );
    if (active.length === 0) {
      log.warn({ id: reg.id }, 'pending addon declares no usable capability — leaving pending');
      continue;
    }
    // Persist the real manifest + flip to active, then register (disabled).
    saveAddonRegistration(db, { ...reg, manifest, status: 'active' });
    try {
      if (opts.breaker) {
        const breaker = opts.breaker;
        breaker.reset(reg.id);
        client.bindOutcome((outcome) => breaker.record(reg.id, outcome));
      }
      if (!registry.get(reg.id)) {
        registry.register(new RemoteAddonPlugin(manifest, client, opts.providerRegistry));
      }
      promoted.push(reg.id);
      log.info({ id: reg.id }, 'pending addon reachable — activated');
    } catch (err) {
      log.warn({ id: reg.id, err }, 'pending addon activated in DB but failed to register');
    }
  }
  return promoted;
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
  if (plugin.origin.bundled) throw new Error(`bundled addon "${id}" cannot be removed`);
  await registry.disable(id);
  await registry.unregister(id);
  deleteAddonRegistration(db, id);
  breaker?.reset(id);
}
