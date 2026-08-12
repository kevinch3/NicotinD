import {
  addonManifestSchema,
  type AddonAlbumSearchRequest,
  type AddonAlbumSearchResponse,
  type AddonHealth,
  type AddonJob,
  type AddonJobRequest,
  type AddonManifest,
  type AddonSearchRequest,
  type AddonSearchResponse,
  type AddonStatusRow,
} from '@nicotind/core';

/** A failed request to an addon — carries the HTTP status when there was one. */
export class AddonRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AddonRequestError';
  }
}

export interface AddonClientOptions {
  baseUrl: string;
  token: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Typed HTTP client for the acquisition addon protocol v1
 * (docs/acquisition-addon-protocol.md). Only `manifest` and `health` are
 * unauthenticated; everything else sends the registration's bearer token.
 */
export class AddonClient {
  readonly baseUrl: string;
  private token: string;
  private fetchFn: typeof fetch;
  private timeoutMs: number;

  constructor(opts: AddonClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async getManifest(): Promise<AddonManifest> {
    const body = await this.request('GET', '/addon/v1/manifest', { auth: false });
    const parsed = addonManifestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AddonRequestError(`addon returned an invalid manifest: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  async getHealth(): Promise<AddonHealth> {
    const body = (await this.request('GET', '/addon/v1/health', { auth: false })) as AddonHealth;
    return { ok: body.ok === true, ready: body.ready === true, detail: body.detail };
  }

  async getStatus(): Promise<AddonStatusRow[]> {
    const body = await this.request('GET', '/addon/v1/status', { auth: true });
    return Array.isArray(body) ? (body as AddonStatusRow[]) : [];
  }

  async putConfig(config: Record<string, unknown>): Promise<void> {
    await this.request('PUT', '/addon/v1/config', { auth: true, json: config });
  }

  /* ————— Engine surface (phase 2 cutover) ————— */

  async search(req: AddonSearchRequest): Promise<AddonSearchResponse> {
    // The addon blocks for its own search round-trip; give the HTTP layer
    // headroom beyond the addon-side wait budget.
    const timeoutMs = (req.waitMs ?? 20_000) + 15_000;
    return (await this.request('POST', '/addon/v1/search', {
      auth: true,
      json: req,
      timeoutMs,
    })) as AddonSearchResponse;
  }

  async albumsSearch(req: AddonAlbumSearchRequest): Promise<AddonAlbumSearchResponse> {
    // A hunt (base + skew passes) legitimately takes minutes.
    return (await this.request('POST', '/addon/v1/albums/search', {
      auth: true,
      json: req,
      timeoutMs: 180_000,
    })) as AddonAlbumSearchResponse;
  }

  async createJob(req: AddonJobRequest, idempotencyKey?: string): Promise<AddonJob> {
    const body = (await this.request('POST', '/addon/v1/jobs', {
      auth: true,
      json: req,
      timeoutMs: 180_000,
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    })) as { job: AddonJob };
    return body.job;
  }

  async listJobs(sinceMs?: number): Promise<AddonJob[]> {
    const query = sinceMs ? `?since=${sinceMs}` : '';
    const body = (await this.request('GET', `/addon/v1/jobs${query}`, { auth: true })) as {
      jobs: AddonJob[];
    };
    return body.jobs;
  }

  async getJob(id: string): Promise<AddonJob> {
    const body = (await this.request('GET', `/addon/v1/jobs/${id}`, { auth: true })) as {
      job: AddonJob;
    };
    return body.job;
  }

  async cancelJob(id: string): Promise<void> {
    await this.request('POST', `/addon/v1/jobs/${id}/cancel`, { auth: true });
  }

  async deleteJob(id: string): Promise<void> {
    await this.request('DELETE', `/addon/v1/jobs/${id}`, { auth: true });
  }

  /** Raw Response so the caller streams the body straight to disk. */
  async fetchFile(jobId: string, itemId: string): Promise<Response> {
    const res = await this.rawRequest(
      'GET',
      `/addon/v1/jobs/${jobId}/files/${encodeURIComponent(itemId)}`,
      { auth: true, timeoutMs: 600_000 },
    );
    if (!res.ok) {
      throw new AddonRequestError(`addon responded ${res.status} fetching a file`, res.status);
    }
    return res;
  }

  async browse(user: string): Promise<{ directories: unknown[] }> {
    return (await this.request('GET', `/addon/v1/browse?user=${encodeURIComponent(user)}`, {
      auth: true,
      timeoutMs: 60_000,
    })) as { directories: unknown[] };
  }

  async notifyLibraryChanged(): Promise<void> {
    await this.request('POST', '/addon/v1/notify/library-changed', { auth: true });
  }

  private async request(
    method: string,
    path: string,
    opts: { auth: boolean; json?: unknown; timeoutMs?: number; headers?: Record<string, string> },
  ): Promise<unknown> {
    const res = await this.rawRequest(method, path, opts);
    if (!res.ok) {
      throw new AddonRequestError(
        `addon responded ${res.status} for ${method} ${path}`,
        res.status,
      );
    }
    if (res.status === 204) return undefined;
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }

  private async rawRequest(
    method: string,
    path: string,
    opts: { auth: boolean; json?: unknown; timeoutMs?: number; headers?: Record<string, string> },
  ): Promise<Response> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.auth) headers['Authorization'] = `Bearer ${this.token}`;
    if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      throw new AddonRequestError(
        `addon unreachable at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
