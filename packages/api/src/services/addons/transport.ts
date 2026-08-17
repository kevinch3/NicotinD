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
  albumsSearch(req: AddonAlbumSearchRequest): Promise<AddonAlbumSearchResponse>;
  browse(user: string): Promise<{ directories: unknown[] }>;
  createJob(req: AddonJobRequest, idempotencyKey?: string): Promise<AddonJob>;
  listJobs(sinceMs?: number): Promise<AddonJob[]>;
  getJob(id: string): Promise<AddonJob>;
  cancelJob(id: string): Promise<void>;
  deleteJob(id: string): Promise<void>;
  notifyLibraryChanged(): Promise<void>;
  /** Deliver a ready file's bytes. HTTP streams them; local wraps `Bun.file`. */
  fetchFile(jobId: string, itemId: string): Promise<Response>;
}
