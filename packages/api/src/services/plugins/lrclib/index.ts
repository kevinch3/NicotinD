import type {
  Plugin,
  PluginManifest,
  PluginHostContext,
  LyricsCapability,
  LyricsQuery,
  LyricsResult,
} from '@nicotind/core';
import { LYRICS_DURATION_TOLERANCE_SEC } from '@nicotind/core';

export interface LrclibPluginConfig {
  enabled: boolean;
}

/** Injected so tests run without network and without mocking node builtins. */
export interface LrclibPluginDeps {
  fetchFn?: typeof fetch;
  /** Base retry backoff (ms). Overridable so tests don't wait on real delays. */
  retryBackoffMs?: number;
}

/** One track record as returned by LRCLIB's /get and /search endpoints. */
interface LrclibTrack {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

const API_BASE = 'https://lrclib.net/api';
// LRCLIB asks clients to identify themselves; see https://lrclib.net/docs.
const USER_AGENT = 'NicotinD (https://github.com/nicotind)';
const REQUEST_TIMEOUT_MS = 8000;
// Transient failures (rate-limit / 5xx / network / timeout) are retried a couple
// of times with a short backoff. Without this, a cold first request that gets
// throttled or times out surfaced as a false "no lyrics found", and the user had
// to click "Fetch lyrics" 2-3 times before a warm request succeeded.
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 400;

/**
 * How far a /search hit's duration may sit from the local file's before it is
 * rejected outright (issue #1212). Shared with the health report so the gate
 * and the detector cannot drift — see `LYRICS_DURATION_TOLERANCE_SEC`.
 *
 * `/get` already matches within ±2s, so the fallback must be looser than that
 * or it could never rescue anything /get missed. But it stays much tighter than
 * the gap that caused the bug: wrong lyrics are worse than no lyrics, because a
 * listener sees plausible-looking words with no way to tell they belong to
 * another take.
 */
const SEARCH_DURATION_TOLERANCE_SEC = LYRICS_DURATION_TOLERANCE_SEC;

/** A /search pick, and whether it was ranked within the duration tolerance. */
interface SearchHit {
  result: LyricsResult;
  verified: boolean;
}

/** Map a LRCLIB record to a LyricsResult, treating empty strings as "none". */
function toResult(track: LrclibTrack): LyricsResult | null {
  const plain = track.plainLyrics?.trim() ? track.plainLyrics : null;
  const synced = track.syncedLyrics?.trim() ? track.syncedLyrics : null;
  if (!plain && !synced) return null;
  return {
    plain,
    synced,
    source: 'lrclib',
    ...(typeof track.duration === 'number' ? { matchedDurationSec: track.duration } : {}),
    ...(track.id !== undefined ? { sourceTrackId: String(track.id) } : {}),
  };
}

const unrankedHit = (result: LyricsResult): SearchHit => ({
  result: { ...result, matchedBy: 'search-unranked' },
  verified: false,
});

/**
 * Metadata plugin that resolves lyrics from LRCLIB (lrclib.net) — a free,
 * keyless, community lyrics database that returns both plain and synced (LRC)
 * lyrics. Pure JS (no binary), so it default-enables; the host persists what
 * `fetchLyrics` returns and protects user edits from re-fetches.
 */
export class LrclibPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: 'lrclib',
    name: 'LRCLIB',
    description: 'Fetch plain + synced (LRC) lyrics from LRCLIB — free, no API key.',
    kind: 'metadata',
    capabilities: ['lyrics'],
    requirements: { binaries: [] },
    compliance: {
      disclaimer:
        'LRCLIB is a community-contributed lyrics database. Lyrics may be ' +
        'copyrighted; you are responsible for complying with the law in your ' +
        'jurisdiction.',
      requiresConsent: false,
    },
    defaultEnabled: true,
  };

  private cfg: LrclibPluginConfig;
  private readonly fetchFn: typeof fetch;
  private readonly retryBackoffMs: number;

  constructor(config: LrclibPluginConfig = { enabled: true }, deps: LrclibPluginDeps = {}) {
    this.cfg = config;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.retryBackoffMs = deps.retryBackoffMs ?? RETRY_BACKOFF_MS;
  }

  readonly lyrics: LyricsCapability = {
    fetchLyrics: (query) => this.fetchLyrics(query),
  };

  async init(ctx: PluginHostContext): Promise<void> {
    this.cfg = { ...this.cfg, ...(ctx.config as Partial<LrclibPluginConfig>) };
  }

  async isAvailable(): Promise<boolean> {
    // No binary/credentials — the registry's enable/disable is the real gate.
    return this.cfg.enabled;
  }

  /**
   * Prefer the exact-match /get record — but only outright when it carries
   * timings (#1672). /get returns one record, and for many songs that record is
   * plain-only while /search holds a timed take of the same length, so the same
   * song came back timed or untimed depending on which endpoint answered. A /get
   * that throws no longer ends the fetch before /search is asked either.
   */
  private async fetchLyrics(query: LyricsQuery): Promise<LyricsResult | null> {
    let exact: LyricsResult | null = null;
    let getError: unknown = null;
    try {
      exact = await this.getExact(query);
    } catch (err) {
      getError = err;
    }
    if (exact?.synced) return exact;

    let searched: SearchHit | null;
    try {
      searched = await this.searchByQuery(query);
    } catch (err) {
      if (exact) return exact;
      throw getError ?? err;
    }
    // Only a hit ranked within the duration tolerance may displace an exact /get
    // record: an unranked one (no duration on either side) could be another take.
    if (searched?.verified && searched.result.synced) return searched.result;
    if (exact ?? searched) return exact ?? searched!.result;
    // /get failed and /search cleanly missed: /get might have had it, so this is
    // a source error (the UI offers a retry), not an authoritative "no lyrics".
    if (getError) throw getError;
    return null;
  }

  private async getExact(query: LyricsQuery): Promise<LyricsResult | null> {
    const params = new URLSearchParams({
      artist_name: query.artist,
      track_name: query.title,
    });
    if (query.album) params.set('album_name', query.album);
    if (query.durationSec && query.durationSec > 0) {
      params.set('duration', String(Math.round(query.durationSec)));
    }
    const track = await this.request<LrclibTrack>(`/get?${params.toString()}`);
    // 404 (no exact match) yields null — caller falls back to /search.
    const result = track ? toResult(track) : null;
    return result ? { ...result, matchedBy: 'exact' } : null;
  }

  /**
   * Fuzzy fallback for when /get's ±2s exact match finds nothing. LRCLIB ranks
   * by its own text relevance, which says nothing about whether a hit is the
   * same *recording* — "Luna tucumana" has dozens of takes, and taking hits[0]
   * stored another one's words and timings as though they were verified
   * (issue #1212). So rank by how close each hit's duration is to the local
   * file's and refuse anything beyond the tolerance.
   */
  private async searchByQuery(query: LyricsQuery): Promise<SearchHit | null> {
    const params = new URLSearchParams({
      artist_name: query.artist,
      track_name: query.title,
    });
    const hits = await this.request<LrclibTrack[]>(`/search?${params.toString()}`);
    if (!Array.isArray(hits)) return null;

    const candidates = hits
      .map((hit) => ({ hit, result: toResult(hit) }))
      .filter((c): c is { hit: LrclibTrack; result: LyricsResult } => c.result !== null);
    if (candidates.length === 0) return null;

    const target = query.durationSec;
    // No local duration means nothing to rank against. Returning the first hit
    // keeps the old behaviour rather than silently dropping lyrics — the result
    // still carries the source's duration, so the host records an unverified
    // match instead of one that merely looks checked.
    if (!target || target <= 0) return unrankedHit(candidates[0]!.result);

    const scored = candidates
      .filter((c) => typeof c.hit.duration === 'number')
      .map((c) => ({ ...c, delta: Math.abs(c.hit.duration! - target) }))
      .filter((c) => c.delta <= SEARCH_DURATION_TOLERANCE_SEC)
      // Every hit left is within tolerance, i.e. plausibly this recording, so a
      // timed one wins over a closer untimed one (#1672); closest duration next.
      .sort((a, b) => Number(!!b.result.synced) - Number(!!a.result.synced) || a.delta - b.delta);
    if (scored[0]) return { result: { ...scored[0].result, matchedBy: 'search' }, verified: true };

    // A hit that states no duration cannot be ranked or rejected on one. Dropping
    // it would lose real lyrics whenever LRCLIB simply omits the field, so take
    // it — but it carries no `matchedDurationSec`, which is what marks it
    // unverified downstream rather than letting it pass as a checked match.
    const unranked = candidates.find((c) => typeof c.hit.duration !== 'number');
    return unranked ? unrankedHit(unranked.result) : null;
  }

  /**
   * GET a LRCLIB endpoint. Returns the parsed JSON on 200, null on 404 (no
   * match), and throws on any other non-OK status or network/timeout failure.
   * Transient failures (429/5xx/network/timeout) are retried with a short
   * backoff; a 404 short-circuits without retrying (it's an authoritative "no
   * match", not a fluke).
   */
  private async request<T>(path: string): Promise<T | null> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.requestOnce<T>(path);
      } catch (err) {
        lastError = err;
        if (attempt < MAX_ATTEMPTS) await delay(this.retryBackoffMs * attempt);
      }
    }
    throw lastError;
  }

  /** A single GET attempt (no retry). 404 → null; other non-OK / errors throw. */
  private async requestOnce<T>(path: string): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(`${API_BASE}${path}`, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`LRCLIB request failed (${res.status}) for ${path}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
