import { describe, it, expect, mock } from 'bun:test';
import type { Lidarr, LidarrArtist, LidarrRootFolder } from '../lidarr/index.js';
import {
  LIDARR_METADATA_ROOT_DEFAULT,
  ensureArtistRootFolder,
  isolateLidarrRoot,
  pathsOverlap,
  pickArtistRootFolder,
  resolveLidarrMetadataRoot,
} from './lidarr-root';

const MUSIC = '/data/music';
const META = '/config/nicotind-metadata';
const policy = { metadataRoot: META, musicDir: MUSIC };

function root(id: number, path: string): LidarrRootFolder {
  return { id, path, freeSpace: 0 };
}

function artist(id: number, path: string): LidarrArtist {
  return {
    id,
    foreignArtistId: `mb-${id}`,
    artistName: `Artist ${id}`,
    sortName: `Artist ${id}`,
    status: 'continuing',
    images: [],
    monitored: true,
    path,
  };
}

/** A Lidarr double whose root folders and artists are live state, so a read-back sees writes. */
function makeLidarr(opts: {
  roots?: LidarrRootFolder[];
  artists?: LidarrArtist[];
  addFails?: boolean;
}) {
  const roots = [...(opts.roots ?? [])];
  const artists = [...(opts.artists ?? [])];
  const addRootFolder = mock(async (path: string) => {
    if (opts.addFails) throw new Error('Lidarr request failed: 400 /api/v1/rootfolder');
    const added = root(100 + roots.length, path);
    roots.push(added);
    return added;
  });
  const reassignRootFolder = mock(async (ids: number[], rootFolderPath: string) => {
    for (const a of artists) {
      if (ids.includes(a.id)) a.path = `${rootFolderPath}/${a.artistName}`;
    }
  });
  const deleteRootFolder = mock(async (id: number) => {
    const i = roots.findIndex((r) => r.id === id);
    if (i >= 0) roots.splice(i, 1);
  });
  const lidarr = {
    artist: {
      getRootFolders: mock(async () => [...roots]),
      list: mock(async () => artists.map((a) => ({ ...a }))),
      addRootFolder,
      reassignRootFolder,
      deleteRootFolder,
    },
  } as unknown as Lidarr;
  return { lidarr, roots, addRootFolder, reassignRootFolder, deleteRootFolder };
}

describe('pathsOverlap', () => {
  it('treats equal, ancestor and descendant paths as overlapping', () => {
    expect(pathsOverlap('/data/music', '/data/music')).toBe(true);
    expect(pathsOverlap('/data/music/', '/data/music')).toBe(true);
    expect(pathsOverlap('/data', '/data/music')).toBe(true);
    expect(pathsOverlap('/data/music/Queen', '/data/music')).toBe(true);
  });

  it('does not confuse a shared name prefix with containment', () => {
    expect(pathsOverlap('/data/music2', '/data/music')).toBe(false);
    expect(pathsOverlap('/config/nicotind-metadata', '/data/music')).toBe(false);
  });
});

describe('resolveLidarrMetadataRoot', () => {
  it('honours an explicit setting', () => {
    expect(resolveLidarrMetadataRoot({ mode: 'external', dataDir: '/d', rootFolder: '/x' })).toBe(
      '/x',
    );
  });

  it('defaults to a path inside the Lidarr container in external mode', () => {
    expect(resolveLidarrMetadataRoot({ mode: 'external', dataDir: '/d' })).toBe(
      LIDARR_METADATA_ROOT_DEFAULT,
    );
  });

  it('defaults under the data dir in embedded mode, where Lidarr shares our filesystem', () => {
    expect(resolveLidarrMetadataRoot({ mode: 'embedded', dataDir: '/d' })).toBe(
      '/d/lidarr-metadata',
    );
  });
});

describe('pickArtistRootFolder', () => {
  it('prefers the metadata root', () => {
    expect(pickArtistRootFolder([root(1, '/other'), root(2, META)], policy)).toBe(META);
  });

  it('accepts a root the operator keeps apart from the library', () => {
    expect(pickArtistRootFolder([root(1, MUSIC), root(2, '/srv/lidarr')], policy)).toBe(
      '/srv/lidarr',
    );
  });

  it('never picks a root that overlaps the music library', () => {
    expect(pickArtistRootFolder([root(1, MUSIC), root(2, '/data')], policy)).toBeNull();
  });
});

