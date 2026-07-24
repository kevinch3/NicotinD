import { z } from 'zod';
import type {
  Plugin,
  PluginManifest,
  PluginHostContext,
  GenreCapability,
  GenreQuery,
  GenreResult,
  ArtistInfoCapability,
  ArtistInfoQuery,
  ArtistInfoResult,
} from '@nicotind/core';
import { DiscogsClient, type DiscogsClientDeps } from './client.js';
import {
  buildSearchParams,
  selectBestRelease,
  mapReleaseGenres,
  mapArtistInfo,
  type DiscogsRef,
  type DiscogsArtistEntity,
} from './matching.js';

/** Default UA when the admin leaves the field blank (one is still always sent). */
const DEFAULT_USER_AGENT = 'NicotinD/1.0 +https://github.com/kevinch3/nicotind';
const DEFAULT_CACHE_TTL_DAYS = 30;
/** An MBID-resolved ref is an exact identity match — high, but never a 1.0 shortcut. */
const MBID_MATCH_CONFIDENCE = 0.95;

const DISCLAIMER =
  'Discogs is a community-maintained music database. Its API Terms of Use ' +
  'require attribution and forbid bulk scraping; genres/styles are used to ' +
  'enrich your library metadata only. You register a free app at ' +
  'discogs.com/settings/developers and paste its Consumer Key + Secret.';

export interface DiscogsPluginConfig {
  consumerKey: string;
  consumerSecret: string;
  userAgent?: string;
  cacheTtlDays?: number;
  /** On-disk cache path (host-supplied; omitted → in-memory only). */
  cacheFile?: string;
}

/**
 * Resolve a release's MBID to a Discogs entity — the MBID-first path. Backed in
 * production by MusicBrainz's own `discogs` url-relation (that wiring lands with
 * the enrichment issue, gated by the #191 coverage spike); injected here so the
 * shell stays self-contained and the path is testable without MusicBrainz I/O.
 */
export type ResolveDiscogsRef = (mbid: {
  releaseGroup?: string;
  release?: string;
}) => Promise<DiscogsRef | null>;

/**
 * Resolve an artist's MBID to a Discogs entity — the MBID-first path, backed in
 * production by MusicBrainz's own `discogs` url-relation on the artist. Injected
 * so the plugin stays self-contained and testable without MusicBrainz I/O.
 */
export type ResolveDiscogsArtistRef = (mbid: string) => Promise<DiscogsRef | null>;

export interface DiscogsPluginDeps extends DiscogsClientDeps {
  resolveDiscogsRef?: ResolveDiscogsRef;
  resolveDiscogsArtistRef?: ResolveDiscogsArtistRef;
}

/**
 * Discogs metadata plugin — the shell: manifest, HTTP client (auth, cache,
 * 55/min rate limit), and the matching primitives, wired into a `genre`
 * capability. Hypothesised to beat MusicBrainz on Latin / regional / pre-2000 /
 * DJ-pool repertoire (the exact residual gap #187's release-group genres could
 * not close); the #191 spike decides whether it's worth wiring into the
 * windowed enrichment pipeline. Metadata only — there is no Discogs audio API.
 */
