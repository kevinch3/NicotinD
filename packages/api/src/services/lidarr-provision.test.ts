import { describe, it, expect, mock } from 'bun:test';
import type { Lidarr, LidarrArtist } from '../lidarr/index.js';
import { addArtistFromLookup } from './lidarr-provision';

function makeArtist(over: Partial<LidarrArtist> = {}): LidarrArtist {
  return {
    id: 0,
    foreignArtistId: 'mbid-x',
    artistName: 'Test Artist',
    sortName: 'Test Artist',
    status: 'continuing',
    images: [],
    monitored: true,
    ...over,
  };
}

function makeLidarr(opts: {
  qualityProfiles?: Array<{ id: number; name: string }>;
  metadataProfiles?: Array<{ id: number; name: string }>;
  rootFolders?: Array<{ id: number; path: string; freeSpace: number }>;
}) {
  const add = mock(
    async (
      artist: LidarrArtist,
      _qualityProfileId: number,
      _rootFolderPath: string,
      _metadataProfileId: number,
    ) => ({
      ...artist,
      id: 42,
    }),
  );
  const addRootFolder = mock(async (path: string) => ({ id: 9, path, freeSpace: 0 }));
  const lidarr = {
    artist: {
      getQualityProfiles: mock(async () => opts.qualityProfiles ?? [{ id: 1, name: 'Any' }]),
      getMetadataProfiles: mock(async () => opts.metadataProfiles ?? [{ id: 1, name: 'Standard' }]),
      getRootFolders: mock(async () => opts.rootFolders ?? []),
      add,
      addRootFolder,
    },
  } as unknown as Lidarr;
  return { lidarr, add, addRootFolder };
}

describe('addArtistFromLookup', () => {
  it('adds the artist using existing profiles and root folder', async () => {
    const { lidarr, add, addRootFolder } = makeLidarr({
      rootFolders: [{ id: 1, path: '/music', freeSpace: 0 }],
    });

    const result = await addArtistFromLookup(lidarr, makeArtist(), {
      metadataRoot: '/config/nicotind-metadata',
      musicDir: '/data/music',
    });

    expect(result.id).toBe(42);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[2]).toBe('/music'); // rootFolderPath
    expect(addRootFolder).not.toHaveBeenCalled();
  });

  it('registers the metadata root, never the music library, when none exists (#1580)', async () => {
    const { lidarr, add, addRootFolder } = makeLidarr({ rootFolders: [] });

    await addArtistFromLookup(lidarr, makeArtist(), {
      metadataRoot: '/config/nicotind-metadata',
      musicDir: '/data/music',
    });

    expect(addRootFolder.mock.calls[0]?.[0]).toBe('/config/nicotind-metadata');
    expect(add.mock.calls[0]?.[2]).toBe('/config/nicotind-metadata');
  });

  it('does not add under a root that overlaps the music library when the metadata root is free', async () => {
    const { lidarr, add } = makeLidarr({
      rootFolders: [{ id: 1, path: '/data/music', freeSpace: 0 }],
    });

    await addArtistFromLookup(lidarr, makeArtist(), {
      metadataRoot: '/config/nicotind-metadata',
      musicDir: '/data/music',
    });

    expect(add.mock.calls[0]?.[2]).toBe('/config/nicotind-metadata');
  });

  it('throws when no quality profile is configured', async () => {
    const { lidarr } = makeLidarr({
      qualityProfiles: [],
      rootFolders: [{ id: 1, path: '/m', freeSpace: 0 }],
    });
    await expect(addArtistFromLookup(lidarr, makeArtist())).rejects.toThrow(/quality profiles/i);
  });
});
