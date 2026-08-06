import type { Database } from 'bun:sqlite';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { PluginRegistry } from './plugins/registry.js';
import { getMbid, upsertMbid } from './mbid-store.js';
import { normalizeArtistForGrouping } from './album-grouping.js';
import { resolveMbidViaLidarr } from './enrichment/tasks.js';

/**
 * Bridge the plugin registry's `artist-image` capability (Discogs today,
 * issue #422) into the artist-image provider chain's closure shape.
 *
 * The chain hands a provider only `{ id, name }`, but the capability is
 * MBID-only by design (a wrong portrait on a real person's page is worse than
 * none — the same discipline as artist-info). So this closure resolves the
 * MBID exactly the way `fetchAndStoreArtistInfo` does: the `library_mbids`
 * cache first, then one corroborated Lidarr lookup persisted for the next
 * caller (issues #207/#211). No MBID → confident miss, never a name search.
 *
 * Enablement is checked at call time (`getEnabledWithCapability`), matching
 * `gatedSpotifyArtistImageLookup` — the returned closure is wired always-non-null
 * through refs, so config-presence tests on it say nothing about live state.
 */
export function makePluginArtistImageLookup(deps: {
  db: Database;
  lidarr: Lidarr | null | undefined;
  plugins: PluginRegistry;
}): (artist: { id: string; name: string }) => Promise<string | null> {
  return async (artist) => {
    const [provider] = deps.plugins.getEnabledWithCapability('artist-image');
    if (!provider?.artistImage) return null;

    const key = normalizeArtistForGrouping(artist.name);
    let mbid = getMbid(deps.db, 'artist', key)?.mbid ?? null;
    if (!mbid && deps.lidarr) {
      const resolved = await resolveMbidViaLidarr(deps.lidarr, artist.name);
      if (resolved) {
        mbid = resolved.mbid;
        upsertMbid(deps.db, {
          scope: 'artist',
          key,
          mbid,
          source: 'lidarr',
          confidence: resolved.confidence,
        });
      }
    }
    if (!mbid) return null;

    try {
      const result = await provider.artistImage.fetchArtistImage({ mbid });
      return result?.url ?? null;
    } catch {
      // Transient source error — the chain simply yields no portrait this run;
      // nothing is tombstoned, so the artist stays resolvable next time.
      return null;
    }
  };
}
