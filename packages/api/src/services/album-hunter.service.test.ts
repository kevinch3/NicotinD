import { describe, it, expect, mock } from 'bun:test';
import type { Slskd } from '@nicotind/slskd-client';
import type { LidarrTrack } from '@nicotind/lidarr-client';
import { AlbumHunterService, buildSkewedQueries } from './album-hunter.service';

function track(id: number, title: string): LidarrTrack {
  return {
    id,
    foreignTrackId: `ft${id}`,
    foreignRecordingId: `fr${id}`,
    trackFileId: 0,
    albumId: 1,
    artistId: 1,
    trackNumber: String(id),
    absoluteTrackNumber: id,
    title,
    duration: 1000,
    hasFile: false,
  };
}

interface StubFile {
  filename: string;
  size: number;
  bitRate?: number;
}

interface StubResponse {
  username: string;
  files: StubFile[];
  freeUploadSlots?: number;
  queueLength?: number;
  uploadSpeed?: number;
}

/** slskd stub that returns a fixed set of responses, already "complete". */
function makeSlskdStub(responses: StubResponse[]) {
  return {
    searches: {
      create: mock(async (q: string) => ({ id: `s-${q}`, state: 'Completed' })),
      get: mock(async () => ({ state: 'Completed' })),
      getResponses: mock(async () => responses),
      delete: mock(async () => undefined),
    },
  } as unknown as Slskd;
}

/**
 * slskd stub that maps each search query to its own response set. The `create`
 * mock encodes the query into the search id (`s-<query>`) so `getResponses`
 * can return per-query results — used to simulate a soft-banned phrase that
 * yields nothing while a skewed variant does.
 */
function makeQueryAwareSlskdStub(byQuery: Record<string, StubResponse[]>) {
  return {
    searches: {
      create: mock(async (q: string) => ({ id: `s-${q}`, state: 'Completed' })),
      get: mock(async () => ({ state: 'Completed' })),
      getResponses: mock(async (id: string) => byQuery[id.slice(2)] ?? []),
      delete: mock(async () => undefined),
    },
  } as unknown as Slskd;
}

const TRACKS = [track(1, 'Song One'), track(2, 'Song Two'), track(3, 'Song Three')];