describe('ensureArtistRootFolder', () => {
  it('registers the metadata root rather than the music dir on a fresh Lidarr (#1580)', async () => {
    const { lidarr, addRootFolder } = makeLidarr({ roots: [] });

    const result = await ensureArtistRootFolder(lidarr, policy);

    expect(result.path).toBe(META);
    expect(addRootFolder).toHaveBeenCalledTimes(1);
    expect(addRootFolder.mock.calls[0]?.[0]).toBe(META);
  });

  it('registers the metadata root when the only root is the music library', async () => {
    const { lidarr, addRootFolder } = makeLidarr({ roots: [root(1, MUSIC)] });

    const result = await ensureArtistRootFolder(lidarr, policy);

    expect(result.path).toBe(META);
    expect(addRootFolder.mock.calls[0]?.[0]).toBe(META);
    expect(result.overlapping.map((r) => r.path)).toEqual([MUSIC]);
  });

  it('falls back to an overlapping root when the metadata root cannot be registered', async () => {
    const { lidarr } = makeLidarr({ roots: [root(1, MUSIC)], addFails: true });

    const result = await ensureArtistRootFolder(lidarr, policy);

    expect(result.path).toBe(MUSIC);
  });

  it('fails with the fix in the message when there is no root at all to fall back to', async () => {
    const { lidarr } = makeLidarr({ roots: [], addFails: true });

    await expect(ensureArtistRootFolder(lidarr, policy)).rejects.toThrow(
      /nicotind-metadata.*mount/i,
    );
  });
});

describe('isolateLidarrRoot', () => {
  it('reports without writing anything on a dry run', async () => {
    const { lidarr, addRootFolder, reassignRootFolder, deleteRootFolder } = makeLidarr({
      roots: [root(1, MUSIC)],
      artists: [artist(1, `${MUSIC}/Queen`), artist(2, `${MUSIC}/Low`)],
    });

    const report = await isolateLidarrRoot(lidarr, policy, { apply: false });

    expect(report.applied).toBe(false);
    expect(report.artistsToMove).toBe(2);
    expect(report.overlappingRoots).toEqual([MUSIC]);
    expect(addRootFolder).not.toHaveBeenCalled();
    expect(reassignRootFolder).not.toHaveBeenCalled();
    expect(deleteRootFolder).not.toHaveBeenCalled();
  });

  it('moves every artist off the library root, then removes that root', async () => {
    const artists = Array.from({ length: 250 }, (_, i) => artist(i + 1, `${MUSIC}/A${i}`));
    const { lidarr, roots, reassignRootFolder, deleteRootFolder } = makeLidarr({
      roots: [root(1, MUSIC)],
      artists,
    });

    const report = await isolateLidarrRoot(lidarr, policy, { apply: true });

    expect(report.moved).toBe(250);
    expect(report.remaining).toBe(0);
    // Chunked, and always to the metadata root.
    expect(reassignRootFolder.mock.calls.length).toBe(3);
    for (const call of reassignRootFolder.mock.calls) expect(call[1]).toBe(META);
    expect(deleteRootFolder).toHaveBeenCalledWith(1);
    expect(roots.map((r) => r.path)).toEqual([META]);
    expect(report.removedRoots).toEqual([MUSIC]);
  });

  it('keeps the library root while any artist still lives under it', async () => {
    const { lidarr, deleteRootFolder, reassignRootFolder } = makeLidarr({
      roots: [root(1, MUSIC)],
      artists: [artist(1, `${MUSIC}/Queen`)],
    });
    // Lidarr accepted the request but left the path alone.
    reassignRootFolder.mockImplementation(async () => {});

    const report = await isolateLidarrRoot(lidarr, policy, { apply: true });

    expect(report.remaining).toBe(1);
    expect(deleteRootFolder).not.toHaveBeenCalled();
    expect(report.removedRoots).toEqual([]);
  });

  it('refuses to move anything when the metadata root cannot be registered', async () => {
    const { lidarr, reassignRootFolder } = makeLidarr({
      roots: [root(1, MUSIC)],
      artists: [artist(1, `${MUSIC}/Queen`)],
      addFails: true,
    });

    await expect(isolateLidarrRoot(lidarr, policy, { apply: true })).rejects.toThrow(/mount/i);
    expect(reassignRootFolder).not.toHaveBeenCalled();
  });
});
