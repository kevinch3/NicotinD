import { describe, it, expect, mock } from 'bun:test';
import type { Slskd } from '@nicotind/slskd-client';
import type { LidarrTrack } from '@nicotind/lidarr-client';
import { AlbumHunterService } from './album-hunter.service';

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

/** slskd stub that returns a fixed set of responses, already "complete". */
function makeSlskdStub(responses: Array<{ username: string; files: StubFile[] }>) {
  return {
    searches: {
      create: mock(async (q: string) => ({ id: `s-${q}`, state: 'Completed' })),
      get: mock(async () => ({ state: 'Completed' })),
      getResponses: mock(async () => responses),
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
});
