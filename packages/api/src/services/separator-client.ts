import { createLogger } from '@nicotind/core';

const log = createLogger('separator-client');

/**
 * HTTP client for the vocal-separation sidecar (packages/separator, issue #603)
 * — the `AudioFeaturesClient` shape: a TTL-cached, shared-in-flight health probe
 * with a synchronous snapshot, and one call whose failures are split by kind.
 *
 * Two error classes, because the caller must remember them differently:
 *   - `SeparationRejectedError` (sidecar 422): a verdict on the FILE —
 *     undecodable, too short, too long. Deterministic; sticky until the file's
 *     identity changes.
 *   - `SeparationUnavailableError` (503, timeout, transport, wrong body): the
 *     ENVIRONMENT. Transient; also poisons the cached health so the next
 *     status poll reports `unhealthy` instead of enqueueing doomed jobs.
 */
const HEALTH_TTL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;

/** Structural fetch, so a test double need not carry Bun's `fetch.preconnect`. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class SeparationRejectedError extends Error {
  readonly status = 422;
  constructor(detail: string) {
    super(detail);
    this.name = 'SeparationRejectedError';
  }
}

export class SeparationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeparationUnavailableError';
  }
}

export class SeparatorClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly healthTtlMs: number;
  private lastHealthAt = 0;
  private lastHealthy = false;
  private healthProbe: Promise<boolean> | null = null;

  constructor(opts: { baseUrl: string; fetchFn?: FetchLike; healthTtlMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchFn = opts.fetchFn ?? fetch;
    this.healthTtlMs = opts.healthTtlMs ?? HEALTH_TTL_MS;
  }

  /** Last-known health, synchronously; a stale value kicks a background refresh. */
  healthySnapshot(): boolean {
    if (Date.now() - this.lastHealthAt >= this.healthTtlMs) void this.healthy();
    return this.lastHealthy;
  }

  /**
   * `status: 'ok'` — which includes the idle-released (cold, `loaded: false`)
   * state, so this gate never blocks the /separate that would rewarm the
   * worker. Concurrent callers share one in-flight probe.
   */
  async healthy(): Promise<boolean> {
    if (this.healthProbe) return this.healthProbe;
    if (Date.now() - this.lastHealthAt < this.healthTtlMs) return this.lastHealthy;
    this.healthProbe = this.probeHealth().finally(() => {
      this.healthProbe = null;
    });
    return this.healthProbe;
  }

  private async probeHealth(): Promise<boolean> {
    let healthy = false;
    try {
      const res = await this.fetchFn(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        healthy = body.status === 'ok';
      }
    } catch {
      healthy = false;
    }
    this.lastHealthy = healthy;
    this.lastHealthAt = Date.now();
    return healthy;
  }

  private poison(): void {
    this.lastHealthy = false;
    this.lastHealthAt = Date.now();
  }

  /**
   * Separate one track by library-relative path. Resolves to the sidecar's
   * `audio/flac` response (the instrumental) for the caller to stream to disk.
   */
  async separate(relPath: string, opts: { timeoutMs: number }): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/separate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      this.poison();
      log.warn({ err, relPath }, 'separate request failed');
      throw new SeparationUnavailableError(`separator unreachable: ${String(err)}`);
    }
    if (res.status === 422) {
      let detail = 'separator rejected file';
      try {
        const body = (await res.json()) as { detail?: string };
        if (body.detail) detail = body.detail;
      } catch {
        /* keep the generic message */
      }
      throw new SeparationRejectedError(detail);
    }
    if (!res.ok) {
      this.poison();
      throw new SeparationUnavailableError(`separator returned ${res.status}`);
    }
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('audio/flac')) {
      this.poison();
      throw new SeparationUnavailableError(`separator returned ${type || 'no'} content-type`);
    }
    return res;
  }
}