describe('AlbumHunterService', () => {
  it('groups files by folder and scores match % against the tracklist', async () => {
    const slskd = makeSlskdStub([
      {
        username: 'alice',
        files: [
          { filename: 'Music\\Artist\\Album\\01 Song One.flac', size: 1_000_000 },
          { filename: 'Music\\Artist\\Album\\02 Song Two.flac', size: 1_000_000 },
          { filename: 'Music\\Artist\\Album\\03 Song Three.flac', size: 1_000_000 },
        ],
      },
      {
        username: 'bob',
        files: [{ filename: 'shared/random/Song One.mp3', size: 500_000, bitRate: 320 }],
      },
    ]);

    const hunter = new AlbumHunterService(slskd);
    const candidates = await hunter.hunt('Artist', 'Album', TRACKS);

    // Two distinct folders
    expect(candidates).toHaveLength(2);

    const full = candidates.find((c) => c.username === 'alice')!;
    expect(full.matchedTracks).toBe(3);
    expect(full.matchPct).toBe(100);
    expect(full.format).toBe('FLAC');

    const partial = candidates.find((c) => c.username === 'bob')!;
    expect(partial.matchedTracks).toBe(1);
    expect(partial.matchPct).toBe(33);
    // Best (FLAC, full) sorts first
    expect(candidates[0].username).toBe('alice');
  });

  it('detects MP3 bitrate in the format label', async () => {
    const slskd = makeSlskdStub([
      {
        username: 'carol',
        files: [
          { filename: 'X/Album/Song One.mp3', size: 1, bitRate: 320 },
          { filename: 'X/Album/Song Two.mp3', size: 1, bitRate: 320 },
        ],
      },
    ]);

    const hunter = new AlbumHunterService(slskd);
    const [candidate] = await hunter.hunt('Artist', 'Album', TRACKS);
    expect(candidate.format).toBe('MP3 320kbps');
  });

  it('flags live folders via the isLive property', async () => {
    const slskd = makeSlskdStub([
      {
        username: 'dave',
        files: [
          { filename: 'Artist/Album (Live in Tokyo)/Song One.flac', size: 1 },
          { filename: 'Artist/Album (Live in Tokyo)/Song Two.flac', size: 1 },
        ],
      },
    ]);

    const hunter = new AlbumHunterService(slskd);
    const [candidate] = await hunter.hunt('Artist', 'Album', TRACKS);
    expect(candidate.isLive).toBe(true);
  });

  it('drops folders below the low match floor', async () => {
    const slskd = makeSlskdStub([
      {
        username: 'erin',
        files: [{ filename: 'Junk/Unrelated/totally different name.mp3', size: 1 }],
      },
    ]);

    const hunter = new AlbumHunterService(slskd);
    const candidates = await hunter.hunt('Artist', 'Album', TRACKS);
    expect(candidates).toHaveLength(0);
  });

  it('prefers a healthy 90%-match peer over a dead 100%-match peer', async () => {
    // 10-track album so 90% and 100% land in the same match bucket. `dead` has
    // the complete album but no free slots and a long queue — it would truncate.
    // `healthy` is one track short but free and fast, so it should sort first.
    const tenTracks = Array.from({ length: 10 }, (_, i) => track(i + 1, `Song ${i + 1}`));
    const allFiles = (user: string, count: number): StubFile[] =>
      Array.from({ length: count }, (_, i) => ({
        filename: `${user}/Album/${String(i + 1).padStart(2, '0')} Song ${i + 1}.flac`,
        size: 1,
      }));

    const slskd = makeSlskdStub([
      {
        username: 'dead',
        freeUploadSlots: 0,
        queueLength: 50,
        uploadSpeed: 1000,
        files: allFiles('dead', 10), // 100%
      },
      {
        username: 'healthy',
        freeUploadSlots: 2,
        queueLength: 0,
        uploadSpeed: 500_000,
        files: allFiles('healthy', 9), // 90%
      },
    ]);

    const hunter = new AlbumHunterService(slskd);
    const candidates = await hunter.hunt('Artist', 'Album', tenTracks);

    expect(candidates[0].username).toBe('healthy');
    expect(candidates[0].freeUploadSlots).toBe(2);
    expect(candidates[1].username).toBe('dead');
  });

  it('ignores non-audio files when grouping', async () => {
    const slskd = makeSlskdStub([
      {
        username: 'frank',
        files: [
          { filename: 'A/Album/Song One.flac', size: 1 },
          { filename: 'A/Album/Song Two.flac', size: 1 },
          { filename: 'A/Album/cover.jpg', size: 1 },
          { filename: 'A/Album/folder.nfo', size: 1 },
        ],
      },
    ]);

    const hunter = new AlbumHunterService(slskd);
    const [candidate] = await hunter.hunt('Artist', 'Album', TRACKS);
    expect(candidate.files).toHaveLength(2);
  });

  describe('buildSkewedQueries', () => {
    it('produces reorder / album-only variants and excludes the base queries', () => {
      const base = ['Artist Album', 'Artist - Album'];
      const skewed = buildSkewedQueries('Artist', 'Album', base);
      // "drop the" and "artist + first word" both collapse to "Artist Album"
      // which is a base query, so only the genuinely-distinct variants survive.
      expect(skewed).toEqual(['Album Artist', 'Album']);
      for (const q of skewed) expect(base).not.toContain(q);
    });

    it('drops the leading "the" from artist and album', () => {
      const base = ['The Beatles The White Album', 'The Beatles - The White Album'];
      const skewed = buildSkewedQueries('The Beatles', 'The White Album', base);
      expect(skewed).toContain('Beatles White Album');
      // de-duped, no empties, none equal to a base query
      expect(new Set(skewed).size).toBe(skewed.length);
      expect(skewed.every((q) => q.trim().length > 0)).toBe(true);
    });
  });

  describe('skew search (soft-ban bypass)', () => {
    const fullAlbum: StubResponse = {
      username: 'zoe',
      files: [
        { filename: 'Music/Artist/Album/01 Song One.flac', size: 1 },
        { filename: 'Music/Artist/Album/02 Song Two.flac', size: 1 },
        { filename: 'Music/Artist/Album/03 Song Three.flac', size: 1 },
      ],
    };

    it('retries with skewed queries when the base queries return empty', async () => {
      // Base queries are "soft-banned" (empty); the album-only skew variant hits.
      const slskd = makeQueryAwareSlskdStub({ Album: [fullAlbum] });

      const hunter = new AlbumHunterService(slskd);
      const candidates = await hunter.hunt('Artist', 'Album', TRACKS, { skewSearch: true });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].username).toBe('zoe');
      expect(candidates[0].matchPct).toBe(100);

      // Both base queries AND the skewed variants were created.
      const created = (slskd.searches.create as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0],
      );
      expect(created).toContain('Artist Album');
      expect(created).toContain('Album');
    });

    it('does not fire skewed queries when skewSearch is off', async () => {
      const slskd = makeQueryAwareSlskdStub({ Album: [fullAlbum] });

      const hunter = new AlbumHunterService(slskd);
      const candidates = await hunter.hunt('Artist', 'Album', TRACKS);

      expect(candidates).toHaveLength(0);
      const created = (slskd.searches.create as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0],
      );
      expect(created).toEqual(['Artist Album', 'Artist - Album']);
    });
  });
});
