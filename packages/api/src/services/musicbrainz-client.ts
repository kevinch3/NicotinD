import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createLogger, normalizeLicence, normalizeMbCountry } from '@nicotind/core';
import type { MbGenre } from './genre-resolve.js';

const log = createLogger('musicbrainz-client');

/** Shared MusicBrainz User-Agent (their API requires an identifying one). */
export const MB_USER_AGENT = 'NicotinD (+https://github.com/kevinch3/nicotind)';

export interface MBArtist {
  id: string;
  name: string;
  score: number;
}

export interface MBRelease {
  id: string;
  title: string;
  /** Release-group type, e.g. "Album", "Single", "EP", "Compilation" */
  primaryType?: string;
  date?: string;
  status?: string;
}

export interface MBRecording {
  id: string;
  title: string;
  score: number;
  /** Best matching release (album) for this recording. */
  release?: MBRelease;
}

export interface MBReleaseGroup {
  id: string;
  title: string;
  primaryType?: string;
  firstReleaseDate?: string;
}

export interface MBReleaseGroupHit {
  id: string;
  title: string;
  artist: string;
  primaryType?: string;
  firstReleaseDate?: string;
  score: number;
}

/** One track of a release's canonical tracklist (issue #413). */
export interface MBCanonicalTrack {
  /** 1-based position on the medium, as MusicBrainz numbers it. */
  position: number;
  title: string;
  /** Track length in seconds, when MB knows it. */
  durationSec?: number;
}

/**
 * `at` is the write time. It is optional because entries written before this
 * field existed have none — and those are treated as EXPIRED rather than
 * eternal, on purpose: they are exactly the era in which a single 503 or dropped
 * connection could be recorded as "no such entity" forever. Dropping them clears
 * any such poisoning. It does not cause a re-fetch storm, because an expired
 * entry is only re-fetched when that specific entity is next looked up.
 */
type CacheEntry = { at?: number } & (
  | { type: 'artist'; result: MBArtist | null }
  | { type: 'tracklist'; result: MBCanonicalTrack[] }
  | { type: 'recording'; result: MBRecording | null }
  | { type: 'release-group'; result: MBReleaseGroup | null }
  | { type: 'release-group-search'; result: MBReleaseGroupHit[] }
  | { type: 'licence'; result: string | null }
  | { type: 'discogs-url'; result: string | null }
  | { type: 'origin'; result: string | null }
);

/** A cached "there is nothing here" — null, or an empty list. */
function isCachedMiss(entry: CacheEntry): boolean {
  const r = entry.result as unknown;
  return r === null || (Array.isArray(r) && r.length === 0);
}

const MB_BASE = 'https://musicbrainz.org/ws/2';
const MIN_INTERVAL_MS = 1050; // MusicBrainz allows 1 req/sec; add 50ms buffer

/**
 * How long a cached answer is trusted. There was no expiry at all: the cache was
 * written once and read forever, so every mistake in it was permanent — and
 * MusicBrainz is a wiki, so even correct answers drift.
 *
 * 30 days is chosen to be much longer than any enrichment pass (so a run never
 * re-fetches what it just fetched) and much shorter than "never".
 */
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Outcome of one MusicBrainz request.
 *
 * `confirmed` is the load-bearing bit: it separates "MB says this does not
 * exist" (worth caching) from "we could not find out" (never cache — the cache
 * has no expiry, so a transient failure would become permanent).
 */
type FetchOutcome<T> = { ok: true; data: T } | { ok: false; confirmed: boolean };

/**
 * Per-request budget. There was none: a hung MusicBrainz held the call — and,
 * through the shared rate limiter, every queued call behind it — open forever.
 * 15s rather than 10 because `getArtistReleaseGroups` (limit=100 + inc=genres)
 * and the `inc=url-rels` expansions are genuinely multi-second.
 */
export const FETCH_TIMEOUT_MS = 15_000;

