import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { cleanFolderName, groupByDirectory, ALL_SINGLES, AutoPlaylistService, normalizeSongPath } from './auto-playlist.service.js';
import type { CompletedDownloadFile } from './metadata-fixer.js';

describe('constants', () => {
  it('exports ALL_SINGLES as "All Singles"', () => {
    expect(ALL_SINGLES).toBe('All Singles');
  });
});

describe('cleanFolderName', () => {
  it('strips bracketed quality tags', () => {
    expect(cleanFolderName('Dua Lipa - Future Nostalgia (2020) [FLAC 320kbps]')).toBe(
      'Dua Lipa - Future Nostalgia (2020)',
    );
  });

  it('strips [MP3 V0] tag and extracts leaf from backslash path', () => {
    expect(cleanFolderName('Artist\\EP Name [MP3 V0]')).toBe('EP Name');
  });

  it('strips standalone (FLAC) parens but preserves year parens', () => {
    expect(cleanFolderName('Downloads\\Some Album (2019) (FLAC)')).toBe('Some Album (2019)');
  });

  it('strips standalone (MP3) parens', () => {
    expect(cleanFolderName('Downloads\\Some Album (MP3)')).toBe('Some Album');
  });

  it('extracts leaf segment from a forward-slash path', () => {
    expect(cleanFolderName('Music/Artist/Album Name [WEB]')).toBe('Album Name');
  });

  it('passes through an already-clean name unchanged', () => {
    expect(cleanFolderName('Clean Album Name')).toBe('Clean Album Name');
  });

  it('falls back to raw input when result would be empty', () => {
    expect(cleanFolderName('[FLAC]')).toBe('[FLAC]');
  });
});

describe('groupByDirectory', () => {
  it('puts a single file in its own group', () => {
    const files: CompletedDownloadFile[] = [
      { username: 'u', directory: 'dir1', filename: 'song.mp3' },
    ];
    const groups = groupByDirectory(files);
    expect(groups.size).toBe(1);
    expect(groups.get('dir1')).toHaveLength(1);
  });

  it('groups multiple files from the same directory together', () => {
    const files: CompletedDownloadFile[] = [
      { username: 'u', directory: 'dir1', filename: 'a.mp3' },
      { username: 'u', directory: 'dir1', filename: 'b.mp3' },
    ];
    const groups = groupByDirectory(files);
    expect(groups.size).toBe(1);
    expect(groups.get('dir1')).toHaveLength(2);
  });

  it('splits a mixed batch into separate groups', () => {
    const files: CompletedDownloadFile[] = [
      { username: 'u', directory: 'dir1', filename: 'a.mp3' },
      { username: 'u', directory: 'dir2', filename: 'b.mp3' },
      { username: 'u', directory: 'dir2', filename: 'c.mp3' },
    ];
    const groups = groupByDirectory(files);
    expect(groups.size).toBe(2);
    expect(groups.get('dir1')).toHaveLength(1);
    expect(groups.get('dir2')).toHaveLength(2);
  });
});

describe('normalizeSongPath', () => {
  it('strips the music dir prefix from an absolute Navidrome path', () => {
    expect(normalizeSongPath('/data/music', '/data/music/Music/Artist/Track.mp3'))
      .toBe('music/artist/track.mp3');
  });

  it('handles a trailing slash on musicDir', () => {
    expect(normalizeSongPath('/data/music/', '/data/music/Music/Track.mp3'))
      .toBe('music/track.mp3');
  });

  it('returns the normalized path unchanged when prefix is absent', () => {
    expect(normalizeSongPath('/data/music', 'relative/path/Track.mp3'))
      .toBe('relative/path/track.mp3');
  });

  it('normalizes backslashes', () => {
    expect(normalizeSongPath('/data/music', '/data/music/Music\\Artist\\Track.mp3'))
      .toBe('music/artist/track.mp3');
  });
});

