import {
  extractDirectory,
  groupByDirectory,
  buildFolderTree,
  getDirectFiles,
  formatPeerInfo,
  rankFolders,
  dedupeFolders,
  folderFormat,
  fileQualityLabel,
  folderBasename,
  type FolderGroup,
} from './folder-utils';

function folder(over: Partial<FolderGroup> & { directory: string }): FolderGroup {
  return {
    username: 'peer',
    uploadSpeed: 1_000_000,
    files: [],
    ...over,
  };
}
const f = (filename: string, bitRate?: number) => ({ filename, size: 1, bitRate });

describe('extractDirectory', () => {
  it('extracts the directory from a backslash-separated path', () => {
    expect(extractDirectory('Music\\Artist\\Album\\01.mp3')).toBe('Music\\Artist\\Album');
  });

  it('returns empty string for a bare filename', () => {
    expect(extractDirectory('song.mp3')).toBe('');
  });
});

describe('groupByDirectory', () => {
  it('groups files by their directory path', () => {
    const files = [
      { username: 'alice', uploadSpeed: 1000, filename: 'A\\B\\01.mp3', size: 100, bitRate: 320 },
      { username: 'alice', uploadSpeed: 1000, filename: 'A\\B\\02.mp3', size: 100, bitRate: 320 },
      { username: 'bob', uploadSpeed: 500, filename: 'A\\C\\01.mp3', size: 100, bitRate: 192 },
    ];
    const groups = groupByDirectory(files);
    expect(groups).toHaveLength(2);
    expect(groups[0].directory).toBe('A\\B');
    expect(groups[0].username).toBe('alice');
    expect(groups[0].files).toHaveLength(2);
  });
});

describe('buildFolderTree', () => {
  it('builds a nested tree from a flat directory list', () => {
    const dirs = [
      { name: 'Music', fileCount: 0, files: [] },
      { name: 'Music\\Artist', fileCount: 0, files: [] },
      {
        name: 'Music\\Artist\\Album',
        fileCount: 2,
        files: [
          { filename: 'Music\\Artist\\Album\\01.mp3', size: 100 },
          { filename: 'Music\\Artist\\Album\\02.mp3', size: 100 },
        ],
      },
    ];
    const tree = buildFolderTree(dirs);
    expect(tree).toHaveLength(1);
    expect(tree[0].segment).toBe('Music');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].segment).toBe('Artist');
  });
});

describe('formatPeerInfo', () => {
  it('formats speed, queue, and slots', () => {
    expect(formatPeerInfo({ uploadSpeed: 2_100_000, queueLength: 3, freeUploadSlots: 1 })).toBe(
      '↑ 2.1 MB/s · 3 queued · 1 slot',
    );
  });

  it('omits queued segment when queueLength is 0', () => {
    expect(formatPeerInfo({ uploadSpeed: 500_000, queueLength: 0, freeUploadSlots: 2 })).toBe(
      '↑ 500 KB/s · 2 slots',
    );
  });

  it('omits slots segment when freeUploadSlots is undefined', () => {
    expect(formatPeerInfo({ uploadSpeed: 1_000_000, queueLength: 1 })).toBe(
      '↑ 1.0 MB/s · 1 queued',
    );
  });

  it('uses singular slot when freeUploadSlots is 1', () => {
    expect(formatPeerInfo({ uploadSpeed: 300_000, freeUploadSlots: 1 })).toBe(
      '↑ 300 KB/s · 1 slot',
    );
  });

  it('uses plural slots when freeUploadSlots is 0', () => {
    expect(formatPeerInfo({ uploadSpeed: 300_000, freeUploadSlots: 0 })).toBe(
      '↑ 300 KB/s · 0 slots',
    );
  });
});

describe('getDirectFiles', () => {
  it('returns only files whose directory is the selected node path', () => {
    const dirs = [
      {
        name: 'Music\\Artist\\Album',
        fileCount: 2,
        files: [
          { filename: 'Music\\Artist\\Album\\01.mp3', size: 100 },
          { filename: 'Music\\Artist\\Album\\02.mp3', size: 100 },
        ],
      },
    ];
    const files = getDirectFiles(dirs, 'Music\\Artist\\Album');
    expect(files).toHaveLength(2);
  });

  it('does not include files from subdirectories', () => {
    const dirs = [
      {
        name: 'Music\\Artist',
        fileCount: 1,
        files: [{ filename: 'Music\\Artist\\01.mp3', size: 100 }],
      },
      {
        name: 'Music\\Artist\\Album',
        fileCount: 1,
        files: [{ filename: 'Music\\Artist\\Album\\01.mp3', size: 100 }],
      },
    ];
    const files = getDirectFiles(dirs, 'Music\\Artist');
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('Music\\Artist\\01.mp3');
  });
});

