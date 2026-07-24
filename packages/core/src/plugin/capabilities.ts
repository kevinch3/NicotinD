import type {
  SearchProviderResult,
  NetworkPollResult,
  BrowseDirectory,
} from '../types/provider.js';

/**
 * Capability interfaces a plugin implements à la carte (it exposes exactly the
 * ones its manifest declares). The host orchestrators (unified search, album
 * hunt, URL acquire) depend on these interfaces — never on a concrete client —
 * which is what keeps acquisition decoupled and swappable.
 */

/**
 * Searchable source. Mirrors the legacy `ISearchProvider` shape so existing
 * providers satisfy it unchanged: local sources return `results` synchronously;
 * network sources return a `searchId` the caller polls via `pollResults`.
 */
export interface SearchCapability {
  search(query: string): Promise<{ results: SearchProviderResult | null; searchId?: string }>;
  pollResults?(searchId: string): Promise<NetworkPollResult>;
  cancelSearch?(searchId: string): Promise<void>;
  deleteSearch?(searchId: string): Promise<void>;
}

/** Browse a source's tree (slskd: a peer's shares). `sourceRef` is opaque. */
export interface BrowseCapability {
  browseUser(sourceRef: string): Promise<BrowseDirectory[]>;
}

/** A single file to pull from a known source. */
export interface DownloadFileRequest {
  filename: string;
  size: number;
}

/**
 * Pull selected files from a source into the host staging dir. `sourceRef` is
 * the opaque handle carried on search/browse results (slskd: the peer username).
 * Progress is emitted through the host context; completion is signalled by the
 * host's download watcher observing staged files (so this matches today's
 * fire-and-forget slskd enqueue semantics).
 */
export interface DownloadCapability {
  enqueue(sourceRef: string, files: DownloadFileRequest[]): Promise<void>;
}

/**
 * URL/URI-based acquisition (yt-dlp, spotdl). The plugin owns format/auth/rate
 * decisions; it stages files under the host-allocated dir for `jobId` and emits
 * progress via the host context. Resolves with the absolute paths of the audio
 * files it staged (the host then ingests them: organize → scan → enrich);
 * rejects on failure.
 */
/**
 * What a `resolve` hands back: the absolute paths of the files it staged, plus
 * the canonical artist/album the source already knows. Most sources embed
 * artist/album into the files themselves (yt-dlp/spotdl), so the host can file
 * them from tags — those may return a bare `string[]` (paths only). But some
 * sources stage files with **no embedded tags** (archive.org streams raw
 * bytes), so the organizer has nothing to file them by and drops them in the
 * unsorted bucket. `meta` lets such a plugin pass the artist/album it read from
 * the source's own metadata straight to the organizer (via jobMeta).
 */
export interface ResolveResult {
  paths: string[];
  meta?: { artist?: string | null; album?: string | null };
}

export interface ResolveCapability {
  /** Cheap, synchronous URL ownership test used to route an incoming URL. */
  canHandle(url: string): boolean;
  resolve(url: string, jobId: string): Promise<string[] | ResolveResult>;
  /** Best-effort cancel of an in-flight job. */
  cancel?(jobId: string): boolean;
}

/** What the host knows about a track when asking a source for lyrics. */
export interface LyricsQuery {
  title: string;
  artist: string;
  album?: string;
  /** Track duration in seconds — lets exact-match sources (LRCLIB) disambiguate. */
  durationSec?: number;
}

/** Lyrics a source returned for a query. `synced` is raw LRC ([mm:ss.xx] lines). */
export interface LyricsResult {
  plain: string | null;
  synced: string | null;
  /** Plugin id that produced this (e.g. 'lrclib'). */
  source: string;
}

/**
 * Metadata source that resolves lyrics for a track on demand. The host persists
 * the result (DB side-table + file tag) and protects user edits from re-fetches.
 */
export interface LyricsCapability {
  /** Returns lyrics for the query, or null when the source has none. */
  fetchLyrics(query: LyricsQuery): Promise<LyricsResult | null>;
}

/**
 * What the host knows about a **release** when asking a source for its genres.
 * Release-scoped by design: there is deliberately no artist-level genre query —
 * artist-level coverage measured ~4x worse than release-level (issue #187
 * finding 3), so not offering the option is safer than documenting "don't use
 * it". MBIDs are the only provider-specific ids carried; the matcher resolves
 * them to the source's own id internally, keeping the contract source-agnostic.
 */
export interface GenreQuery {
  artist: string;
  album: string;
  /** MusicBrainz ids for this release, when known (most-specific wins). */
  mbid?: { releaseGroup?: string; release?: string };
}

/** Genres a source resolved for a release. */
export interface GenreResult {
  /** Resolved genres/styles, most-general first, de-duplicated. */
  genres: string[];
  /** Plugin id that produced this (e.g. 'discogs'). */
  source: string;
  /**
   * Match confidence in [0, 1] — always a real, computed number. There is no
   * `1.0` "it came from a tag, trust it" shortcut here; that belongs to the tag
   * layer, not a network source that had to *match* a release first.
   */
  confidence: number;
}

/**
 * Metadata source that resolves genres for a release on demand (Discogs, …).
 * The host decides whether/how to persist the result (the enrichment wiring +
 * `library_genre_overrides` write path land in the per-capability issues, gated
 * by the #191 coverage spike); this contract is just "given a release, what
 * genres does the source have?".
 */
export interface GenreCapability {
  /** Returns genres for the release, or null when the source has no confident match. */
  fetchGenres(query: GenreQuery): Promise<GenreResult | null>;
}

/**
 * What the host knows about an artist when asking a source for a bio + links.
 * MBID-only, no name-search fallback — a wrong bio on a real person's page is
 * worse than a missing one (mirrors GenreQuery's release-scoped discipline).
 */
export interface ArtistInfoQuery {
  mbid: string;
}

/** Bio + external links a source resolved for an artist. */
export interface ArtistInfoResult {
  bio: string | null;
  /** External links (Wikipedia, official site, …), de-duplicated. */
  urls: string[];
  /** Plugin id that produced this (e.g. 'discogs'). */
  source: string;
  /** Match confidence in [0, 1] — always a real, computed number, never a 1.0 shortcut. */
  confidence: number;
}

/** Metadata source that resolves an artist bio + links on demand (Discogs, …). */
export interface ArtistInfoCapability {
  /** Returns bio/links for the artist, or null when the source has no confident match. */
  fetchArtistInfo(query: ArtistInfoQuery): Promise<ArtistInfoResult | null>;
}

/** Connectivity plugins (tailscale/wireguard) — scaffold; none shipped yet. */
export interface ConnectivityCapability {
  up(): Promise<void>;
  down(): Promise<void>;
  status(): Promise<{ connected: boolean; detail?: string }>;
}
