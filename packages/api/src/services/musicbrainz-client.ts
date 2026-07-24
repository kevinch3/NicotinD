import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createLogger, normalizeLicence } from '@nicotind/core';
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

type CacheEntry =
  | { type: 'artist'; result: MBArtist | null }
  | { type: 'recording'; result: MBRecording | null }
  | { type: 'release-group'; result: MBReleaseGroup | null }
  | { type: 'licence'; result: string | null }
  | { type: 'discogs-url'; result: string | null };

const MB_BASE = 'https://musicbrainz.org/ws/2';
const MIN_INTERVAL_MS = 1050; // MusicBrainz allows 1 req/sec; add 50ms buffer

export class MusicBrainzClient {
  private cache = new Map<string, CacheEntry>();
  private lastCallAt = 0;

  constructor(
    private cacheFile: string,
    private userAgent: string,
  ) {
    if (existsSync(cacheFile)) {
      try {
        const raw = JSON.parse(readFileSync(cacheFile, 'utf-8')) as Record<string, CacheEntry>;
        for (const [k, v] of Object.entries(raw)) this.cache.set(k, v);
        log.debug({ entries: this.cache.size }, 'MB cache loaded');
      } catch {
        log.warn({ cacheFile }, 'Failed to parse MB cache; starting fresh');
      }
    }
  }

  /** Search for an artist by name; returns the top MB match or null. */
  async searchArtist(name: string): Promise<MBArtist | null> {
    const key = `artist:${name.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached?.type === 'artist') return cached.result;

    const url = `${MB_BASE}/artist?query=artist:${encodeURIComponent(name)}&fmt=json&limit=1`;
    const data = await this.fetch<{
      artists?: Array<{ id: string; name: string; score?: number }>;
    }>(url);
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
    const cached = this.cache.get(key);
    if (cached?.type === 'recording') return cached.result;

    const q = `recording:${encodeURIComponent(title)} AND artist:${encodeURIComponent(artist)}`;
    const url = `${MB_BASE}/recording?query=${q}&fmt=json&limit=10&inc=releases`;
    const data = await this.fetch<{
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
    }>(url);

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
    const cached = this.cache.get(key);
    if (cached?.type === 'release-group') return cached.result;

    const url = `${MB_BASE}/release-group/${encodeURIComponent(id)}?fmt=json`;
    const data = await this.fetch<{
      id?: string;
      title?: string;
      'primary-type'?: string;
      'first-release-date'?: string;
    }>(url);

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
    const data = await this.fetch<{ genres?: MbGenre[] }>(
      `${MB_BASE}/artist/${encodeURIComponent(mbid)}?inc=genres&fmt=json`,
    );
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
    const data = await this.fetch<{
      'release-groups'?: Array<{ id: string; title: string; genres?: MbGenre[] }>;
    }>(`${MB_BASE}/release-group?artist=${encodeURIComponent(mbid)}&inc=genres&fmt=json&limit=100`);
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
    const cached = this.cache.get(key);
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
    const data = await this.fetch<{
      relations?: Array<{ type?: string; url?: { resource?: string } }>;
    }>(url);
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
    const cached = this.cache.get(key);
    if (cached?.type === 'discogs-url') return cached.result;

    const url = `${MB_BASE}/artist/${encodeURIComponent(mbid)}?fmt=json&inc=url-rels`;
    const data = await this.fetch<{
      relations?: Array<{ type?: string; url?: { resource?: string } }>;
    }>(url);
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

  private async fetch<T>(url: string): Promise<T | null> {
    await this.rateLimit();
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/json',
        },
      });
      if (res.status === 503) {
        log.warn({ url }, 'MusicBrainz 503 — backing off 5s');
        await sleep(5000);
        return null;
      }
      if (!res.ok) {
        log.debug({ url, status: res.status }, 'MusicBrainz error');
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      log.warn({ url, err }, 'MusicBrainz fetch failed');
      return null;
    }
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallAt;
    if (elapsed < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - elapsed);
    this.lastCallAt = Date.now();
  }

  private setCached(key: string, entry: CacheEntry): void {
    this.cache.set(key, entry);
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
