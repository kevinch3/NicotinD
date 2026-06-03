import { describe, it, expect } from 'vitest';
import type { SlskdUserTransferGroup } from '@nicotind/core';
import { groupByAlbum, albumGroupTitle, albumGroupTotal, extractAlbumName } from './download-groups';

function file(over: Partial<SlskdUserTransferGroup['directories'][0]['files'][0]> = {}) {
  return {
    id: 'f1',
    username: 'peer',
    filename: 'x.flac',
    size: 100,
    state: 'InProgress' as const,
    bytesTransferred: 50,
    averageSpeed: 0,
    percentComplete: 50,
    ...over,
  };
}

describe('extractAlbumName', () => {
  it('takes the last backslash segment', () => {
    expect(extractAlbumName('peer\\Music\\(1995) Toque')).toBe('(1995) Toque');
  });
});

describe('groupByAlbum with album-hunt metadata', () => {
  const downloads: SlskdUserTransferGroup[] = [
    {
      username: 'peer',
      directories: [
        {
          directory: 'Music\\(1995) Toque',
          fileCount: 2,
          files: [file({ id: 'a', state: 'Completed, Succeeded' }), file({ id: 'b' })],
          albumJob: { artistName: 'Babasónicos', albumTitle: 'Trance Zomba', canonicalTrackCount: 12 },
        },
      ],
    },
  ];

  it('carries canonical artist/album/track-count onto the group', () => {
    const [g] = groupByAlbum(downloads);
    expect(g.artistName).toBe('Babasónicos');
    expect(g.albumTitle).toBe('Trance Zomba');
    expect(g.expectedTracks).toBe(12);
  });

  it('albumGroupTitle prefers the canonical album title over the folder name', () => {
    const [g] = groupByAlbum(downloads);
    expect(albumGroupTitle(g)).toBe('Trance Zomba');
  });

  it('albumGroupTotal uses the canonical track count', () => {
    const [g] = groupByAlbum(downloads);
    expect(albumGroupTotal(g)).toBe(12);
    expect(g.completedFiles).toBe(1);
  });
});

describe('groupByAlbum for direct (non-hunt) downloads', () => {
  const downloads: SlskdUserTransferGroup[] = [
    {
      username: 'peer',
      directories: [
        { directory: 'shared\\My Mixtape', fileCount: 1, files: [file({ id: 'c' })] },
      ],
    },
  ];

  it('falls back to the peer folder name and file count', () => {
    const [g] = groupByAlbum(downloads);
    expect(g.artistName).toBeUndefined();
    expect(albumGroupTitle(g)).toBe('My Mixtape');
    expect(albumGroupTotal(g)).toBe(1); // totalFiles, no canonical count
  });
});
