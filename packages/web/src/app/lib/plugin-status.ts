/**
 * Unified plugin card status, replacing the two overlapping badges the card
 * used to show (Enabled/Disabled + a conditional Unavailable). Priority order
 * matters: a disabled plugin is "off" even if it happens to be unconfigured
 * too. `needsConfig` is only a REFINEMENT of "not available", never a state
 * that outranks a working plugin — the backend sets it whenever a plugin
 * declares a config schema and nothing has ever been saved to it, which is
 * true of several plugins (yt-dlp/spotDL/archive.org) whose schema is
 * all-optional and that become fully `available` once their binary/feature
 * is ready, with nobody ever needing to touch the config form. So a plugin
 * that IS available is always "ready" regardless of `needsConfig`; only an
 * unavailable plugin distinguishes "needs-config" (fill in the form below)
 * from the more generic "unavailable" (e.g. missing binary).
 */
export type PluginStatus = 'off' | 'needs-config' | 'unavailable' | 'ready';

export function pluginStatus(plugin: {
  enabled: boolean;
  needsConfig: boolean;
  available: boolean;
}): PluginStatus {
  if (!plugin.enabled) return 'off';
  if (!plugin.available) return plugin.needsConfig ? 'needs-config' : 'unavailable';
  return 'ready';
}