/** Injected so tests need no real delays — mirrors DiscogsClient's deps style. */
export interface MusicBrainzClientDeps {
  /** Replaces the real timer behind both the rate limit and the 503 backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so TTL expiry is testable without waiting 30 days. */
  now?: () => number;
}

export class MusicBrainzClient {
  private cache = new Map<string, CacheEntry>();
  private lastCallAt = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private cacheFile: string,
    private userAgent: string,
    deps: MusicBrainzClientDeps = {},
  ) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
    if (existsSync(cacheFile)) {
      try {
        const raw = JSON.parse(readFileSync(cacheFile, 'utf-8')) as Record<string, CacheEntry>;
        let droppedMisses = 0;
        for (const [k, v] of Object.entries(raw)) {
          if (v.at !== undefined) {
            this.cache.set(k, v);
            continue;
          }
          // A legacy entry, written before a transient failure could be told
          // apart from a real absence. A cached MISS from that era may be a
          // recorded 503 or dropped connection rather than "MusicBrainz has
          // nothing" — and with no expiry it would stay wrong forever, so drop
          // it. A cached HIT is real data: keep it, and start its clock now.
          if (isCachedMiss(v)) {
            droppedMisses += 1;
            continue;
          }
          this.cache.set(k, { ...v, at: this.now() });
        }
        log.debug({ entries: this.cache.size, droppedMisses }, 'MB cache loaded');
      } catch {
        log.warn({ cacheFile }, 'Failed to parse MB cache; starting fresh');
      }
    }
  }

  /** Search for an artist by name; returns the top MB match or null. */
  async searchArtist(name: string): Promise<MBArtist | null> {
    const key = `artist:${name.toLowerCase()}`;
    const cached = this.getCached(key);
    if (cached?.type === 'artist') return cached.result;

    const url = `${MB_BASE}/artist?query=artist:${encodeURIComponent(name)}&fmt=json&limit=1`;
    const data = this.unwrap(
      await this.fetch<{
        artists?: Array<{ id: string; name: string; score?: number }>;
      }>(url),
    );
    // Transient: do not cache, so the next call retries.
    if (data === undefined) return null;
    const first = data?.artists?.[0];
    const result: MBArtist | null = first
      ? { id: first.id, name: first.name, score: first.score ?? 0 }
      : null;
    this.setCached(key, { type: 'artist', result });
    return result;
  }

  /**
   * Search for a recording by artist + title.
   * Returns the first official Album-type result, or first result, or null.
   */
  async searchRecording(artist: string, title: string): Promise<MBRecording | null> {
    const key = `recording:${artist.toLowerCase()}|${title.toLowerCase()}`;
    const cached = this.getCached(key);
    if (cached?.type === 'recording') return cached.result;

    const q = `recording:${encodeURIComponent(title)} AND artist:${encodeURIComponent(artist)}`;
    const url = `${MB_BASE}/recording?query=${q}&fmt=json&limit=10&inc=releases`;
    const data = this.unwrap(
      await this.fetch<{
        recordings?: Array<{
          id: string;
          title: string;
          score?: number;
          releases?: Array<{
            id: string;
            title: string;
            status?: string;
            date?: string;
            'release-group'?: { 'primary-type'?: string };
          }>;
        }>;
      }>(url),
    );
    // Transient: do not cache, so the next call retries.
    if (data === undefined) return null;

    const recordings = data?.recordings ?? [];
    let best: MBRecording | null = null;

    for (const rec of recordings) {
      const releases = rec.releases ?? [];
      // Prefer an official Album-type release
      const albumRelease = releases.find(
        (r) => r.status === 'Official' && r['release-group']?.['primary-type'] === 'Album',
      );
      const release = albumRelease ?? releases.find((r) => r.status === 'Official') ?? releases[0];
      if (!release) continue;

      const candidate: MBRecording = {
        id: rec.id,
        title: rec.title,
        score: rec.score ?? 0,
        release: {
          id: release.id,
          title: release.title,
          primaryType: release['release-group']?.['primary-type'],
          date: release.date,
          status: release.status,
        },
      };

      // Only count as a hit if it's an Album-type release
      if (candidate.release?.primaryType === 'Album') {
        best = candidate;
        break;
      }
      // Keep as fallback if nothing better comes
      best ??= candidate;
    }

    this.setCached(key, { type: 'recording', result: best });
    return best;
  }

  /** Fetch release-group metadata (for canonical album title/type). */
  async getReleaseGroup(id: string): Promise<MBReleaseGroup | null> {
    const key = `rg:${id}`;
    const cached = this.getCached(key);
    if (cached?.type === 'release-group') return cached.result;

    const url = `${MB_BASE}/release-group/${encodeURIComponent(id)}?fmt=json`;
    const data = this.unwrap(
      await this.fetch<{
        id?: string;
        title?: string;
        'primary-type'?: string;
        'first-release-date'?: string;
      }>(url),
    );
    // Transient: do not cache, so the next call retries.
    if (data === undefined) return null;

    const result: MBReleaseGroup | null = data?.title
      ? {
          id: data.id ?? id,
          title: data.title,
          primaryType: data['primary-type'],
          firstReleaseDate: data['first-release-date'],
        }
      : null;

    this.setCached(key, { type: 'release-group', result });
    return result;
  }

  /**
   * Search release-groups by artist + album title, returning candidate hits
   * ranked by MB's own relevance `score`. Used by the download-inbox triage
   * candidate layer to propose an album match for an unresolved download.
   */
  async searchReleaseGroups(
    artist: string,
    album: string,
    limit = 5,
  ): Promise<MBReleaseGroupHit[]> {
    const key = `rgsearch:${artist.toLowerCase()}|${album.toLowerCase()}`;
    const cached = this.getCached(key);
    if (cached?.type === 'release-group-search') return cached.result;

    // Lucene phrase-escape (issue #416): a `"` or `\` inside a title would
    // otherwise break out of the phrase and corrupt the whole query (same
    // helper shape as archive-search.service.ts's `phrase`).
    const phrase = (term: string): string => `"${term.replace(/[\\"]/g, '\\$&')}"`;
    const query = artist
      ? `releasegroup:${phrase(album)} AND artist:${phrase(artist)}`
      : `releasegroup:${phrase(album)}`;
    const url = `${MB_BASE}/release-group?query=${encodeURIComponent(query)}&limit=${limit}&fmt=json`;
    const data = this.unwrap(
      await this.fetch<{
        'release-groups'?: Array<{
          id: string;
          title: string;
          score?: number;
          'primary-type'?: string;
          'first-release-date'?: string;
          'artist-credit'?: Array<{ name?: string }>;
        }>;
      }>(url),
    );
    // Transient: do not cache, so the next call retries.
    if (data === undefined) return [];

    const hits: MBReleaseGroupHit[] = (data?.['release-groups'] ?? []).map((rg) => ({
      id: rg.id,
      title: rg.title,
      artist: rg['artist-credit']?.[0]?.name ?? '',
      primaryType: rg['primary-type'],
      firstReleaseDate: rg['first-release-date'],
      score: rg.score ?? 0,
    }));

    this.setCached(key, { type: 'release-group-search', result: hits });
    return hits;
  }

  /**
   * The canonical tracklist for a release group (issue #413) — MusicBrainz is
   * the only candidate source that has one, which is why this lives here and
   * not behind the generic candidate contract.
   *
   * Two hops by necessity: a release *group* has no tracks (it's the abstract
   * "album"), so we take its releases and read the tracklist off one of them.
   * The pick is deliberate rather than "first": an **Official** release whose
   * track count is largest wins, because MB lists promos/singles/partial
   * digital editions alongside the real album and a short one would truncate
   * the tracklist a curator is about to apply. Ties keep MB's own ordering.
   *
   * Only the first medium is returned — a curator applying titles to a
   * quarantined folder is matching one disc's worth of files, and flattening
   * multi-disc positions would renumber them wrongly.
   */
  async getCanonicalTracklist(releaseGroupId: string): Promise<MBCanonicalTrack[]> {
    const key = `tracklist:${releaseGroupId}`;
    const cached = this.getCached(key);
    if (cached?.type === 'tracklist') return cached.result;

    const listUrl =
      `${MB_BASE}/release?release-group=${encodeURIComponent(releaseGroupId)}` +
      `&inc=media&limit=25&fmt=json`;
    const listing = this.unwrap(
      await this.fetch<{
        releases?: Array<{
          id: string;
          status?: string;
          media?: Array<{ 'track-count'?: number }>;
        }>;
      }>(listUrl),
    );
    // Transient: do not cache, so the next call retries.
    if (listing === undefined) return [];

    const releases = listing?.releases ?? [];
    if (releases.length === 0) {
      this.setCached(key, { type: 'tracklist', result: [] });
      return [];
    }

    const trackCount = (r: { media?: Array<{ 'track-count'?: number }> }): number =>
      r.media?.reduce((n, m) => n + (m['track-count'] ?? 0), 0) ?? 0;
    const official = releases.filter((r) => r.status === 'Official');
    const pool = official.length > 0 ? official : releases;
    const best = pool.reduce((a, b) => (trackCount(b) > trackCount(a) ? b : a));

    const detail = this.unwrap(
      await this.fetch<{
        media?: Array<{
          tracks?: Array<{ position?: number; number?: string; title?: string; length?: number }>;
        }>;
      }>(`${MB_BASE}/release/${encodeURIComponent(best.id)}?inc=recordings&fmt=json`),
    );
    // Transient: do not cache, so the next call retries.
    if (detail === undefined) return [];

    const tracks: MBCanonicalTrack[] = (detail?.media?.[0]?.tracks ?? [])
      .filter((t) => Boolean(t.title))
      .map((t, i) => ({
        position: t.position ?? (Number(t.number) || i + 1),
        title: t.title!,
        // MB reports length in milliseconds; seconds is what the library stores.
        durationSec: typeof t.length === 'number' ? Math.round(t.length / 1000) : undefined,
      }));

    this.setCached(key, { type: 'tracklist', result: tracks });
    return tracks;
  }

  /**
   * Genres for one artist, BY MBID — never by name. Genre lookups must not go
   * through a fuzzy search step (see genre-resolve.ts for the false pair this
   * avoids). Returns the raw voted genres; `pickGenres` decides what's usable.
   *
   * Expect this to be empty far more often than not: measured 2/25 on the prod
   * library, because MB genre data is crowd-sourced and thin outside Anglo
   * mainstream repertoire. Callers should treat [] as "no proposal", not as an
   * error, and fall back to release-group genres which cover ~6x more.
   */
  async getArtistGenres(mbid: string): Promise<MbGenre[]> {
    const data = this.unwrap(
      await this.fetch<{ genres?: MbGenre[] }>(
        `${MB_BASE}/artist/${encodeURIComponent(mbid)}?inc=genres&fmt=json`,
      ),
    );
    // Transient: do not cache, so the next call retries.
    if (data === undefined) return [];
    return data?.genres ?? [];
  }

  /**
   * Every release group for an artist MBID with its voted genres, in one call.
   * This is the highest-yield genre source measured for #187 (8/12 artists vs
   * 2/25 at artist level) and also the most specific — `chacarera`, `cumbia`,
   * `progressive house` rather than a flat `Latin`.
   *
   * The titles double as the corroboration signal `gateArtistResolution` needs
   * to reject a same-name-different-artist match, so this is fetched even when
   * only an artist-level genre is wanted.
   */
  async getArtistReleaseGroups(
    mbid: string,
  ): Promise<Array<{ id: string; title: string; genres: MbGenre[] }>> {
    const data = this.unwrap(
      await this.fetch<{
        'release-groups'?: Array<{ id: string; title: string; genres?: MbGenre[] }>;
      }>(
        `${MB_BASE}/release-group?artist=${encodeURIComponent(mbid)}&inc=genres&fmt=json&limit=100`,
      ),
    );
    // Transient: do not cache, so the next call retries.
    if (data === undefined) return [];
    return (data?.['release-groups'] ?? []).map((rg) => ({
      id: rg.id,
      title: rg.title,
      genres: rg.genres ?? [],
    }));
  }

  /**
   * Resolve a Creative-Commons / public-domain licence via MusicBrainz `license`
   * url-relations, most-specific first (recording → release). Returns a canonical
   * LICENCE_VOCAB code, or null when MB has no license relationship (the common
   * case — coverage is sparse, mostly CC-flavoured releases). When only
   * artist+title are known, a recording is resolved via searchRecording first.
   */
  async getLicence(q: {
    mbRecordingId?: string;
    mbReleaseId?: string;
    artist?: string;
    title?: string;
  }): Promise<string | null> {
    let recordingId = q.mbRecordingId;
    if (!recordingId && q.artist && q.title) {
      recordingId = (await this.searchRecording(q.artist, q.title))?.id;
    }
    if (!recordingId && !q.mbReleaseId) return null;

    const key = `licence:${recordingId ?? ''}|${q.mbReleaseId ?? ''}`;
    const cached = this.getCached(key);
    if (cached?.type === 'licence') return cached.result;

    let code: string | null = null;
    if (recordingId) code = await this.licenceFromEntity('recording', recordingId);
    if (!code && q.mbReleaseId) code = await this.licenceFromEntity('release', q.mbReleaseId);
    this.setCached(key, { type: 'licence', result: code });
    return code;
  }

  private async licenceFromEntity(
    kind: 'recording' | 'release',
    id: string,
  ): Promise<string | null> {
    const url = `${MB_BASE}/${kind}/${encodeURIComponent(id)}?fmt=json&inc=url-rels`;
    const data = this.unwrap(
      await this.fetch<{
        relations?: Array<{ type?: string; url?: { resource?: string } }>;
      }>(url),
    );
    // Transient: do not cache, so the next call retries.
    if (data === undefined) return null;
    for (const rel of data?.relations ?? []) {
      if (rel.type === 'license') {
        const code = normalizeLicence(rel.url?.resource);
        if (code) return code;
      }
    }
    return null;
  }

  /**
   * Resolve an artist's Discogs artist-page URL via MusicBrainz's own `discogs`
   * url-relation (issue #195) — the same MBID-first pattern as {@link getLicence}.
   * Returns null when MB has no such relation (the common case).
   */
  async getArtistDiscogsUrl(mbid: string): Promise<string | null> {
    const key = `discogs-url:${mbid}`;
    const cached = this.getCached(key);
    if (cached?.type === 'discogs-url') return cached.result;

    const url = `${MB_BASE}/artist/${encodeURIComponent(mbid)}?fmt=json&inc=url-rels`;
    const data = this.unwrap(
      await this.fetch<{
        relations?: Array<{ type?: string; url?: { resource?: string } }>;
      }>(url),
    );
    // Transient: do not cache, so the next call retries.
    if (data === undefined) return null;
    let discogsUrl: string | null = null;
    for (const rel of data?.relations ?? []) {
      if (rel.type === 'discogs' && rel.url?.resource) {
        discogsUrl = rel.url.resource;
        break;
      }
    }
    this.setCached(key, { type: 'discogs-url', result: discogsUrl });
    return discogsUrl;
  }

  /**
   * Resolve an artist's origin country (ISO 3166-1 alpha-2) from the bare
   * artist entity: `country` first, else a country-typed `area`'s iso code.
   * `ok:false` = transient fetch failure (retry later, never cached);
   * `ok:true, country:null` = MB has no usable country (a confirmed miss).
   */
  async getArtistOrigin(mbid: string): Promise<{ ok: boolean; country: string | null }> {
    const key = `origin:${mbid}`;
    const cached = this.getCached(key);
    if (cached?.type === 'origin') return { ok: true, country: cached.result };

    const data = this.unwrap(
      await this.fetch<{
        country?: string;
        area?: { type?: string; 'iso-3166-1-codes'?: string[] };
      }>(`${MB_BASE}/artist/${encodeURIComponent(mbid)}?fmt=json`),
    );
    // Transient: do not cache, so the next call retries.
    if (data === undefined) return { ok: false, country: null };

    // `data === null` is now reachable and meaningful: MB answered 404, so the
    // absence is real and worth remembering. Previously this method could not
    // tell that from a network failure and refused to cache either.
    const raw =
      data?.country ??
      (data?.area?.type === 'Country' ? data?.area?.['iso-3166-1-codes']?.[0] : undefined);
    const country = normalizeMbCountry(raw);
    this.setCached(key, { type: 'origin', result: country });
    return { ok: true, country };
  }

  /**
   * Every caller used to receive a bare `null` for all three of "MusicBrainz
   * answered, there is nothing", "MusicBrainz is down" and "the request never
   * completed" — and then cached it. Since the cache had no expiry, one 503 or
   * one dropped connection permanently recorded "no such entity" for that
   * artist or release group.
   *
   * `getArtistOrigin` already avoided this by returning before caching; this
   * generalises that distinction so the other nine methods can too.
   */
  private async fetch<T>(url: string): Promise<FetchOutcome<T>> {
    await this.rateLimit();
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/json',
        },
        // Inline, and AFTER rateLimit(): hoisting it above the await would start
        // the clock during the ~1s rate-limit wait and abort healthy requests.
        // 15s rather than 10 because `getArtistReleaseGroups` (limit=100 +
        // inc=genres) and the `inc=url-rels` expansions are genuinely
        // multi-second.
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 503) {
        log.warn({ url }, 'MusicBrainz 503 — backing off 5s');
        await this.sleep(5000);
        return { ok: false, confirmed: false };
      }
      // 404 is MusicBrainz answering authoritatively: this MBID does not exist.
      // Worth remembering. Anything else in the error range is theirs, not ours.
      if (res.status === 404) {
        log.debug({ url }, 'MusicBrainz 404 — confirmed miss');
        return { ok: false, confirmed: true };
      }
      if (!res.ok) {
        log.debug({ url, status: res.status }, 'MusicBrainz error');
        return { ok: false, confirmed: false };
      }
      return { ok: true, data: (await res.json()) as T };
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      log.warn({ url, err, timedOut }, 'MusicBrainz fetch failed');
      return { ok: false, confirmed: false };
    }
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallAt;
    if (elapsed < MIN_INTERVAL_MS) await this.sleep(MIN_INTERVAL_MS - elapsed);
    this.lastCallAt = Date.now();
  }

  /**
   * Collapse an outcome for callers that cache their result.
   *
   *   T          - MusicBrainz answered
   *   null       - it answered that there is nothing (a confirmed miss; cacheable)
   *   undefined  - we could not find out (transient; the caller must NOT cache,
   *                and returns its empty value so the next call retries)
   *
   * The three used to be one bare `null`, which is how a single 503 could
   * permanently record "no such entity" in a cache that has no expiry.
   */
  /**
   * A cache read that respects the TTL. Returns undefined for "nothing usable",
   * which every caller already treats as "go and ask MusicBrainz".
   */
  private getCached(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.at === undefined || this.now() - entry.at > CACHE_TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  private unwrap<T>(out: FetchOutcome<T>): T | null | undefined {
    if (out.ok) return out.data;
    return out.confirmed ? null : undefined;
  }

  private setCached(key: string, entry: CacheEntry): void {
    this.cache.set(key, { ...entry, at: this.now() });
    this.flushCache();
  }

  private flushCache(): void {
    try {
      const obj: Record<string, CacheEntry> = {};
      for (const [k, v] of this.cache) obj[k] = v;
      writeFileSync(this.cacheFile, JSON.stringify(obj), 'utf-8');
    } catch (err) {
      log.warn({ err }, 'Failed to persist MB cache');
    }
  }
}
