/**
 * Unit tests for the multi-source metadata candidate gatherer (issue #411):
 * each source (Lidarr, MusicBrainz, Discogs via a fake plugin, file tags)
 * contributes independently, a failing/slow source degrades to `ok:false`
 * without failing the whole gather, and the merged list is deduped + ranked.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LidarrAlbum } from '@nicotind/lidarr-client';
import type { IdentifyOutcome } from '@nicotind/core';
import { applySchema } from '../db.js';
import {
  gatherCandidates,
  gatherSongCandidates,
  type CandidateSourcesDeps,
} from './candidate-sources.js';
import type { FixLidarr } from './metadata-fix.js';
import type { MusicBrainzClient, MBRecording, MBReleaseGroupHit } from './musicbrainz-client.js';
import type { PluginRegistry } from './plugins/registry.js';
import type { AudioTags } from './audio-tags.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, year, synced_at)
     VALUES ('album-1', 'Drukqs', 'Aphex Twin', 'artist-1', 'album-1', 1, 120, 2001, 0)`,
  );
  db.run(
    `INSERT INTO library_songs
      (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
     VALUES ('song-1', 'album-1', 'Avril 14th', 'Aphex Twin', 'artist-1', 120,
       'Aphex Twin/Drukqs/01 - Avril 14th.flac', 1000, 1000, 'flac', 'audio/flac', '2024-01-01', 0)`,
  );
});
afterEach(() => db.close());

function fakeLidarr(hits: unknown[]): FixLidarr {
  return { album: { lookup: async () => hits as LidarrAlbum[] } } as unknown as FixLidarr;
}

function fakeThrowingLidarr(): FixLidarr {
  return {
    album: {
      lookup: async () => {
        throw new Error('lidarr down');
      },
    },
  } as unknown as FixLidarr;
}

function fakeMb(hits: MBReleaseGroupHit[]): MusicBrainzClient {
  return { searchReleaseGroups: async () => hits } as unknown as MusicBrainzClient;
}

function fakeDiscogsRegistry(
  hits: Array<{
    artist: string;
    title: string;
    year: number | null;
    coverUrl: string | null;
    confidence: number;
  }>,
): PluginRegistry {
  const plugin = {
    manifest: { id: 'discogs' },
    releaseCandidates: { searchReleases: async () => hits },
  };
  return {
    getEnabledWithCapability: (cap: string) => (cap === 'release-candidates' ? [plugin] : []),
    getConfig: () => ({}),
  } as unknown as PluginRegistry;
}

function baseDeps(overrides: Partial<CandidateSourcesDeps> = {}): CandidateSourcesDeps {
  return { db, timeoutMs: 4000, ...overrides };
}

describe('gatherCandidates', () => {
  it('returns null for an unknown album', async () => {
    const result = await gatherCandidates(baseDeps(), 'nope');
    expect(result).toBeNull();
  });

  it('lidarr present: candidates carry source lidarr, sources reports ok:true', async () => {
    const lidarr = fakeLidarr([
      {
        foreignAlbumId: 'rg1',
        title: 'Drukqs',
        releaseDate: '2001-10-22',
        albumType: 'Album',
        artist: { artistName: 'Aphex Twin' },
        images: [],
      },
    ]);
    const result = await gatherCandidates(baseDeps({ lidarr }), 'album-1');
    expect(result?.sources).toEqual([{ id: 'lidarr', ok: true }]);
    expect(result?.candidates).toHaveLength(1);
    expect(result?.candidates[0]?.source).toBe('lidarr');
    expect(result?.candidates[0]?.artist).toBe('Aphex Twin');
  });

  it('lidarr throwing degrades to ok:false while other sources still contribute', async () => {
    const lidarr = fakeThrowingLidarr();
    const mb = fakeMb([
      {
        id: 'rg2',
        title: 'Drukqs',
        artist: 'Aphex Twin',
        primaryType: 'Album',
        firstReleaseDate: '2001-10-22',
        score: 100,
      },
    ]);
    const result = await gatherCandidates(baseDeps({ lidarr, mb }), 'album-1');
    expect(result?.sources).toEqual(
      expect.arrayContaining([
        { id: 'lidarr', ok: false },
        { id: 'musicbrainz', ok: true },
      ]),
    );
    const mbCandidate = result?.candidates.find((c) => c.source === 'musicbrainz');
    expect(mbCandidate).toBeDefined();
    expect(mbCandidate?.artist).toBe('Aphex Twin');
    expect(mbCandidate?.title).toBe('Drukqs');
    expect(mbCandidate?.year).toBe(2001);
  });

  it('discogs via a fake registry maps confidence to a 0-100 score', async () => {
    const plugins = fakeDiscogsRegistry([
      {
        artist: 'Aphex Twin',
        title: 'Drukqs',
        year: 2001,
        coverUrl: 'https://img/d.jpg',
        confidence: 0.8,
      },
    ]);
    const result = await gatherCandidates(baseDeps({ plugins }), 'album-1');
    expect(result?.sources).toEqual([{ id: 'discogs', ok: true }]);
    expect(result?.candidates).toHaveLength(1);
    expect(result?.candidates[0]).toMatchObject({
      source: 'discogs',
      artist: 'Aphex Twin',
      title: 'Drukqs',
      score: 80,
      coverUrl: 'https://img/d.jpg',
    });
  });

  it('tags source: reads the album first song path via injected readTags', async () => {
    let seenPath = '';
    const readTags = async (p: string): Promise<AudioTags> => {
      seenPath = p;
      return { artist: 'Real Artist', album: 'Real Album', year: 2001 };
    };
    const result = await gatherCandidates(baseDeps({ musicDir: '/music', readTags }), 'album-1');
    expect(seenPath).toContain('Aphex Twin/Drukqs/01 - Avril 14th.flac');
    expect(result?.sources).toEqual([{ id: 'tags', ok: true }]);
    expect(result?.candidates).toHaveLength(1);
    expect(result?.candidates[0]).toMatchObject({
      source: 'tags',
      artist: 'Real Artist',
      title: 'Real Album',
      year: 2001,
    });
  });

  it('a source slower than timeoutMs degrades to ok:false and gather still returns', async () => {
    const neverResolves = {
      album: { lookup: () => new Promise<LidarrAlbum[]>(() => {}) },
    } as unknown as FixLidarr;
    const result = await gatherCandidates(
      baseDeps({ lidarr: neverResolves, timeoutMs: 10 }),
      'album-1',
    );
    expect(result?.sources).toEqual([{ id: 'lidarr', ok: false }]);
    expect(result?.candidates).toEqual([]);
  });

  it('omits a source entirely when it is not configured (no lidarr, no discogs plugin)', async () => {
    const result = await gatherCandidates(baseDeps(), 'album-1');
    expect(result?.sources).toEqual([]);
    expect(result?.candidates).toEqual([]);
    expect(result?.identifyAvailable).toBe(false);
  });

  it('merges, dedupes by (artist,title,year) keeping the higher score, sorts desc, caps at 12', async () => {
    const lidarr = fakeLidarr([
      {
        foreignAlbumId: 'rg1',
        title: 'Drukqs',
        releaseDate: '2001-01-01',
        albumType: 'Album',
        artist: { artistName: 'Aphex Twin' },
        images: [],
      },
    ]);
    // MB hit is the same (artist,title,year) but with a lower-quality query
    // match than Lidarr's — the duplicate should be dropped, keeping Lidarr's.
    const mb = fakeMb(
      Array.from({ length: 15 }, (_, i) => ({
        id: `rg-${i}`,
        title: `Other Album ${i}`,
        artist: 'Aphex Twin',
        primaryType: 'Album',
        firstReleaseDate: '1995-01-01',
        score: 100,
      })).concat([
        {
          id: 'rg-dup',
          title: 'Drukqs',
          artist: 'Aphex Twin',
          primaryType: 'Album',
          firstReleaseDate: '2001-01-01',
          score: 100,
        },
      ]),
    );
    const result = await gatherCandidates(baseDeps({ lidarr, mb }), 'album-1', 'Aphex Twin Drukqs');
    expect(result?.candidates.length).toBeLessThanOrEqual(12);
    const drukqsMatches = result?.candidates.filter((c) => c.title === 'Drukqs' && c.year === 2001);
    expect(drukqsMatches).toHaveLength(1);
    // Descending score order.
    const scores = (result?.candidates ?? []).map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('identifyAvailable is true when an enabled identify plugin has an apiKey configured', async () => {
    const plugins = {
      getEnabledWithCapability: (cap: string) =>
        cap === 'identify' ? [{ manifest: { id: 'acoustid' } }] : [],
      getConfig: (id: string) => (id === 'acoustid' ? { apiKey: 'k' } : {}),
    } as unknown as PluginRegistry;
    const result = await gatherCandidates(baseDeps({ plugins }), 'album-1');
    expect(result?.identifyAvailable).toBe(true);
  });
});

describe('gatherSongCandidates', () => {
  beforeEach(() => {
    // A YouTube-polluted loose single: fake single-track album mirroring the title.
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, year, synced_at)
       VALUES ('album-yt', 'Pegao (Official Video)', 'Wisin & Yandel', 'artist-wy', 'album-yt', 1, 228, NULL, 0)`,
    );
    db.run(
      `INSERT INTO library_songs
        (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
       VALUES ('song-yt', 'album-yt', 'Pegao (Official Video)', 'Wisin & Yandel', 'artist-wy', 228,
         'Wisin & Yandel/Singles/Pegao (Official Video).opus', 1000, 128, 'opus', 'audio/ogg', '2026-08-01', 0)`,
    );
  });

  it('returns null for an unknown song', async () => {
    expect(await gatherSongCandidates(baseDeps(), 'nope')).toBeNull();
  });

  it('computes the cleaner suggestion even with zero sources configured', async () => {
    const result = await gatherSongCandidates(baseDeps(), 'song-yt');
    expect(result?.sources).toEqual([]);
    expect(result?.candidates).toEqual([]);
    expect(result?.suggested).toEqual({
      title: 'Pegao',
      album: 'Pegao',
      removed: ['(Official Video)'],
    });
  });

  it('suggestion is null when title and album are already clean', async () => {
    const result = await gatherSongCandidates(baseDeps(), 'song-1');
    expect(result?.suggested).toBeNull();
  });

  it('maps a MusicBrainz recording hit to an album candidate', async () => {
    const mb = {
      searchRecording: async () =>
        ({
          id: 'rec1',
          title: 'Pegao',
          score: 95,
          release: {
            id: 'rel1',
            title: 'Wisin vs. Yandel: Los Extraterrestres',
            primaryType: 'Album',
            date: '2007-10-30',
            status: 'Official',
          },
        }) as MBRecording,
    } as unknown as MusicBrainzClient;
    const result = await gatherSongCandidates(baseDeps({ mb }), 'song-yt');
    expect(result?.sources).toEqual([{ id: 'musicbrainz', ok: true }]);
    const candidate = result?.candidates.find((c) => c.source === 'musicbrainz');
    expect(candidate?.title).toBe('Wisin vs. Yandel: Los Extraterrestres');
    expect(candidate?.artist).toBe('Wisin & Yandel');
    expect(candidate?.year).toBe(2007);
    expect(candidate?.score).toBe(95);
  });

  it('a throwing source degrades to ok:false while others contribute', async () => {
    const mb = {
      searchRecording: async () => ({ id: 'rec1', title: 'Pegao', score: 90 }) as MBRecording,
    } as unknown as MusicBrainzClient;
    const result = await gatherSongCandidates(
      baseDeps({ lidarr: fakeThrowingLidarr(), mb }),
      'song-yt',
    );
    expect(result?.sources).toEqual(
      expect.arrayContaining([
        { id: 'lidarr', ok: false },
        { id: 'musicbrainz', ok: true },
      ]),
    );
  });

  it("tags source reads the song's own file", async () => {
    const seen: string[] = [];
    const readTags = async (path: string) => {
      seen.push(path);
      return { artist: 'Wisin & Yandel', album: 'Los Extraterrestres', year: 2007 } as AudioTags;
    };
    const result = await gatherSongCandidates(
      baseDeps({ musicDir: '/music', readTags }),
      'song-yt',
    );
    expect(seen[0]).toContain('Pegao (Official Video).opus');
    const candidate = result?.candidates.find((c) => c.source === 'tags');
    expect(candidate?.title).toBe('Los Extraterrestres');
  });

  it('fingerprint identify contributes the typed outcome and a candidate', async () => {
    const outcome = {
      kind: 'match',
      result: {
        acoustId: 'a1',
        score: 0.98,
        artist: 'Wisin & Yandel',
        album: 'Wisin vs. Yandel: Los Extraterrestres',
        title: 'Pegao',
        year: 2007,
      },
    } as IdentifyOutcome;
    const plugin = {
      manifest: { id: 'acoustid' },
      identify: { identifyTrack: async () => null, identifyTrackDetailed: async () => outcome },
    };
    const plugins = {
      getEnabledWithCapability: (cap: string) => (cap === 'identify' ? [plugin] : []),
      getConfig: () => ({ apiKey: 'k' }),
    } as unknown as PluginRegistry;
    const result = await gatherSongCandidates(
      baseDeps({ plugins, musicDir: '/music', readTags: async () => ({}) as AudioTags }),
      'song-yt',
    );
    expect(result?.identify).toEqual(outcome);
    expect(result?.sources).toEqual(expect.arrayContaining([{ id: 'acoustid', ok: true }]));
    const candidate = result?.candidates.find((c) => c.source === 'acoustid');
    expect(candidate?.title).toBe('Wisin vs. Yandel: Los Extraterrestres');
    expect(candidate?.score).toBe(98);
    expect(result?.identifyAvailable).toBe(true);
  });

  it('fingerprint: false skips the acoustid source entirely', async () => {
    let called = false;
    const plugin = {
      manifest: { id: 'acoustid' },
      identify: {
        identifyTrack: async () => null,
        identifyTrackDetailed: async () => {
          called = true;
          return { kind: 'no-match' } as IdentifyOutcome;
        },
      },
    };
    const plugins = {
      getEnabledWithCapability: (cap: string) => (cap === 'identify' ? [plugin] : []),
      getConfig: () => ({ apiKey: 'k' }),
    } as unknown as PluginRegistry;
    const result = await gatherSongCandidates(
      baseDeps({ plugins, musicDir: '/music', readTags: async () => ({}) as AudioTags }),
      'song-yt',
      undefined,
      { fingerprint: false },
    );
    expect(called).toBe(false);
    expect(result?.identify).toBeUndefined();
    expect(result?.sources.some((s) => s.id === 'acoustid')).toBe(false);
  });
});
