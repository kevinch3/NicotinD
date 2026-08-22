import { createLogger, type Logger } from '@nicotind/core';

export interface LidarrClientOptions {
  baseUrl: string;
  apiKey: string;
  /**
   * Injected so a timeout can be exercised without real timers. Every other
   * house client (AddonClient, AudioFeaturesClient, DiscogsClient, LrclibClient)
   * already takes one; this was the odd one out, which is why the missing
   * timeout stayed untested rather than merely unnoticed.
   */
  fetchFn?: typeof fetch;
}

/**
 * Per-call timeout budgets, tiered by what Lidarr actually does with the request.
 *
 * There was none at all. `request<T>()` is the single path behind 13 methods and
 * 43 non-test call sites, and a hung Lidarr held every one of them open forever
 * — including the watchlist and auto-acquire pollers. The mitigation had been
 * applied at the wrong layer: `Bun.serve`'s `idleTimeout` was raised 10s -> 60s
 * (src/main.ts) BECAUSE interactive routes making a Lidarr round-trip were being
 * aborted. That turned a hang into a slower hang.
 *
 * A single flat value is wrong here: 21 of those 43 call sites already swallow
 * failures into `[]`/`null`, so a budget that is too tight degrades SILENTLY
 * rather than erroring. Hence three tiers, each justified by the endpoint.
 */

/** Lidarr answers these from its own SQLite, over the Docker-internal network. */
export const TIMEOUT_LOCAL_MS = 10_000;

/**
 * The two `lookup` endpoints proxy to Lidarr's upstream metadata server, so they
 * are genuinely slower. Capped at 20s rather than 30 because both sit on GET
 * routes the web interceptor aborts at 30s (auth.interceptor.ts) — a 30s server
 * budget could never fire first, which would make it decorative.
 */
export const TIMEOUT_LOOKUP_MS = 20_000;

/**
 * `POST /api/v1/artist` synchronously imports the artist's entire discography
 * from Lidarr's upstream metadata server before responding. It is the one call
 * that legitimately needs longer than a lookup.
 */
export const TIMEOUT_PROVISION_MS = 60_000;

export class LidarrClient {
  private baseUrl: string;
  private apiKey: string;
  private log: Logger;
  private fetchFn?: typeof fetch;

  constructor(options: LidarrClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    // Stored WITHOUT a `?? fetch` default: resolving the global here would
    // capture it at construction, which defeats the `globalThis.fetch` stubbing
    // the existing api tests rely on (and is a footgun in its own right). It is
    // resolved per call instead.
    this.fetchFn = options.fetchFn;
    this.log = createLogger('lidarr-client');
  }

  /**
   * @param timeoutMs defaults to the local-query budget; callers hitting a
   *   metadata-proxy or provisioning endpoint pass their own.
   */
  async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs: number = TIMEOUT_LOCAL_MS,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await (this.fetchFn ?? fetch)(url, {
        ...init,
        // An explicit caller signal wins — this is a default, not a ceiling.
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
        headers: {
          'X-Api-Key': this.apiKey,
          'Content-Type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      // Say "timed out" rather than letting a bare TimeoutError surface. Many
      // callers swallow this into `[]`/`null`, so the log line is the only place
      // the distinction between "Lidarr said no" and "Lidarr never answered"
      // survives.
      if (err instanceof Error && err.name === 'TimeoutError') {
        this.log.warn({ url, timeoutMs }, 'Lidarr request timed out');
        throw new Error(`Lidarr request timed out after ${timeoutMs}ms: ${path}`);
      }
      throw err;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.log.warn({ url, status: res.status, body }, 'Lidarr request failed');
      throw new Error(`Lidarr request failed: ${res.status} ${path}`);
    }

    return res.json() as Promise<T>;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/ping`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