describe('folderFormat', () => {
  it('flags a lossless folder with the format label', () => {
    expect(folderFormat(folder({ directory: 'd', files: [f('a.flac'), f('b.flac')] }))).toEqual({
      label: 'FLAC',
      lossless: true,
    });
  });

  it('reports the max bitrate for an MP3 folder', () => {
    expect(
      folderFormat(folder({ directory: 'd', files: [f('a.mp3', 256), f('b.mp3', 320)] })),
    ).toEqual({ label: '320k', lossless: false });
  });

  it('ignores non-audio files and returns null when there is no audio', () => {
    expect(folderFormat(folder({ directory: 'd', files: [f('cover.jpg'), f('info.nfo')] }))).toBeNull();
  });
});

describe('fileQualityLabel', () => {
  it('shows the bitrate when known', () => {
    expect(fileQualityLabel(f('x.mp3', 320))).toBe('320 kbps');
  });

  it('falls back to the format when the bitrate is unknown (no more "Unknown bitrate" on FLAC)', () => {
    expect(fileQualityLabel(f('x.flac'))).toBe('FLAC');
    expect(fileQualityLabel({ filename: 'noext' })).toBe('Unknown');
  });
});

describe('rankFolders', () => {
  it('orders free-slot > lossless > more tracks > faster', () => {
    const queuedFlac = folder({ directory: 'qflac', freeUploadSlots: 0, files: [f('a.flac')] });
    const freeMp3 = folder({ directory: 'fmp3', freeUploadSlots: 2, files: [f('a.mp3', 320)] });
    const queuedMp3Big = folder({
      directory: 'qmp3big',
      freeUploadSlots: 0,
      files: [f('a.mp3', 320), f('b.mp3', 320)],
    });

    const ranked = rankFolders([queuedFlac, freeMp3, queuedMp3Big]).map((g) => g.directory);
    // free slot wins overall; among queued, lossless beats the bigger MP3 folder.
    expect(ranked).toEqual(['fmp3', 'qflac', 'qmp3big']);
  });

  it('does not mutate the input array', () => {
    const input = [folder({ directory: 'a' }), folder({ directory: 'b', freeUploadSlots: 1 })];
    const copy = [...input];
    rankFolders(input);
    expect(input).toEqual(copy);
  });
});

describe('folderBasename', () => {
  it('takes the last path segment (backslash or slash)', () => {
    expect(folderBasename('Music\\Zara Larsson\\Poster Girl')).toBe('Poster Girl');
    expect(folderBasename('a/b/c')).toBe('c');
  });
});

describe('dedupeFolders', () => {
  const flacPosterGirl = (user: string) =>
    folder({ username: user, directory: `x\\Poster Girl (2021)`, files: [f('01.flac'), f('02.flac')] });

  it('collapses identical copies across peers and counts the extras', () => {
    const out = dedupeFolders([flacPosterGirl('p1'), flacPosterGirl('p2'), flacPosterGirl('p3')]);
    expect(out).toHaveLength(1);
    expect(out[0].username).toBe('p1'); // first (best-ranked) kept
    expect(out[0].duplicatePeers).toBe(2); // two other peers had the same copy
  });

  it('keeps distinct editions (different track count) and formats apart', () => {
    const standard = folder({ username: 'a', directory: 'x\\Poster Girl', files: [f('1.flac'), f('2.flac')] });
    const deluxe = folder({ username: 'b', directory: 'x\\Poster Girl', files: [f('1.flac'), f('2.flac'), f('3.flac')] });
    const mp3 = folder({ username: 'c', directory: 'x\\Poster Girl', files: [f('1.mp3', 320), f('2.mp3', 320)] });
    const out = dedupeFolders([standard, deluxe, mp3]);
    expect(out).toHaveLength(3); // none merged — different track count / format
  });

  it('does not mutate the input folders', () => {
    const input = [flacPosterGirl('p1'), flacPosterGirl('p2')];
    dedupeFolders(input);
    expect(input.every((g) => g.duplicatePeers === undefined)).toBe(true);
  });
});
