import type { Database } from 'bun:sqlite';
import { pickArtistImage } from './artwork-store.js';
import {
  findLidarrArtist,
  type ArtistImageLidarr,
  type ArtistImageProvider,
  type LidarrArtistIndex,
} from './artist-image.js';

/**
 * The artist-image **provider chain** — the single place that knows which
 * sources exist and in what priority order they run.
 *
 * Before this, `resolveArtistImageUrl` hard-coded a two-provider Lidarr→Spotify
 * disjunction with individually-typed deps, and adding a third source meant four
 * coordinated edits (resolver signature, source union, task `available` gate,
 * call site). Now a source is **one entry in {@link CHAIN}**: the resolver
 * ({@link resolveArtistImageUrl}) walks whatever list this factory returns, the
 * source is an open `string`, and the task gate derives from
 * {@link configuredArtistImageSources}. This is also the shape the genre path
 * (`lidarr → musicbrainz → …`) will reuse, which is why getting it right here is
 * worth more than the refactor itself.
 *
 * Each provider **contains its own deps**: the Lidarr provider closes over the
 * `db` handle + the per-batch monitored index (so `artist_discography_links`
 * coupling never leaks into the generic chain); the Spotify provider closes over
 * its name→URL lookup. The manual-override short-circuit deliberately stays at
 * the call site (the enrichment task's `manual_override = 0` SQL predicate), not
 * here — the chain only ever answers "what portrait does a source have?".
 */

/** Config presence for each source — cheap, no `db`/index, drives the gate. */
export interface ArtistImageConfig {
  lidarr: ArtistImageLidarr | null;
  /** Returns a Spotify portrait URL for an artist name, or null. */
  spotifyLookup: ((name: string) => Promise<string | null>) | null;
}

/** Everything a provider needs to actually run — config plus per-batch runtime. */
export interface ArtistImageProviderDeps extends ArtistImageConfig {
  db: Database;
  /** Monitored Lidarr artists, fetched + indexed once per batch. */
  index: LidarrArtistIndex | null;
  /** Opt-in per-artist Lidarr `artist.lookup` (slow); off for bulk runs. */
  lookupMissing?: boolean;
}

/** Build the Lidarr provider: discography-link/monitored/lookup → poster URL. */
function makeLidarrArtistImageProvider(deps: ArtistImageProviderDeps): ArtistImageProvider {
  return {
    source: 'lidarr',
    lookup: async (artist) => {
      // No index built (Lidarr blip / not yet fetched) → nothing to resolve.
      if (!deps.lidarr || !deps.index) return null;
      const la = await findLidarrArtist(deps.db, deps.lidarr, deps.index, artist, {
        lookupMissing: deps.lookupMissing,
      });
      return pickArtistImage(la?.images) ?? null;
    },
  };
}

/** Build the Spotify provider: artist name → portrait URL. */
function makeSpotifyArtistImageProvider(
  spotifyLookup: (name: string) => Promise<string | null>,
): ArtistImageProvider {
  return {
    source: 'spotify',
    lookup: (artist) => spotifyLookup(artist.name),
  };
}

/**
 * The chain in fixed priority order. One entry per source; `isConfigured` is the
 * config-only test the availability gate reads, `build` produces the runtime
 * provider. Adding a source = one entry here.
 */
const CHAIN: ReadonlyArray<{
  source: string;
  isConfigured(cfg: ArtistImageConfig): boolean;
  build(deps: ArtistImageProviderDeps): ArtistImageProvider;
}> = [
  {
    source: 'lidarr',
    isConfigured: (cfg) => cfg.lidarr != null,
    build: makeLidarrArtistImageProvider,
  },
  {
    source: 'spotify',
    isConfigured: (cfg) => cfg.spotifyLookup != null,
    build: (deps) => makeSpotifyArtistImageProvider(deps.spotifyLookup!),
  },
];

/**
 * The sources that *would* run given the current config, in priority order.
 * Config-only (no `db`/index needed), so the enrichment task's `available` gate
 * is "at least one provider configured" — `configuredArtistImageSources(ctx).length > 0`
 * — instead of a hand-maintained `lidarr || spotify` disjunction.
 */
export function configuredArtistImageSources(cfg: ArtistImageConfig): string[] {
  return CHAIN.filter((entry) => entry.isConfigured(cfg)).map((entry) => entry.source);
}

/**
 * Assemble the runtime provider chain from `deps`, skipping unconfigured
 * sources, in fixed priority order. Feed the result to
 * {@link resolveArtistImageUrl}.
 */
export function buildArtistImageProviders(deps: ArtistImageProviderDeps): ArtistImageProvider[] {
  return CHAIN.filter((entry) => entry.isConfigured(deps)).map((entry) => entry.build(deps));
}
