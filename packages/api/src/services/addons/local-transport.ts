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
import type { AddonTransport, AddonCallOutcome } from './transport.js';
import { AddonContractError } from './client.js';
import type { BundledAddon } from './bundled/types.js';

/**
 * In-process `AddonTransport` for a bundled first-party addon (Approach A of the
 * resolve-addons design). No HTTP, no separate process: every call delegates
 * directly to the `BundledAddon`, so it flows through the exact same host lanes
 * (job poller, feed, `RemoteAddonPlugin`) as an external addon. Because there is
 * no network, every successful call reports `'ok'` to the circuit breaker (which
 * therefore never trips a bundled addon). `fetchFile` hands the poller the file
 * as a `Response` wrapping the local path — no byte round-trip.
 */
export class LocalAddonTransport implements AddonTransport {
  readonly baseUrl: string;
  private onOutcome?: (outcome: AddonCallOutcome) => void;

  constructor(private readonly addon: BundledAddon) {
    this.baseUrl = `local:${addon.manifest.id}`;
  }

  bindOutcome(handler: (outcome: AddonCallOutcome) => void): void {
    this.onOutcome = handler;
  }

  private async ok<T>(p: Promise<T>): Promise<T> {
    const v = await p;
    this.onOutcome?.('ok');
    return v;
  }

  async getManifest(): Promise<AddonManifest> {
    return this.addon.manifest;
  }

  async getHealth(): Promise<AddonHealth> {
    return this.addon.health ? this.addon.health() : { ok: true, ready: true };
  }

  async getStatus(): Promise<AddonStatusRow[]> {
    return this.addon.status ? this.addon.status() : [];
  }

  async putConfig(_config: Record<string, unknown>): Promise<void> {
    // Bundled addons take no runtime config push (they read core's config directly).
  }

  async search(_req: AddonSearchRequest): Promise<AddonSearchResponse> {
    throw new AddonContractError(`bundled addon ${this.addon.manifest.id} does not support search`);
  }

  async albumsSearch(_req: AddonAlbumSearchRequest): Promise<AddonAlbumSearchResponse> {
    throw new AddonContractError(
      `bundled addon ${this.addon.manifest.id} does not support albums/search`,
    );
  }

  async browse(_user: string): Promise<{ directories: unknown[] }> {
    throw new AddonContractError(`bundled addon ${this.addon.manifest.id} does not support browse`);
  }

  async createJob(req: AddonJobRequest, idempotencyKey?: string): Promise<AddonJob> {
    return this.ok(this.addon.createJob(req, idempotencyKey));
  }

  async listJobs(sinceMs?: number): Promise<AddonJob[]> {
    return this.ok(this.addon.listJobs(sinceMs));
  }

  async getJob(id: string): Promise<AddonJob> {
    return this.ok(this.addon.getJob(id));
  }

  async cancelJob(id: string): Promise<void> {
    return this.ok(this.addon.cancelJob(id));
  }

  async deleteJob(id: string): Promise<void> {
    return this.addon.deleteJob ? this.addon.deleteJob(id) : this.addon.cancelJob(id);
  }

  async notifyLibraryChanged(): Promise<void> {
    // Bundled resolve addons don't share the library back out to a network.
  }

  async fetchFile(jobId: string, itemId: string): Promise<Response> {
    const path = await this.addon.filePath(jobId, itemId);
    return new Response(Bun.file(path));
  }
}