// Helper: build a minimal Song-shaped object for mocks
function makeSong(id: string, path: string) {
  return {
    id,
    path,
    title: id,
    artist: '',
    album: '',
    albumId: '',
    artistId: '',
    size: 0,
    contentType: '',
    suffix: '',
    duration: 0,
    bitRate: 0,
    created: '',
  };
}

type Song = ReturnType<typeof makeSong>;
type PlaylistShort = { id: string; name: string; songCount: number; entry?: Song[] };
type AlbumShort = { id: string; name: string };

function makeNavidromeMock() {
  return {
    system: {
      getScanStatus: mock(() => Promise.resolve({ scanning: false, count: 0 })),
    },
    playlists: {
      list: mock((): Promise<PlaylistShort[]> => Promise.resolve([])),
      create: mock((name: string): Promise<PlaylistShort> =>
        Promise.resolve({ id: `id-${name}`, name, songCount: 0, entry: [] }),
      ),
      get: mock((id: string): Promise<{ id: string; name: string; entry: Song[] }> =>
        Promise.resolve({ id, name: '', entry: [] }),
      ),
      update: mock(() => Promise.resolve()),
    },
    search: {
      search3: mock((): Promise<{ song: Song[]; artist: unknown[]; album: unknown[] }> =>
        Promise.resolve({ song: [], artist: [], album: [] }),
      ),
    },
    browsing: {
      getAlbum: mock((): Promise<{ album: Record<string, unknown>; songs: Song[] }> =>
        Promise.resolve({ album: {} as Record<string, unknown>, songs: [] }),
      ),
      getAlbumList: mock((): Promise<AlbumShort[]> => Promise.resolve([])),
    },
  };
}

