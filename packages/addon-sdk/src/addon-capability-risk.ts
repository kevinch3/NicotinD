import type { PluginCapability } from './manifest.js';

/**
 * Plain-language consent lines, one per protocol capability
 * (docs/superpowers/specs/2026-08-13-addon-ecosystem-security-contract-foundation-design.md
 * §3). Permissions are coarse (capabilities ARE permissions), so this catalog
 * is what makes consent *honest*: it names the real-world risk each capability
 * carries — most importantly that `download` means core writes the addon's
 * files into your library.
 *
 * Typed as a total `Record<PluginCapability, …>`, so adding a capability to the
 * union without a risk line is a COMPILE error — the exhaustive-and-honest
 * guard the design calls for, enforced by the type system rather than a test.
 * Both the consent UI and the published protocol spec render from this one map.
 */
export const CAPABILITY_RISK: Record<PluginCapability, string> = {
  search: 'Sends your search terms to this addon and shows the results it returns.',
  browse: 'Lists files and folders this addon can see on its sources.',
  resolve: 'Fetches media over the network from URLs this addon selects.',
  download: 'Downloads files this addon chooses and writes them into your library.',
  lyrics: 'Fetches lyrics this addon returns and stores them on your tracks.',
  genre: 'Fetches genre tags this addon returns and stores them on your tracks.',
  'artist-info': 'Fetches artist biographies and links this addon returns and stores them.',
  'artist-image': 'Fetches artist images this addon returns and stores them.',
  'release-candidates': 'Fetches release/album metadata candidates this addon returns.',
  identify: 'Sends audio fingerprints to this addon to identify tracks.',
  connectivity: 'Provides network connectivity/tunnelling for this server.',
};

/**
 * Risk line for a capability string. Manifest capabilities are validated only
 * as strings, so an addon may declare one this core version does not recognize;
 * such a capability is inert (nothing consumes it) but still disclosed.
 */
export function capabilityRiskLine(capability: string): string {
  return (
    CAPABILITY_RISK[capability as PluginCapability] ??
    'Uses a capability this version of NicotinD does not recognize (it will have no effect).'
  );
}
