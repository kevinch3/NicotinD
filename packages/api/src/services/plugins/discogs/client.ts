import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createLogger } from '@nicotind/core';
import type { DiscogsSearchHit, DiscogsGenreEntity } from './matching.js';

const log = createLogger('discogs-client');

const DISCOGS_API = 'https://api.discogs.com';

/**
 * Requests per 60-second window. The Discogs cap with a consumer key + secret is
 * 60/min per source IP; we self-throttle to 55 (a 5-request margin) because
 * there is **no `Retry-After` guarantee on a 429** — the only safe strategy is
 * to stay under the cap, not to react after crossing it.
 */
const RATE_LIMIT_PER_MIN = 55;
const WINDOW_MS = 60_000;
const REFILL_PER_MS = RATE_LIMIT_PER_MIN / WINDOW_MS;
/**
 * Background requests keep this many tokens in reserve so an interactive fetch
 * (a "Detect genre" button) can still go when the bucket is nearly empty —
 * "interactive drains ahead of the next background refill", one shared bucket,
 * no second bucket.
 */
const INTERACTIVE_RESERVE = 3;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;

export type DiscogsPriority = 'background' | 'interactive';

export interface DiscogsClientConfig {
  consumerKey: string;
  consumerSecret: string;
  /** Required on every request — an empty UA gets silently-empty responses. */
  userAgent: string;
  /** Cache entries older than this are ignored (and refreshed). */
  cacheTtlDays: number;
  /** On-disk JSON cache path. Omit for an in-memory-only cache (tests). */
  cacheFile?: string;
}

/** Injected so tests need no network, no real delays, and no wall clock. */
export interface DiscogsClientDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface CacheEntry {
  at: number;
  value: unknown;
}

/**
 * Discogs HTTP client — auth, User-Agent, on-disk cache, and a shared token-
 * bucket rate limiter. Metadata only (there is no Discogs audio API). Every
 * external contract here comes from the Discogs API docs:
 *
 * - **User-Agent on every request** (not just an init call) — injected in the
 *   headers below; an empty UA returns silently-empty responses.
 * - **Auth via `Authorization: Discogs key=…, secret=…`** — a shared app
 *   credential (60/min, image rights), not a per-user token.
 * - **Rate limit is per source IP, 60s moving window, no `Retry-After` on 429** —
 *   hence self-throttling under the cap + honouring
 *   `X-Discogs-Ratelimit-Remaining` on every response.
 * - **Documented 5xx on ordinary queries** ("Query time exceeded") — treated as
 *   transient (retry with backoff), then a `null` the caller ledgers as a miss.
 */
