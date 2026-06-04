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
export interface ResolveCapability {
  /** Cheap, synchronous URL ownership test used to route an incoming URL. */
  canHandle(url: string): boolean;
  resolve(url: string, jobId: string): Promise<string[]>;
  /** Best-effort cancel of an in-flight job. */
  cancel?(jobId: string): boolean;
}

/** Connectivity plugins (tailscale/wireguard) — scaffold; none shipped yet. */
export interface ConnectivityCapability {
  up(): Promise<void>;
  down(): Promise<void>;
  status(): Promise<{ connected: boolean; detail?: string }>;
}
