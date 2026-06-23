import type {
  Plugin,
  PluginManifest,
  PluginHostContext,
  LyricsCapability,
  LyricsQuery,
  LyricsResult,
} from '@nicotind/core';

export interface LrclibPluginConfig {
  enabled: boolean;
}

/** Injected so tests run without network and without mocking node builtins. */
export interface LrclibPluginDeps {
  fetchFn?: typeof fetch;
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

/** Map a LRCLIB record to a LyricsResult, treating empty strings as "none". */
function toResult(track: LrclibTrack): LyricsResult | null {
  const plain = track.plainLyrics?.trim() ? track.plainLyrics : null;
  const synced = track.syncedLyrics?.trim() ? track.syncedLyrics : null;
  if (!plain && !synced) return null;
  return { plain, synced, source: 'lrclib' };
}

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

  constructor(config: LrclibPluginConfig = { enabled: true }, deps: LrclibPluginDeps = {}) {
    this.cfg = config;
    this.fetchFn = deps.fetchFn ?? fetch;
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

  private async fetchLyrics(query: LyricsQuery): Promise<LyricsResult | null> {
    // Prefer the exact-match /get endpoint; fall back to a fuzzy /search.
    const exact = await this.getExact(query);
    if (exact) return exact;
    return this.searchByQuery(query);
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
    return track ? toResult(track) : null;
  }

  private async searchByQuery(query: LyricsQuery): Promise<LyricsResult | null> {
    const params = new URLSearchParams({ q: `${query.artist} ${query.title}`.trim() });
    const hits = await this.request<LrclibTrack[]>(`/search?${params.toString()}`);
    if (!Array.isArray(hits)) return null;
    for (const hit of hits) {
      const result = toResult(hit);
      if (result) return result;
    }
    return null;
  }

  /**
   * GET a LRCLIB endpoint. Returns the parsed JSON on 200, null on 404 (no
   * match), and throws on any other non-OK status or network/timeout failure.
   */
  private async request<T>(path: string): Promise<T | null> {
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
