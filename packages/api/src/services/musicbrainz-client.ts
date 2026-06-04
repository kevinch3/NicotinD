import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createLogger } from '@nicotind/core';

const log = createLogger('musicbrainz-client');

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
  | { type: 'release-group'; result: MBReleaseGroup | null };

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
