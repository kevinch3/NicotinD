import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createLogger } from '@nicotind/core';

/** One POST batches every pending MBID, so allow more than a point lookup. */
const LISTENBRAINZ_TIMEOUT_MS = 20_000;

const log = createLogger('listenbrainz-client');

/** ListenBrainz asks for an identifying User-Agent, same as MusicBrainz. */
export const LB_USER_AGENT = 'NicotinD (+https://github.com/kevinch3/nicotind)';

const LB_BASE = 'https://api.listenbrainz.org';
// ListenBrainz publishes X-RateLimit headers; 1 req/s is comfortably under any
// documented cap and matches how we treat MusicBrainz.
const MIN_INTERVAL_MS = 1000;
// The /popularity/recording endpoint accepts a batch of MBIDs per POST; keep it
// bounded so one call can't build an enormous body.
const MAX_BATCH = 100;

type FetchFn = typeof fetch;

export interface ListenBrainzClientOptions {
  /** On-disk cache path. Omit for an in-memory-only client (tests). */
  cacheFile?: string;
  userAgent?: string;
  /** Injected for tests — defaults to global `fetch`. */
  fetchFn?: FetchFn;
  /** Injected clock for the rate limiter (tests). */
  now?: () => number;
  /** Injected sleep for the rate limiter / backoff (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Override the API base (tests). */
  baseUrl?: string;
}

/**
 * Minimal ListenBrainz client for the extrinsic **popularity** signal (issue
 * #220). ListenBrainz aggregates global listen counts keyed on the MusicBrainz
 * **recording** MBID, needs no credentials, and is MBID-native — the right fit
 * for our plugin-less enrichment model.
 *
 * The only call we make is `/1/popularity/recording`, batched. Results are
 * content-addressed by MBID and cached on disk (a recording's aggregate listen
 * count barely moves day to day, so re-fetching every window would be waste).
 */
export class ListenBrainzClient {
  // recordingMbid -> total listen count, or null = LB confirmed it has no data.
  private cache = new Map<string, number | null>();
  private lastCallAt = 0;
  private readonly cacheFile?: string;
  private readonly userAgent: string;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly base: string;

  constructor(opts: ListenBrainzClientOptions = {}) {
    this.cacheFile = opts.cacheFile;
    this.userAgent = opts.userAgent ?? LB_USER_AGENT;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.base = opts.baseUrl ?? LB_BASE;
    if (this.cacheFile && existsSync(this.cacheFile)) {
      try {
        const raw = JSON.parse(readFileSync(this.cacheFile, 'utf-8')) as Record<
          string,
          number | null
        >;
        for (const [k, v] of Object.entries(raw)) this.cache.set(k, v);
        log.debug({ entries: this.cache.size }, 'LB cache loaded');
      } catch {
        log.warn({ cacheFile: this.cacheFile }, 'failed to parse LB cache; starting fresh');
      }
    }
  }

  /**
   * Total listen counts for a set of recording MBIDs, batched and cached.
   * Returns a map keyed by the MBIDs it could resolve. A value of `null` means
   * ListenBrainz confirmed it has no listen data for that recording; an MBID
   * **absent** from the map means the request for it failed transiently (429 /
   * network) and should be retried later — the two are deliberately distinct so
   * the caller ledgers a confirmed miss but leaves a transient one to retry.
   */
  async getListenCounts(recordingMbids: string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    const uncached: string[] = [];
    for (const m of recordingMbids) {
      if (this.cache.has(m)) out.set(m, this.cache.get(m) ?? null);
      else if (!uncached.includes(m)) uncached.push(m);
    }
    let wrote = false;
    for (let i = 0; i < uncached.length; i += MAX_BATCH) {
      const batch = uncached.slice(i, i + MAX_BATCH);
      const counts = await this.fetchBatch(batch);
      for (const [m, v] of counts) {
        out.set(m, v);
        this.cache.set(m, v);
        wrote = true;
      }
    }
    if (wrote) this.flushCache();
    return out;
  }

  private async fetchBatch(mbids: string[]): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    await this.rateLimit();
    try {
      const res = await this.fetchFn(`${this.base}/1/popularity/recording`, {
        // Created here, after `await this.rateLimit()` above — hoisting it would
        // spend the budget waiting for our own limiter.
        signal: AbortSignal.timeout(LISTENBRAINZ_TIMEOUT_MS),
        method: 'POST',
        headers: {
          'User-Agent': this.userAgent,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ recording_mbids: mbids }),
      });
      if (res.status === 429 || res.status === 503) {
        log.warn({ status: res.status }, 'ListenBrainz throttled — backing off 5s');
        await this.sleepFn(5000);
        return result; // leave uncached so a later pass retries
      }
      if (!res.ok) {
        // Warn, not debug: a 4xx here is our bug, not noise. A 400 on one invalid
        // recording id rejects the whole batch, and at debug level that stalled
        // popularity for months with nothing in the log to show it (issue #851).
        log.warn(
          { status: res.status, body: (await res.text().catch(() => '')).slice(0, 200) },
          'ListenBrainz rejected the batch',
        );
        return result;
      }
      const data = (await res.json()) as Array<{
        recording_mbid: string;
        total_listen_count: number | null;
      }>;
      for (const row of data ?? []) {
        if (row?.recording_mbid) result.set(row.recording_mbid, row.total_listen_count ?? null);
      }
      return result;
    } catch (err) {
      log.warn({ err }, 'ListenBrainz fetch failed');
      return result;
    }
  }

  private async rateLimit(): Promise<void> {
    const elapsed = this.now() - this.lastCallAt;
    if (elapsed < MIN_INTERVAL_MS) await this.sleepFn(MIN_INTERVAL_MS - elapsed);
    this.lastCallAt = this.now();
  }

  private flushCache(): void {
    if (!this.cacheFile) return;
    try {
      const obj: Record<string, number | null> = {};
      for (const [k, v] of this.cache) obj[k] = v;
      writeFileSync(this.cacheFile, JSON.stringify(obj), 'utf-8');
    } catch (err) {
      log.warn({ err }, 'failed to persist LB cache');
    }
  }
}

/**
 * A recording with ~this many total listens reads as popularity ~1.0. A
 * documented, tunable constant — NOT a measured universal — chosen so the log
 * scale below spreads a real library across the 0–1 range rather than pinning
 * everything near 0. See docs/popularity.md "Normalization".
 */
export const POPULARITY_REFERENCE = 1_000_000;

/**
 * Map a raw ListenBrainz total-listen-count to a 0–1 popularity scalar on a log
 * scale: the listen distribution is heavily long-tailed, so a linear map would
 * collapse the obscure majority to ~0 and let a handful of mega-hits own the
 * whole range. Returns 0 for a zero/negative/NaN count (an obscure but real
 * recording), and clamps at 1.
 */
export function normalizePopularity(listenCount: number): number {
  if (!Number.isFinite(listenCount) || listenCount <= 0) return 0;
  return Math.min(1, Math.log10(listenCount + 1) / Math.log10(POPULARITY_REFERENCE));
}
