import { describe, it, expect, mock } from 'bun:test';
import type { Lidarr, LidarrArtist } from '@nicotind/lidarr-client';
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
    async (artist: LidarrArtist, _qualityProfileId: number, _rootFolderPath: string, _metadataProfileId: number) => ({
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

    const result = await addArtistFromLookup(lidarr, makeArtist(), '/fallback');

    expect(result.id).toBe(42);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[2]).toBe('/music'); // rootFolderPath
    expect(addRootFolder).not.toHaveBeenCalled();
  });

  it('auto-provisions a root folder from musicDir when none exists', async () => {
    const { lidarr, add, addRootFolder } = makeLidarr({ rootFolders: [] });

    await addArtistFromLookup(lidarr, makeArtist(), '/data/music');

    expect(addRootFolder).toHaveBeenCalledWith('/data/music');
    expect(add.mock.calls[0]?.[2]).toBe('/data/music');
  });

  it('throws when no root folder exists and no musicDir is given', async () => {
    const { lidarr } = makeLidarr({ rootFolders: [] });
    await expect(addArtistFromLookup(lidarr, makeArtist())).rejects.toThrow(/no root folders/i);
  });

  it('throws when no quality profile is configured', async () => {
    const { lidarr } = makeLidarr({ qualityProfiles: [], rootFolders: [{ id: 1, path: '/m', freeSpace: 0 }] });
    await expect(addArtistFromLookup(lidarr, makeArtist())).rejects.toThrow(/quality profiles/i);
  });
});
