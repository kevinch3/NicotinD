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
import type { AddonTransport, AddonCallOutcome } from './transport.js';

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

/**
 * The addon violated the protocol contract — a body that is too large, not
 * JSON, malformed, or the wrong shape. Distinct from `AddonRequestError`
 * (transport / HTTP status): a contract violation is the *addon's* fault and is
 * what the circuit-breaker (§4) counts, whereas a timeout/5xx is transient.
 */
export class AddonContractError extends Error {
  constructor(message: string) {
    super(`addon contract violation: ${message}`);
    this.name = 'AddonContractError';
  }
}

/**
 * Cap on a JSON response body core will buffer from an addon
 * (docs/superpowers/specs/2026-08-13-addon-ecosystem-security-contract-foundation-design.md
 * §1 Stream 1). File bytes are a separate, larger cap enforced at the ingest
 * path (Stream 3). 8 MiB is generous for any manage/observe JSON surface.
 */
export const MAX_ADDON_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Read an addon JSON response with a hard byte cap, aborting the stream past it
 * (a hostile or buggy addon must not be able to OOM core). Enforces the
 * content-length header first when present, then bounds the actual read
 * regardless (a lying or absent content-length cannot bypass it). An empty body
 * resolves to `undefined` so void endpoints (204 / empty 200) work; a non-JSON
 * or malformed non-empty body is a contract violation.
 */
async function readCappedJson(res: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AddonContractError(`response ${declared} bytes exceeds ${maxBytes} cap`);
  }

  const reader = res.body?.getReader();
  if (!reader) return undefined;

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new AddonContractError(`response exceeds ${maxBytes} byte cap`);
    }
    chunks.push(value);
  }

  if (total === 0) return undefined; // void endpoint

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new AddonContractError(`expected JSON, got content-type "${contentType || 'none'}"`);
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new AddonContractError('response body is not valid JSON');
  }
}

// `AddonCallOutcome` moved to ./transport.ts (shared by both transports);
// re-exported here so existing `from './client.js'` importers keep working.
export type { AddonCallOutcome } from './transport.js';

export interface AddonClientOptions {
  baseUrl: string;
  token: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Reports every JSON call's outcome (wire to the circuit-breaker). */
  onOutcome?: (outcome: AddonCallOutcome) => void;
}

/**
 * Typed HTTP client for the acquisition addon protocol v1
 * (docs/acquisition-addon-protocol.md). Only `manifest` and `health` are
 * unauthenticated; everything else sends the registration's bearer token.
 */
export class AddonClient implements AddonTransport {
  readonly baseUrl: string;
  private token: string;
  private fetchFn: typeof fetch;
  private timeoutMs: number;
  private onOutcome?: (outcome: AddonCallOutcome) => void;

  constructor(opts: AddonClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.onOutcome = opts.onOutcome;
  }

  /**
   * Wire (or rewire) the per-call outcome handler after construction — used to
   * bind the circuit-breaker once the addon id is known (register-time the id
   * comes from the fetched manifest, not the constructor).
   */
  bindOutcome(handler: (outcome: AddonCallOutcome) => void): void {
    this.onOutcome = handler;
  }

  async getManifest(): Promise<AddonManifest> {
    const body = await this.request('GET', '/addon/v1/manifest', { auth: false });
    const parsed = addonManifestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AddonContractError(`invalid manifest: ${parsed.error.message}`);
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
    try {
      const res = await this.rawRequest(method, path, opts);
      if (!res.ok) {
        throw new AddonRequestError(
          `addon responded ${res.status} for ${method} ${path}`,
          res.status,
        );
      }
      const parsed =
        res.status === 204 ? undefined : await readCappedJson(res, MAX_ADDON_RESPONSE_BYTES);
      this.onOutcome?.('ok');
      return parsed;
    } catch (err) {
      // A contract violation is the addon's fault (counts toward the breaker);
      // anything else (status, timeout, network) is transient/neutral.
      this.onOutcome?.(err instanceof AddonContractError ? 'contract-violation' : 'transient');
      throw err;
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
