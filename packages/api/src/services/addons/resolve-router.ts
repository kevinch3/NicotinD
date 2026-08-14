import type { PluginRegistry } from '../plugins/registry.js';
import { RemoteAddonPlugin } from './remote-addon-plugin.js';

/**
 * Route a paste URL to the enabled resolve-capable addon whose `urlPatterns`
 * match it (first match wins) — the addon replacement for the in-process
 * `registry.getEnabledForUrl`. Returns the plugin so the acquire route can reach
 * its transport (`plugin.client`) and id (`plugin.addonManifest.id`).
 */
export function resolveAddonForUrl(
  registry: PluginRegistry,
  url: string,
): RemoteAddonPlugin | null {
  for (const plugin of registry.getEnabled('acquisition')) {
    if (!(plugin instanceof RemoteAddonPlugin)) continue;
    if (!plugin.addonManifest.capabilities.includes('resolve')) continue;
    const patterns = plugin.addonManifest.urlPatterns ?? [];
    if (patterns.some((p) => matchesPattern(p, url))) return plugin;
  }
  return null;
}

function matchesPattern(pattern: string, url: string): boolean {
  try {
    return new RegExp(pattern).test(url);
  } catch {
    return false;
  }
}
