import {
  extractDirectory,
  groupByDirectory,
  buildFolderTree,
  getDirectFiles,
  formatPeerInfo,
} from './folder-utils';

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
      { name: 'Music\\Artist\\Album', fileCount: 2, files: [
        { filename: 'Music\\Artist\\Album\\01.mp3', size: 100 },
        { filename: 'Music\\Artist\\Album\\02.mp3', size: 100 },
      ]},
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
    expect(formatPeerInfo({ uploadSpeed: 2_100_000, queueLength: 3, freeUploadSlots: 1 }))
      .toBe('↑ 2.1 MB/s · 3 queued · 1 slot');
  });

  it('omits queued segment when queueLength is 0', () => {
    expect(formatPeerInfo({ uploadSpeed: 500_000, queueLength: 0, freeUploadSlots: 2 }))
      .toBe('↑ 500 KB/s · 2 slots');
  });

  it('omits slots segment when freeUploadSlots is undefined', () => {
    expect(formatPeerInfo({ uploadSpeed: 1_000_000, queueLength: 1 }))
      .toBe('↑ 1.0 MB/s · 1 queued');
  });

  it('uses singular slot when freeUploadSlots is 1', () => {
    expect(formatPeerInfo({ uploadSpeed: 300_000, freeUploadSlots: 1 }))
      .toBe('↑ 300 KB/s · 1 slot');
  });

  it('uses plural slots when freeUploadSlots is 0', () => {
    expect(formatPeerInfo({ uploadSpeed: 300_000, freeUploadSlots: 0 }))
      .toBe('↑ 300 KB/s · 0 slots');
  });
});

describe('getDirectFiles', () => {
  it('returns only files whose directory is the selected node path', () => {
    const dirs = [
      { name: 'Music\\Artist\\Album', fileCount: 2, files: [
        { filename: 'Music\\Artist\\Album\\01.mp3', size: 100 },
        { filename: 'Music\\Artist\\Album\\02.mp3', size: 100 },
      ]},
    ];
    const files = getDirectFiles(dirs, 'Music\\Artist\\Album');
    expect(files).toHaveLength(2);
  });

  it('does not include files from subdirectories', () => {
    const dirs = [
      { name: 'Music\\Artist', fileCount: 1, files: [
        { filename: 'Music\\Artist\\01.mp3', size: 100 },
      ]},
      { name: 'Music\\Artist\\Album', fileCount: 1, files: [
        { filename: 'Music\\Artist\\Album\\01.mp3', size: 100 },
      ]},
    ];
    const files = getDirectFiles(dirs, 'Music\\Artist');
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('Music\\Artist\\01.mp3');
  });
});
