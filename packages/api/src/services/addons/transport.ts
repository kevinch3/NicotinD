import type {
  AddonManifest,
  AddonHealth,
  AddonStatusRow,
  AddonSearchRequest,
  AddonSearchResponse,
  AddonAlbumSearchRequest,
  AddonAlbumSearchResponse,
  AddonJobRequest,
  AddonJob,
} from '@nicotind/core';

/** Which path asked for a hunt — the field `docker logs | jq` groups by (#1626). */
export type HuntLane =
  | 'hunt'
  | 'hunt-base'
  | 'hunt-queue'
  | 'get'
  | 'hunt-skew'
  | 'resource'
  | 'resource-auto'
  | 'hunt-download'
  | 'retry'
  | 'watchlist'
  | 'auto-acquire'
  | 'complete-album'
  | 'track-get';

export interface HuntTrace {
  attemptId?: string;
  lane?: HuntLane;
  /** Lidarr album id, when the caller has one. */
  albumId?: number;
  /** How long the hunt waited in core's queue before it ran. */
  queuedMs?: number;
}

/**
 * One clean/failed classification of an addon call for the circuit breaker.
 * Owned here (not in client.ts) so the transport interface and its two
 * implementations can share it without a client↔transport import cycle.
 */
export type AddonCallOutcome = 'ok' | 'contract-violation' | 'transient';

/**
 * The addon transport seam. `HttpAddonTransport` (the `AddonClient` class) speaks
 * the protocol over HTTP to an external addon; `LocalAddonTransport` calls a
 * bundled first-party addon in-process. Every host-side consumer (the job poller,
 * search provider, `RemoteAddonPlugin`, the manager) depends on this interface,
 * not the concrete HTTP class, so a bundled addon flows through the exact same
 * lanes as an external one.
 */
export interface AddonTransport {
  /** Identifies the transport target (an origin URL for HTTP; `local:<id>` for bundled). */
  readonly baseUrl: string;
  /** Register the circuit-breaker sink; each call reports its outcome once. */
  bindOutcome(handler: (outcome: AddonCallOutcome) => void): void;
  getManifest(): Promise<AddonManifest>;
  getHealth(): Promise<AddonHealth>;
  getStatus(): Promise<AddonStatusRow[]>;
  putConfig(config: Record<string, unknown>): Promise<void>;
  search(req: AddonSearchRequest): Promise<AddonSearchResponse>;
  albumsSearch(
    req: AddonAlbumSearchRequest,
    opts?: { timeoutMs?: number } & HuntTrace,
  ): Promise<AddonAlbumSearchResponse>;
  browse(user: string): Promise<{ directories: unknown[] }>;
  createJob(req: AddonJobRequest, idempotencyKey?: string, trace?: HuntTrace): Promise<AddonJob>;
  listJobs(sinceMs?: number): Promise<AddonJob[]>;
  getJob(id: string): Promise<AddonJob>;
  cancelJob(id: string): Promise<void>;
  deleteJob(id: string): Promise<void>;
  notifyLibraryChanged(): Promise<void>;
  /** Deliver a ready file's bytes. HTTP streams them; local wraps `Bun.file`. */
  fetchFile(jobId: string, itemId: string): Promise<Response>;
}
