import { BUNDLED_ARCHIVE_ID } from './addons/bundled/archive/index.js';

/**
 * Which plugin enables each metadata source (#1728).
 *
 * A source id names where a candidate came from ('archive', 'spotify'); the
 * plugin id names what the admin enabled. They matched until archive.org moved
 * from an in-process plugin ('archive') to a bundled addon ('bundled-archive',
 * #511), and the search and hunt gates kept asking about the old id, so enabling
 * archive.org never turned its search on.
 */
const PLUGIN_FOR_SOURCE: Record<string, string> = {
  archive: BUNDLED_ARCHIVE_ID,
};

/** A source gate over the plugin registry: `(sourceId) => enabled`. */
export function sourceEnabled(plugins: {
  isEnabled: (pluginId: string) => boolean;
}): (sourceId: string) => boolean {
  return (sourceId) => plugins.isEnabled(PLUGIN_FOR_SOURCE[sourceId] ?? sourceId);
}
