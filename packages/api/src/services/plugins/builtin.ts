import { join } from 'node:path';
import type { NicotinDConfig } from '@nicotind/core';
import type { ProviderRegistry } from '../provider-registry.js';
import type { PluginRegistry } from './registry.js';
import { SpotdlPlugin } from './spotdl/index.js';
import { SpotifyPlugin } from './spotify/index.js';
import { LrclibPlugin } from './lrclib/index.js';
import { DiscogsPlugin } from './discogs/index.js';
import { parseDiscogsRef, type DiscogsRef } from './discogs/matching.js';
import { AcoustidPlugin } from './acoustid/index.js';
import { MusicBrainzClient, MB_USER_AGENT } from '../musicbrainz-client.js';

/**
 * Build the MBID-first artist resolver the Discogs plugin's `artist-info`
 * capability uses (issue #195): MusicBrainz's own `discogs` url-relation on the
 * artist → parseDiscogsRef. Extracted as its own function so the resolution
 * logic is unit-testable without constructing the whole plugin registry.
 */
export function makeDiscogsArtistResolver(
  mb: MusicBrainzClient,
): (mbid: string) => Promise<DiscogsRef | null> {
  return async (mbid) => {
    const url = await mb.getArtistDiscogsUrl(mbid);
    return url ? parseDiscogsRef(url) : null;
  };
}

export interface BuiltinPluginDeps {
  config: NicotinDConfig;
  /** Expanded (no `~`) data dir — the zero-config cookies file lives under it. */
  dataDir: string;
  providerRegistry: ProviderRegistry;
  /**
   * The legacy AcoustID API key (from `secrets.json`, not `config` — it
   * predates the plugin system and is still `LibraryOrganizer`'s own
   * tags-missing fallback's key source). Seeds the AcoustID plugin's config so
   * an existing deployment's key keeps working without re-entry.
   */
  acoustidApiKey?: string;
}

/**
 * Construct + register every first-party plugin.
 *
 * Extracted from `createApp` so the **wiring** is testable, not just the parts.
 * A plugin that depends on another plugin's config (spotdl reads spotify's
 * credentials) is only correct if it's handed the `PluginRegistry` at
 * construction; that argument was silently missing for spotdl, which turned the
 * documented SPOTIPY_* forwarding into dead code with every unit test still
 * green. Keeping the construction in one small, covered function is the fix
 * that generalizes.
 *
 * Note the two same-named-but-different registries in play: `PluginRegistry`
 * (the plugin kernel) and `ProviderRegistry` (the acquisition provider list
 * slskd registers into). The proximity is what made the original omission easy
 * to miss.
 */
export function registerBuiltinPlugins(plugins: PluginRegistry, deps: BuiltinPluginDeps): void {
  const { config, dataDir, providerRegistry, acoustidApiKey } = deps;

  // Zero-config cookies: drop a Netscape cookies.txt at
  // <dataDir>/youtube-cookies.txt and both YouTube-backed downloaders pick it
  // up (only when the file exists) — the unblock for YouTube's bot-check on
  // flagged server IPs. An explicit config path overrides the convention.
  const defaultCookiesFile = join(dataDir, 'youtube-cookies.txt');

  // spotdl is the last in-process URL-resolve plugin (spotify.com only). yt-dlp
  // (the catch-all) is now the external nicotind-ytdlp-addon, and archive.org the
  // bundled archive addon — both resolved via resolveAddonForUrl ahead of this.
  plugins.register(
    new SpotdlPlugin(
      {
        enabled: config.acquire.spotdl.enabled,
        binaryPath: config.acquire.spotdl.binaryPath,
        cookiesFile: config.acquire.spotdl.cookiesFile || defaultCookiesFile,
      },
      // Live read of the spotify card's Client ID/Secret at spawn time — the
      // user enters them once on the spotify extension and spotDL inherits
      // them (higher Spotify rate limits than its built-in shared client).
      { registry: plugins },
    ),
  );
  // archive.org is now the bundled built-in addon (services/addons/bundled/archive),
  // registered via registerBundledAddons — no longer an in-process plugin.
  // Metadata-only fallback lane — no `resolve`, so it never competes for URLs.
  plugins.register(
    new SpotifyPlugin({
      enabled: config.acquire.spotify.enabled,
      clientId: config.acquire.spotify.clientId,
      clientSecret: config.acquire.spotify.clientSecret,
    }),
  );
  // yt-dlp is now an external acquisition addon (nicotind-ytdlp-addon) speaking
  // the addon protocol's `url`/`resolve` seam — core carries no yt-dlp code.
  // Register it via Extensions → Add addon; it becomes the low-priority catch-all
  // URL resolver (`urlPatterns: ['^https?://']`, priority -10).
  // Metadata source — lyrics from LRCLIB. Default-on (keyless, benign); seeded
  // enabled on first boot only, so an admin's later disable is preserved.
  plugins.register(new LrclibPlugin());
  // Metadata source — release genres/styles from Discogs. Default-off + consent-
  // gated (Discogs API ToU); the admin enters a Consumer Key + Secret on its
  // extension card. The on-disk response cache lives under the data dir. The
  // shell is registered so it's manageable in Extensions; no enrichment task
  // consumes its `genre` capability yet (that lands gated by the #191 spike).
  // `artist-info` (issue #195) is wired: MBID-first resolution via a real
  // MusicBrainzClient (same on-disk cache convention as makeLicenceLookup in
  // enrichment/tasks.ts) composed through makeDiscogsArtistResolver above.
  const mbClientForDiscogs = new MusicBrainzClient(
    join(dataDir, 'musicbrainz-cache.json'),
    MB_USER_AGENT,
  );
  plugins.register(
    new DiscogsPlugin(
      {
        consumerKey: '',
        consumerSecret: '',
        cacheFile: join(dataDir, 'discogs-cache.json'),
      },
      { resolveDiscogsArtistRef: makeDiscogsArtistResolver(mbClientForDiscogs) },
    ),
  );
  // Metadata source — identifies a track from its audio fingerprint
  // (chromaprint/fpcalc + AcoustID, issue #411's download-inbox triage rescue
  // path). Seeded from the legacy `secrets.json` key so an existing deployment
  // that already configured AcoustID for the organizer's tags-missing fallback
  // keeps working without re-entering it here.
  plugins.register(new AcoustidPlugin({ apiKey: acoustidApiKey ?? '' }));
}