export class DiscogsClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ttlMs: number;

  private cache = new Map<string, CacheEntry>();
  private tokens = RATE_LIMIT_PER_MIN;
  private lastRefill: number;

  constructor(
    private cfg: DiscogsClientConfig,
    deps: DiscogsClientDeps = {},
  ) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ttlMs = Math.max(0, cfg.cacheTtlDays) * 24 * 60 * 60 * 1000;
    this.lastRefill = this.now();
    if (cfg.cacheFile && existsSync(cfg.cacheFile)) {
      try {
        const raw = JSON.parse(readFileSync(cfg.cacheFile, 'utf-8')) as Record<string, CacheEntry>;
        for (const [k, v] of Object.entries(raw)) this.cache.set(k, v);
      } catch {
        log.warn({ cacheFile: cfg.cacheFile }, 'failed to parse Discogs cache; starting fresh');
      }
    }
  }

  /** Search releases by artist + title (name-search fallback path). */
  async search(
    params: Record<string, string>,
    priority: DiscogsPriority = 'background',
  ): Promise<DiscogsSearchHit[]> {
    const qs = new URLSearchParams(params).toString();
    const data = await this.request<{ results?: DiscogsSearchHit[] }>(
      `/database/search?${qs}`,
      priority,
    );
    return data?.results ?? [];
  }

  /** Fetch a release by id (its `genres` + `styles`). */
  getRelease(
    id: number,
    priority: DiscogsPriority = 'background',
  ): Promise<DiscogsGenreEntity | null> {
    return this.request<DiscogsGenreEntity>(`/releases/${id}`, priority);
  }

  /** Fetch a master (edition group) by id (its `genres` + `styles`). */
  getMaster(
    id: number,
    priority: DiscogsPriority = 'background',
  ): Promise<DiscogsGenreEntity | null> {
    return this.request<DiscogsGenreEntity>(`/masters/${id}`, priority);
  }

  /** Fetch an artist by id. */
  getArtist(
    id: number,
    priority: DiscogsPriority = 'background',
  ): Promise<Record<string, unknown> | null> {
    return this.request<Record<string, unknown>>(`/artists/${id}`, priority);
  }

  /**
   * GET a Discogs path. Serves a fresh cache hit without a request; otherwise
   * throttles, fetches, and retries transient failures (429 / 5xx) with backoff.
   * Returns null on an authoritative 404, an other non-OK, or exhausted retries
   * (the caller ledgers that as a persistent miss). Successful payloads are
   * cached (on disk when a cacheFile is configured).
   */
  private async request<T>(path: string, priority: DiscogsPriority): Promise<T | null> {
    const cached = this.readCache<T>(path);
    if (cached !== undefined) return cached;

    let lastStatus = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.throttle(priority);
      const res = await this.fetchFn(`${DISCOGS_API}${path}`, { headers: this.headers() });
      this.honorRateLimitHeader(res);
      lastStatus = res.status;

      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(BASE_BACKOFF_MS * attempt);
          continue;
        }
        log.debug({ path, status: res.status }, 'Discogs transient failure exhausted retries');
        return null;
      }
      if (!res.ok) {
        log.debug({ path, status: res.status }, 'Discogs request failed');
        return null;
      }
      const json = (await res.json()) as T;
      this.writeCache(path, json);
      return json;
    }
    log.debug({ path, status: lastStatus }, 'Discogs request gave up');
    return null;
  }

  private headers(): Record<string, string> {
    return {
      // User-Agent MUST be present on every request (empty UA → empty responses).
      'User-Agent': this.cfg.userAgent,
      Authorization: `Discogs key=${this.cfg.consumerKey}, secret=${this.cfg.consumerSecret}`,
      Accept: 'application/json',
    };
  }

  /** Align our bucket with the server's own count so we never overrun it. */
  private honorRateLimitHeader(res: { headers?: { get(name: string): string | null } }): void {
    const raw = res.headers?.get('X-Discogs-Ratelimit-Remaining');
    if (raw == null) return;
    const remaining = Number(raw);
    if (Number.isFinite(remaining)) this.tokens = Math.min(this.tokens, remaining);
  }

  /**
   * Token-bucket throttle. Refills continuously at 55/min; a background request
   * needs a full token *plus* the interactive reserve, while an interactive one
   * only needs a full token — so when the bucket is nearly empty the interactive
   * request goes and the background one waits.
   */
  private async throttle(priority: DiscogsPriority): Promise<void> {
    this.refill();
    const floor = priority === 'interactive' ? 1 : 1 + INTERACTIVE_RESERVE;
    if (this.tokens < floor) {
      const deficit = floor - this.tokens;
      await this.sleep(Math.ceil(deficit / REFILL_PER_MS));
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(RATE_LIMIT_PER_MIN, this.tokens + elapsed * REFILL_PER_MS);
      this.lastRefill = now;
    }
  }

  private readCache<T>(path: string): T | null | undefined {
    const entry = this.cache.get(path);
    if (!entry) return undefined;
    if (this.ttlMs > 0 && this.now() - entry.at > this.ttlMs) {
      this.cache.delete(path);
      return undefined;
    }
    return entry.value as T;
  }

  private writeCache(path: string, value: unknown): void {
    this.cache.set(path, { at: this.now(), value });
    if (!this.cfg.cacheFile) return;
    try {
      const obj: Record<string, CacheEntry> = {};
      for (const [k, v] of this.cache) obj[k] = v;
      writeFileSync(this.cfg.cacheFile, JSON.stringify(obj), 'utf-8');
    } catch (err) {
      log.warn({ err }, 'failed to persist Discogs cache');
    }
  }
}
