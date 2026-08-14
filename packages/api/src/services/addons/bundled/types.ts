import type {
  AddonManifest,
  AddonJob,
  AddonJobRequest,
  AddonStatusRow,
  AddonHealth,
} from '@nicotind/core';

/**
 * The handler surface a bundled first-party addon implements — a resolve-shaped
 * subset of the protocol, called in-process by `LocalAddonTransport`. It shares
 * core's filesystem, so file delivery is a path handoff (`filePath`) rather than
 * an HTTP byte stream. Search/album/browse are intentionally absent: a bundled
 * addon that offers them would declare those capabilities and be reached the same
 * way, but the first bundled addon (archive) is resolve-only.
 */
export interface BundledAddon {
  readonly manifest: AddonManifest;
  createJob(req: AddonJobRequest, idempotencyKey?: string): Promise<AddonJob>;
  getJob(id: string): Promise<AddonJob>;
  listJobs(sinceMs?: number): Promise<AddonJob[]>;
  cancelJob(id: string): Promise<void>;
  deleteJob?(id: string): Promise<void>;
  /** Absolute local path to a ready item's file (in-process delivery). */
  filePath(jobId: string, itemId: string): Promise<string>;
  status?(): Promise<AddonStatusRow[]>;
  health?(): Promise<AddonHealth>;
}