describe('AutoPlaylistService.processBatch', () => {
  let navidromeMock: ReturnType<typeof makeNavidromeMock>;
  let service: AutoPlaylistService;

  beforeEach(() => {
    navidromeMock = makeNavidromeMock();
    // Pass scanTimeoutMs=0 so waitForScan returns immediately in tests
    service = new AutoPlaylistService(navidromeMock as unknown as ConstructorParameters<typeof AutoPlaylistService>[0], '', 0);
  });

  it('does nothing for an empty batch', async () => {
    await service.processBatch([]);
    expect(navidromeMock.playlists.list).not.toHaveBeenCalled();
  });

  it('adds a single-file download to "All Singles"', async () => {
    navidromeMock.search.search3.mockReturnValue(
      Promise.resolve({ song: [makeSong('song-1', 'dir1/song.mp3')], artist: [], album: [] }),
    );

    await service.processBatch([{ username: 'u', directory: 'dir1', filename: 'song.mp3' }]);

    expect(navidromeMock.playlists.create).toHaveBeenCalledWith(ALL_SINGLES);
    expect(navidromeMock.playlists.update).toHaveBeenCalledWith(`id-${ALL_SINGLES}`, {
      songIdsToAdd: ['song-1'],
    });
  });

  it('uses folder playlist naming when one completed file comes from a multi-file directory', async () => {
    navidromeMock.search.search3.mockReturnValue(
      Promise.resolve({ song: [makeSong('song-1', 'Artist - Album/song.mp3')], artist: [], album: [] }),
    );

    await service.processBatch([
      {
        username: 'u',
        directory: 'Music\\Artist - Album [FLAC]',
        filename: 'song.mp3',
        directoryFileCount: 12,
      },
    ]);

    expect(navidromeMock.playlists.create).toHaveBeenCalledWith('Artist - Album');
    expect(navidromeMock.playlists.update).toHaveBeenCalledWith('id-Artist - Album', {
      songIdsToAdd: ['song-1'],
    });
  });

  it('creates a named playlist (with cleaned name) for a multi-file directory', async () => {
    navidromeMock.search.search3
      .mockReturnValueOnce(
        Promise.resolve({ song: [makeSong('s1', 'dir/a.mp3')], artist: [], album: [] }),
      )
      .mockReturnValueOnce(
        Promise.resolve({ song: [makeSong('s2', 'dir/b.mp3')], artist: [], album: [] }),
      );

    await service.processBatch([
      { username: 'u', directory: 'Music\\Artist - Album [FLAC]', filename: 'a.mp3' },
      { username: 'u', directory: 'Music\\Artist - Album [FLAC]', filename: 'b.mp3' },
    ]);

    expect(navidromeMock.playlists.create).toHaveBeenCalledWith('Artist - Album');
    expect(navidromeMock.playlists.update).toHaveBeenCalledWith('id-Artist - Album', {
      songIdsToAdd: ['s1', 's2'],
    });
  });

  it('appends to an existing playlist without re-adding duplicates', async () => {
    navidromeMock.playlists.list.mockReturnValue(
      Promise.resolve([{ id: 'existing-id', name: ALL_SINGLES, songCount: 1 }]),
    );
    // Playlist already contains 'old-song'
    navidromeMock.playlists.get.mockReturnValue(
      Promise.resolve({ id: 'existing-id', name: ALL_SINGLES, entry: [makeSong('old-song', 'x.mp3')] }),
    );
    // New file resolves to a different song ID
    navidromeMock.search.search3.mockReturnValue(
      Promise.resolve({ song: [makeSong('new-song', 'dir/new.mp3')], artist: [], album: [] }),
    );

    await service.processBatch([{ username: 'u', directory: 'dir', filename: 'new.mp3' }]);

    expect(navidromeMock.playlists.create).not.toHaveBeenCalled();
    expect(navidromeMock.playlists.update).toHaveBeenCalledWith('existing-id', {
      songIdsToAdd: ['new-song'],
    });
  });

  it('prefers relative-path matches over basename collisions via path index', async () => {
    // buildPathIndex: search3("Album") returns one album
    navidromeMock.search.search3.mockReturnValueOnce(
      Promise.resolve({ song: [], artist: [], album: [{ id: 'album-id', name: 'Album' }] }),
    );
    // buildPathIndex: getAlbum returns the target song at the correct path
    navidromeMock.browsing.getAlbum.mockReturnValueOnce(
      Promise.resolve({
        album: { id: 'album-id', name: 'Album' },
        songs: [
          makeSong('wrong-id', 'Other Artist/Other Album/song.mp3'),
          makeSong('right-id', 'Artist/Album/song.mp3'),
        ],
      }),
    );
    // resolveSongId hits the index fast path — search3 should NOT be called again
    await service.processBatch([
      {
        username: 'u',
        directory: 'Artist\\Album',
        filename: 'song.mp3',
        relativePath: 'Artist/Album/song.mp3',
      },
    ]);

    expect(navidromeMock.playlists.update).toHaveBeenCalledWith(`id-${ALL_SINGLES}`, {
      songIdsToAdd: ['right-id'],
    });
    // Verify fast path: only one search3 call (the album lookup), no per-song text search
    expect(navidromeMock.search.search3).toHaveBeenCalledTimes(1);
  });

  it('buildPathIndex calls getAlbum once per unique album and resolves both songs', async () => {
    // Two tracks from the same album — getAlbum should be called exactly once
    navidromeMock.search.search3.mockReturnValueOnce(
      Promise.resolve({ song: [], artist: [], album: [{ id: 'album-id', name: 'The Album' }] }),
    );
    navidromeMock.browsing.getAlbum.mockReturnValueOnce(
      Promise.resolve({
        album: { id: 'album-id', name: 'The Album' },
        songs: [
          makeSong('s1', 'Artist/The Album/track1.mp3'),
          makeSong('s2', 'Artist/The Album/track2.mp3'),
        ],
      }),
    );

    await service.processBatch([
      {
        username: 'u',
        directory: 'Artist\\The Album',
        filename: 'track1.mp3',
        relativePath: 'Artist/The Album/track1.mp3',
        directoryFileCount: 2,
      },
      {
        username: 'u',
        directory: 'Artist\\The Album',
        filename: 'track2.mp3',
        relativePath: 'Artist/The Album/track2.mp3',
        directoryFileCount: 2,
      },
    ]);

    // getAlbum called once for the two files sharing the same album directory
    expect(navidromeMock.browsing.getAlbum).toHaveBeenCalledTimes(1);
    // Both songs should be added to the folder playlist
    expect(navidromeMock.playlists.create).toHaveBeenCalledWith('The Album');
    expect(navidromeMock.playlists.update).toHaveBeenCalledWith('id-The Album', {
      songIdsToAdd: ['s1', 's2'],
    });
    // No per-song text search needed — index covered everything
    expect(navidromeMock.search.search3).toHaveBeenCalledTimes(1);
  });

  it('resolves songs via recent-album basename index when relativePath is absent', async () => {
    // No relativePath → buildPathIndex returns empty.
    // buildRecentSongIndex finds the song by basename in the newest album.
    navidromeMock.browsing.getAlbumList.mockReturnValueOnce(
      Promise.resolve([{ id: 'recent-album', name: 'Recent Album' }]),
    );
    navidromeMock.browsing.getAlbum.mockReturnValueOnce(
      Promise.resolve({
        album: { id: 'recent-album', name: 'Recent Album' },
        songs: [makeSong('found-id', '/data/music/Artist/Album/track.flac')],
      }),
    );

    await service.processBatch([
      { username: 'u', directory: 'Artist\\Album', filename: 'track.flac' },
    ]);

    expect(navidromeMock.playlists.create).toHaveBeenCalledWith(ALL_SINGLES);
    expect(navidromeMock.playlists.update).toHaveBeenCalledWith(`id-${ALL_SINGLES}`, {
      songIdsToAdd: ['found-id'],
    });
    // search3 should NOT be called — recent index resolved the song
    expect(navidromeMock.search.search3).not.toHaveBeenCalled();
  });

  it('disambiguates basename collisions in recent index using relativePath', async () => {
    // Two different albums both have a file named "01-track.flac".
    // Without disambiguation the wrong song could end up in the wrong playlist,
    // causing both playlists to show the same cover art.
    navidromeMock.browsing.getAlbumList.mockReturnValueOnce(
      Promise.resolve([
        { id: 'album-a', name: 'Album A' },
        { id: 'album-b', name: 'Album B' },
      ]),
    );
    navidromeMock.browsing.getAlbum
      .mockReturnValueOnce(
        Promise.resolve({
          album: { id: 'album-a' },
          songs: [makeSong('song-a', 'Artist/Album A/01-track.flac')],
        }),
      )
      .mockReturnValueOnce(
        Promise.resolve({
          album: { id: 'album-b' },
          songs: [makeSong('song-b', 'Artist/Album B/01-track.flac')],
        }),
      );

    // Two playlists: one for Album A, one for Album B — both files share the same basename.
    await service.processBatch([
      {
        username: 'u',
        directory: 'Artist\\Album A',
        filename: '01-track.flac',
        relativePath: 'Artist/Album A/01-track.flac',
        directoryFileCount: 1,
      },
      {
        username: 'u',
        directory: 'Artist\\Album B',
        filename: '01-track.flac',
        relativePath: 'Artist/Album B/01-track.flac',
        directoryFileCount: 1,
      },
    ]);

    // Each playlist must get its own (correct) song, not both getting the same one.
    const updateCalls = (navidromeMock.playlists.update as ReturnType<typeof mock>).mock.calls as Array<[string, { songIdsToAdd: string[] }]>;
    const addedIds = updateCalls.flatMap((c) => c[1].songIdsToAdd);
    expect(addedIds).toContain('song-a');
    expect(addedIds).toContain('song-b');
    // search3 is called by buildPathIndex (album name lookup) but NOT for per-song text search.
    // With 2 unique album dirs the path index makes exactly 2 search3 calls.
    expect(navidromeMock.search.search3).toHaveBeenCalledTimes(2);
  });

  it('does not call update when resolved song is already in the playlist', async () => {
    navidromeMock.playlists.list.mockReturnValue(
      Promise.resolve([{ id: 'pl-id', name: ALL_SINGLES, songCount: 1 }]),
    );
    navidromeMock.playlists.get.mockReturnValue(
      Promise.resolve({ id: 'pl-id', name: ALL_SINGLES, entry: [makeSong('already-here', 'dir/song.mp3')] }),
    );
    navidromeMock.search.search3.mockReturnValue(
      Promise.resolve({ song: [makeSong('already-here', 'dir/song.mp3')], artist: [], album: [] }),
    );

    await service.processBatch([{ username: 'u', directory: 'dir', filename: 'song.mp3' }]);

    expect(navidromeMock.playlists.update).not.toHaveBeenCalled();
  });

  it('skips unresolvable tracks but continues processing the rest', async () => {
    navidromeMock.search.search3
      .mockReturnValueOnce(Promise.resolve({ song: [], artist: [], album: [] })) // a.mp3 not found
      .mockReturnValueOnce(
        Promise.resolve({ song: [makeSong('s2', 'dir/b.mp3')], artist: [], album: [] }),
      );

    await service.processBatch([
      { username: 'u', directory: 'dir', filename: 'a.mp3' },
      { username: 'u', directory: 'dir', filename: 'b.mp3' },
    ]);

    // Only b.mp3 found — should still be added
    expect(navidromeMock.playlists.update).toHaveBeenCalledWith('id-dir', {
      songIdsToAdd: ['s2'],
    });
  });

  it('does not create a playlist when no song IDs resolve', async () => {
    navidromeMock.search.search3.mockReturnValue(
      Promise.resolve({ song: [], artist: [], album: [] }),
    );

    await service.processBatch([{ username: 'u', directory: 'dir', filename: 'missing.mp3' }]);

    expect(navidromeMock.playlists.create).not.toHaveBeenCalled();
    expect(navidromeMock.playlists.update).not.toHaveBeenCalled();
  });

  it('aborts the batch if listing playlists fails', async () => {
    navidromeMock.playlists.list.mockReturnValue(Promise.reject(new Error('API down')));

    await expect(
      service.processBatch([{ username: 'u', directory: 'dir', filename: 'song.mp3' }]),
    ).resolves.toBeUndefined(); // must not throw

    expect(navidromeMock.playlists.create).not.toHaveBeenCalled();
  });

  it('skips a group when playlist creation fails but continues other groups', async () => {
    // All Singles create fails; Good Album create succeeds
    navidromeMock.playlists.create
      .mockReturnValueOnce(Promise.reject(new Error('quota exceeded')))
      .mockReturnValueOnce(
        Promise.resolve({ id: 'folder-id', name: 'Good Album', songCount: 0, entry: [] }),
      );
    // One search call for single-dir + two for the folder group.
    navidromeMock.search.search3
      .mockReturnValueOnce(
        Promise.resolve({ song: [makeSong('single', 'single-dir/single.mp3')], artist: [], album: [] }),
      )
      .mockReturnValueOnce(
        Promise.resolve({ song: [makeSong('s1', 'folder/a.mp3')], artist: [], album: [] }),
      )
      .mockReturnValueOnce(
        Promise.resolve({ song: [makeSong('s2', 'folder/b.mp3')], artist: [], album: [] }),
      );

    await expect(
      service.processBatch([
        { username: 'u', directory: 'single-dir', filename: 'single.mp3' },
        { username: 'u', directory: 'Good Album', filename: 'a.mp3' },
        { username: 'u', directory: 'Good Album', filename: 'b.mp3' },
      ]),
    ).resolves.toBeUndefined();

    // The folder group should still be processed despite All Singles failing
    expect(navidromeMock.playlists.create).toHaveBeenCalledWith('Good Album');
    expect(navidromeMock.playlists.update).toHaveBeenCalledWith('folder-id', {
      songIdsToAdd: ['s1', 's2'],
    });
  });

  it('polls getScanStatus until scanning is false', async () => {
    navidromeMock.system.getScanStatus
      .mockReturnValueOnce(Promise.resolve({ scanning: true, count: 5 }))
      .mockReturnValueOnce(Promise.resolve({ scanning: false, count: 10 }));

    navidromeMock.search.search3.mockReturnValue(
      Promise.resolve({ song: [makeSong('s', 'dir/s.mp3')], artist: [], album: [] }),
    );

    // Use a positive timeout (2000ms) so the loop actually runs
    const pollService = new AutoPlaylistService(navidromeMock as unknown as ConstructorParameters<typeof AutoPlaylistService>[0], '', 2000);
    await pollService.processBatch([{ username: 'u', directory: 'dir', filename: 's.mp3' }]);

    expect(navidromeMock.system.getScanStatus).toHaveBeenCalledTimes(2);
    expect(navidromeMock.playlists.create).toHaveBeenCalled();
  });
});

