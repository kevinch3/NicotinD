import {
  addonManifestSchema,
  type AddonHealth,
  type AddonManifest,
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

  private async request(
    method: string,
    path: string,
    opts: { auth: boolean; json?: unknown },
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (opts.auth) headers['Authorization'] = `Bearer ${this.token}`;
    if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AddonRequestError(
        `addon unreachable at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
}
