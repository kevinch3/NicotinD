import { describe, it, expect, mock } from 'bun:test';
import type { Slskd } from '@nicotind/slskd-client';
import type { LidarrTrack } from '@nicotind/lidarr-client';
import {
  AlbumHunterService,
  buildSkewedQueries,
  normalizeTitle,
  singleMatchStrength,
  stripTitleQualifiers,
} from './album-hunter.service';

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

  describe('singles and EPs', () => {
    it('matches a single exactly (1 track → 100%)', async () => {
      const slskd = makeSlskdStub([
        { username: 'sia', files: [{ filename: 'Sia/Chandelier/Chandelier.flac', size: 1 }] },
      ]);
      const hunter = new AlbumHunterService(slskd);
      const candidates = await hunter.hunt('Sia', 'Chandelier', [track(1, 'Chandelier')]);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].matchPct).toBe(100);
      expect(candidates[0].matchedTracks).toBe(1);
    });

    it('surfaces a single whose Lidarr "(feat …)" suffix the peer dropped (partial)', async () => {
      // Full titles do not overlap ("stay feat justin bieber" vs "stay"), but the
      // qualifier-stripped cores do — the near hit must still appear, ranked low.
      const slskd = makeSlskdStub([
        { username: 'kygo', files: [{ filename: 'Kygo/Stay/01 Stay.mp3', size: 1, bitRate: 320 }] },
      ]);
      const hunter = new AlbumHunterService(slskd);
      const candidates = await hunter.hunt('Kygo', 'Stay (feat. Justin Bieber)', [
        track(1, 'Stay (feat. Justin Bieber)'),
      ]);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].matchPct).toBe(50);
    });

    it('ranks an exact single match above a core-only (qualifier-stripped) one', async () => {
      const slskd = makeSlskdStub([
        // Core-only: omits the featured artist.
        { username: 'core', files: [{ filename: 'A/Stay/Stay.flac', size: 1 }] },
        // Exact: carries the full "(feat …)" title.
        { username: 'exact', files: [{ filename: 'A/Stay/Stay (feat. Justin Bieber).flac', size: 1 }] },
      ]);
      const hunter = new AlbumHunterService(slskd);
      const candidates = await hunter.hunt('Kygo', 'Stay (feat. Justin Bieber)', [
        track(1, 'Stay (feat. Justin Bieber)'),
      ]);
      expect(candidates[0].username).toBe('exact');
      expect(candidates[0].matchPct).toBe(100);
      expect(candidates[1].matchPct).toBe(50);
    });

    it('drops a single with no title overlap at all', async () => {
      const slskd = makeSlskdStub([
        { username: 'nope', files: [{ filename: 'X/Y/something else entirely.mp3', size: 1 }] },
      ]);
      const hunter = new AlbumHunterService(slskd);
      const candidates = await hunter.hunt('Sia', 'Chandelier', [track(1, 'Chandelier')]);
      expect(candidates).toHaveLength(0);
    });

    it('scores an EP proportionally (2 of 3 → 67%)', async () => {
      const ep = [track(1, 'Intro'), track(2, 'Middle'), track(3, 'Outro')];
      const slskd = makeSlskdStub([
        {
          username: 'ep',
          files: [
            { filename: 'A/EP/01 Intro.flac', size: 1 },
            { filename: 'A/EP/02 Middle.flac', size: 1 },
          ],
        },
      ]);
      const hunter = new AlbumHunterService(slskd);
      const [candidate] = await hunter.hunt('Artist', 'EP', ep);
      expect(candidate.matchedTracks).toBe(2);
      expect(candidate.matchPct).toBe(67);
    });
  });

  describe('normalizeTitle', () => {
    it('folds diacritics so accented and unaccented spellings match', () => {
      // The crux for this Latin-American library: peers routinely drop accents.
      expect(normalizeTitle('Canción Animal')).toBe(normalizeTitle('cancion animal'));
      expect(normalizeTitle('Corazón Espinado')).toBe('corazon espinado');
      expect(normalizeTitle('Niño')).toBe('nino');
      expect(normalizeTitle('Música Ligera')).toBe('musica ligera');
      expect(normalizeTitle('Está')).toBe(normalizeTitle('Esta'));
    });

    it('still strips leading track numbers and punctuation', () => {
      expect(normalizeTitle('01 - Canción')).toBe('cancion');
      expect(normalizeTitle('07. Déjà Vu!')).toBe('deja vu');
      expect(normalizeTitle('  Mixed   Spaces  ')).toBe('mixed spaces');
    });
  });

  describe('stripTitleQualifiers', () => {
    it('strips parenthetical and feat/ft/with clauses', () => {
      expect(stripTitleQualifiers('Stay (feat. Justin Bieber)')).toBe('Stay');
      expect(stripTitleQualifiers('Chandelier (Piano Version)')).toBe('Chandelier');
      expect(stripTitleQualifiers('Time (2014 Remaster)')).toBe('Time');
      expect(stripTitleQualifiers('Crazy feat. Cee-Lo')).toBe('Crazy');
      expect(stripTitleQualifiers('Under Pressure with David Bowie')).toBe('Under Pressure');
      expect(stripTitleQualifiers('Plain Title')).toBe('Plain Title');
    });
  });

  describe('singleMatchStrength', () => {
    it('returns 100 on full overlap, 50 on core-only, 0 otherwise', () => {
      // full overlap
      expect(singleMatchStrength('stay', 'stay', 'stay', 'stay')).toBe(100);
      // core-only: full titles differ, cores match
      expect(singleMatchStrength('stay feat justin bieber', 'stay', 'stay', 'stay')).toBe(50);
      // no overlap
      expect(singleMatchStrength('chandelier', 'chandelier', 'elastic heart', 'elastic heart')).toBe(0);
    });
  });

  describe('buildSkewedQueries', () => {
    it('adds a qualifier-stripped title variant for parenthetical titles', () => {
      const base = ['Kygo Stay (feat. Justin Bieber)', 'Kygo - Stay (feat. Justin Bieber)'];
      const skewed = buildSkewedQueries('Kygo', 'Stay (feat. Justin Bieber)', base);
      expect(skewed).toContain('Kygo Stay');
      expect(skewed).toContain('Stay');
    });

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

    it('fires skewed queries on a weak (non-empty) base and merges results', async () => {
      // Base surfaces only a thin 33% partial; the complete album hides behind a
      // soft-banned phrase and is reachable via the album-only skew variant.
      const partial: StubResponse = {
        username: 'pete',
        files: [{ filename: 'Music/Artist/Album/01 Song One.flac', size: 1 }],
      };
      const slskd = makeQueryAwareSlskdStub({
        'Artist Album': [partial],
        Album: [fullAlbum],
      });

      const hunter = new AlbumHunterService(slskd);
      const candidates = await hunter.hunt('Artist', 'Album', TRACKS, { skewSearch: true });

      // Both the weak base folder and the complete skew folder are present.
      expect(candidates).toHaveLength(2);
      expect(candidates[0].username).toBe('zoe');
      expect(candidates[0].matchPct).toBe(100);

      const created = (slskd.searches.create as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0],
      );
      expect(created).toContain('Album');
    });

    it('de-dupes a folder seen in both base and skew, keeping the higher score', async () => {
      // Same peer/folder appears in the base (only 1 file → 33%) and in the skew
      // (all 3 files → 100%); the merged result keeps a single 100% candidate.
      const samePartial: StubResponse = {
        username: 'zoe',
        files: [{ filename: 'Music/Artist/Album/01 Song One.flac', size: 1 }],
      };
      const slskd = makeQueryAwareSlskdStub({
        'Artist Album': [samePartial],
        Album: [fullAlbum],
      });

      const hunter = new AlbumHunterService(slskd);
      const candidates = await hunter.hunt('Artist', 'Album', TRACKS, { skewSearch: true });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].matchPct).toBe(100);
    });

    it('does not fire skewed queries when the base is already strong', async () => {
      const slskd = makeQueryAwareSlskdStub({ 'Artist Album': [fullAlbum] });

      const hunter = new AlbumHunterService(slskd);
      const candidates = await hunter.hunt('Artist', 'Album', TRACKS, { skewSearch: true });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].matchPct).toBe(100);
      const created = (slskd.searches.create as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0],
      );
      expect(created).toEqual(['Artist Album', 'Artist - Album']);
    });
  });
});