// ── visibility rows ───────────────────────────────────────────────────────────

import { Database } from 'bun:sqlite';

describe('AutoPlaylistService.processBatch — playlist_visibility', () => {
  let navidromeMock: ReturnType<typeof makeNavidromeMock>;
  let visDb: Database;

  beforeEach(() => {
    visDb = new Database(':memory:');
    visDb.run(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    visDb.run(`
      CREATE TABLE playlist_visibility (
        playlist_id TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        visibility  TEXT NOT NULL DEFAULT 'personal'
                         CHECK (visibility IN ('personal', 'global'))
      )
    `);
    visDb.run("INSERT INTO users VALUES ('a1', 'admin', 'hash', 'admin', 'active', datetime('now'))");

    navidromeMock = makeNavidromeMock();
  });

  it('inserts a global visibility row when a new playlist is created', async () => {
    navidromeMock.search.search3.mockReturnValue(
      Promise.resolve({ song: [makeSong('song-1', 'dir1/song.mp3')], artist: [], album: [] }),
    );

    const svc = new AutoPlaylistService(navidromeMock as unknown as ConstructorParameters<typeof AutoPlaylistService>[0], '', 0, visDb, 'a1');
    await svc.processBatch([{ username: 'u', directory: 'dir1', filename: 'song.mp3' }]);

    const row = visDb
      .query<{ playlist_id: string; owner_id: string; visibility: string }, [string]>('SELECT * FROM playlist_visibility WHERE playlist_id = ?')
      .get(`id-${ALL_SINGLES}`);
    expect(row).not.toBeNull();
    expect(row!.visibility).toBe('global');
    expect(row!.owner_id).toBe('a1');
  });

  it('does not duplicate a visibility row for an already-existing playlist', async () => {
    // Playlist already exists in navidrome AND has a visibility row
    const playlistId = `id-${ALL_SINGLES}`;
    navidromeMock.playlists.list.mockReturnValue(
      Promise.resolve([{ id: playlistId, name: ALL_SINGLES, songCount: 0, entry: [] }]),
    );
    navidromeMock.playlists.get.mockReturnValue(
      Promise.resolve({ id: playlistId, name: ALL_SINGLES, entry: [] }),
    );
    visDb.run(
      "INSERT INTO playlist_visibility VALUES (?, 'a1', 'global')",
      [playlistId],
    );

    navidromeMock.search.search3.mockReturnValue(
      Promise.resolve({ song: [makeSong('song-1', 'dir1/song.mp3')], artist: [], album: [] }),
    );

    const svc = new AutoPlaylistService(navidromeMock as unknown as ConstructorParameters<typeof AutoPlaylistService>[0], '', 0, visDb, 'a1');
    await svc.processBatch([{ username: 'u', directory: 'dir1', filename: 'song.mp3' }]);

    const rows = visDb
      .query<{ playlist_id: string; owner_id: string; visibility: string }, [string]>('SELECT * FROM playlist_visibility WHERE playlist_id = ?')
      .all(playlistId);
    expect(rows).toHaveLength(1); // still just one row
  });
});
