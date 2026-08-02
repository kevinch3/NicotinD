/**
 * Unified plugin card status, replacing the two overlapping badges the card
 * used to show (Enabled/Disabled + a conditional Unavailable). Priority order
 * matters: a disabled plugin is "off" even if it happens to be unconfigured
 * too, and an unconfigured plugin reads as "needs-config" rather than the
 * more generic "unavailable" so the fix is obvious (fill in the form below).
 */
export type PluginStatus = 'off' | 'needs-config' | 'unavailable' | 'ready';

export function pluginStatus(plugin: {
  enabled: boolean;
  needsConfig: boolean;
  available: boolean;
}): PluginStatus {
  if (!plugin.enabled) return 'off';
  if (plugin.needsConfig) return 'needs-config';
  if (!plugin.available) return 'unavailable';
  return 'ready';
}