export class DiscogsPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: 'discogs',
    name: 'Discogs (metadata)',
    description:
      'Enrich release genres/styles from the Discogs database — strong on Latin, ' +
      'regional, pre-2000 and DJ-pool repertoire. Needs a free Consumer Key + Secret.',
    kind: 'metadata',
    capabilities: ['genre', 'artist-info'],
    requirements: { binaries: [] },
    configSchema: z
      .object({
        consumerKey: z.string().optional(),
        consumerSecret: z.string().optional(),
        userAgent: z.string().optional(),
        // The config form always sends every `text` field, including a blank
        // one (blank = "no override" for a string field). This is the only
        // numeric field among the plugin config schemas, so it's the only one
        // that needs the blank-string preprocess: `z.coerce.number()` turns
        // `''` into `0`, which then fails `.positive()` and throws — which
        // made `setConfig`'s atomic parse reject the *whole* payload,
        // including consumerKey/consumerSecret, on every save that left this
        // field blank.
        cacheTtlDays: z.preprocess(
          (val) => (val === '' ? undefined : val),
          z.coerce.number().int().positive().optional(),
        ),
      })
      .partial(),
    configFields: [
      {
        key: 'consumerKey',
        label: 'Consumer Key',
        type: 'text',
        placeholder: 'Discogs app Consumer Key',
        help: 'Register a free app at discogs.com/settings/developers, then paste its Consumer Key and Secret.',
      },
      {
        key: 'consumerSecret',
        label: 'Consumer Secret',
        type: 'password',
        placeholder: 'Discogs app Consumer Secret',
      },
      {
        key: 'userAgent',
        label: 'User-Agent (optional)',
        type: 'text',
        placeholder: DEFAULT_USER_AGENT,
        help: 'Discogs requires an identifying User-Agent on every request; a default is used if blank.',
      },
      {
        key: 'cacheTtlDays',
        label: 'Cache TTL (days)',
        type: 'text',
        placeholder: String(DEFAULT_CACHE_TTL_DAYS),
        help: 'How long to reuse a cached Discogs response before refetching.',
      },
    ],
    compliance: { disclaimer: DISCLAIMER, requiresConsent: true },
    defaultEnabled: false,
  };

  private cfg: DiscogsPluginConfig;
  private readonly deps: DiscogsPluginDeps;
  private client: DiscogsClient | null = null;

  constructor(config: DiscogsPluginConfig, deps: DiscogsPluginDeps = {}) {
    this.cfg = config;
    this.deps = deps;
    this.rebuildClient();
  }

  readonly genre: GenreCapability = {
    fetchGenres: (query) => this.fetchGenres(query),
  };

  readonly artistInfo: ArtistInfoCapability = {
    fetchArtistInfo: (query) => this.fetchArtistInfo(query),
  };

  async init(ctx: PluginHostContext): Promise<void> {
    this.cfg = { ...this.cfg, ...(ctx.config as Partial<DiscogsPluginConfig>) };
    this.rebuildClient();
  }

  async isAvailable(): Promise<boolean> {
    // Credentials-gated, like SpotifyPlugin — the card shows "Unavailable" until
    // both are entered. There is deliberately no local `enabled` term: for a
    // metadata plugin the registry's DB flag is the real enable gate (it's what
    // getEnabledWithCapability checks), and there is no `acquire.discogs.enabled`
    // YAML source that could ever set one true, so including it would leave the
    // plugin permanently unavailable.
    return Boolean(this.cfg.consumerKey) && Boolean(this.cfg.consumerSecret);
  }

  /** (Re)build the client whenever credentials change (enable, config save). */
  private rebuildClient(): void {
    if (!this.cfg.consumerKey || !this.cfg.consumerSecret) {
      this.client = null;
      return;
    }
    this.client = new DiscogsClient(
      {
        consumerKey: this.cfg.consumerKey,
        consumerSecret: this.cfg.consumerSecret,
        userAgent: this.cfg.userAgent || DEFAULT_USER_AGENT,
        cacheTtlDays: this.cfg.cacheTtlDays ?? DEFAULT_CACHE_TTL_DAYS,
        cacheFile: this.cfg.cacheFile,
      },
      this.deps,
    );
  }

  private async fetchGenres(query: GenreQuery): Promise<GenreResult | null> {
    const client = this.client;
    if (!client) return null;

    // 1. MBID-first: exact identity via MusicBrainz's discogs url-relation. No
    //    fuzzy step, so no same-name false pair.
    if (
      this.deps.resolveDiscogsRef &&
      query.mbid &&
      (query.mbid.release || query.mbid.releaseGroup)
    ) {
      const ref = await this.deps.resolveDiscogsRef(query.mbid);
      if (ref) {
        const genres = await this.genresForRef(client, ref);
        if (genres.length) return { genres, source: 'discogs', confidence: MBID_MATCH_CONFIDENCE };
      }
    }

    // 2. Name search: corroborated by artist AND album title (rejects the
    //    same-name-different-release false match).
    const hits = await client.search(buildSearchParams(query));
    const match = selectBestRelease(query, hits);
    if (!match) return null;
    const genres = await this.genresForRef(client, match.ref);
    if (!genres.length) return null;
    return { genres, source: 'discogs', confidence: match.confidence };
  }

  private async fetchArtistInfo(query: ArtistInfoQuery): Promise<ArtistInfoResult | null> {
    const client = this.client;
    if (!client || !this.deps.resolveDiscogsArtistRef || !query.mbid) return null;

    const ref = await this.deps.resolveDiscogsArtistRef(query.mbid);
    if (!ref || ref.kind !== 'artist') return null;

    const raw = await client.getArtist(ref.id);
    if (!raw) return null;
    const { bio, urls } = mapArtistInfo(raw as DiscogsArtistEntity);
    if (!bio && urls.length === 0) return null;
    return { bio, urls, source: 'discogs', confidence: MBID_MATCH_CONFIDENCE };
  }

  /** Fetch a ref's release/master and flatten genres + styles (general first). */
  private async genresForRef(client: DiscogsClient, ref: DiscogsRef): Promise<string[]> {
    const entity =
      ref.kind === 'master' ? await client.getMaster(ref.id) : await client.getRelease(ref.id);
    if (!entity) return [];
    const { genres, styles } = mapReleaseGenres(entity);
    const combined: string[] = [];
    const seen = new Set<string>();
    for (const g of [...genres, ...styles]) {
      const k = g.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      combined.push(g);
    }
    return combined;
  }
}
