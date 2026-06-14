import { describe, it, expect } from 'vitest';
import type { AcquireJob, SlskdUserTransferGroup } from '@nicotind/core';
import {
  groupByAlbum,
  albumGroupTitle,
  albumGroupTotal,
  extractAlbumName,
  groupToDownloadItem,
  acquireJobToDownloadItem,
  acquireJobLabel,
  methodForBackend,
  buildDownloadFeed,
} from './download-groups';

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
          albumJob: {
            artistName: 'Babasónicos',
            albumTitle: 'Trance Zomba',
            canonicalTrackCount: 12,
          },
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
      directories: [{ directory: 'shared\\My Mixtape', fileCount: 1, files: [file({ id: 'c' })] }],
    },
  ];

  it('falls back to the peer folder name and file count', () => {
    const [g] = groupByAlbum(downloads);
    expect(g.artistName).toBeUndefined();
    expect(albumGroupTitle(g)).toBe('My Mixtape');
    expect(albumGroupTotal(g)).toBe(1); // totalFiles, no canonical count
  });
});

function job(over: Partial<AcquireJob> = {}): AcquireJob {
  return {
    id: 'j1',
    backend: 'ytdlp',
    url: 'https://youtube.com/watch?v=abc',
    label: null,
    state: 'running',
    stage: 'downloading',
    storage_path: null,
    progress: { done: 2, total: 5 },
    error: null,
    created_at: 1_000,
    ...over,
  };
}

describe('methodForBackend', () => {
  it('passes known backends through and maps unknown to "unknown"', () => {
    expect(methodForBackend('ytdlp')).toBe('ytdlp');
    expect(methodForBackend('spotdl')).toBe('spotdl');
    expect(methodForBackend('archive')).toBe('archive');
    expect(methodForBackend('mystery')).toBe('unknown');
  });
});

describe('acquireJobLabel', () => {
  it('prefers the explicit label', () => {
    expect(acquireJobLabel(job({ label: 'My Playlist' }))).toBe('My Playlist');
  });
  it('shortens the URL when no label', () => {
    expect(acquireJobLabel(job({ url: 'https://archive.org/details/foo' }))).toContain('archive.org');
  });
});

describe('groupToDownloadItem', () => {
  it('maps an in-flight slskd hunt group', () => {
    const [g] = groupByAlbum([
      {
        username: 'peer',
        directories: [
          {
            directory: 'M\\Album',
            fileCount: 2,
            files: [file({ id: 'a', state: 'Completed, Succeeded' }), file({ id: 'b' })],
            albumJob: { artistName: 'Artist', albumTitle: 'Album', canonicalTrackCount: 10 },
          },
        ],
      },
    ]);
    const item = groupToDownloadItem(g);
    expect(item.kind).toBe('slskd');
    expect(item.method).toBe('slskd');
    expect(item.title).toBe('Album');
    expect(item.subtitle).toBe('Artist');
    expect(item.stage).toBe('downloading');
    expect(item.progress).toEqual({ done: 1, total: 10 });
    expect(item.canCancel).toBe(true);
    expect(item.canRetry).toBe(false);
  });
});

describe('acquireJobToDownloadItem', () => {
  it('prefers the job stage and computes percent while downloading', () => {
    const item = acquireJobToDownloadItem(job());
    expect(item.kind).toBe('acquire');
    expect(item.method).toBe('ytdlp');
    expect(item.stage).toBe('downloading');
    expect(item.percent).toBe(40);
    expect(item.startedAt).toBe(1_000_000);
    expect(item.canCancel).toBe(true);
  });

  it('falls back to deriving stage from state when stage is null', () => {
    expect(acquireJobToDownloadItem(job({ stage: null, state: 'failed', error: 'boom' })).stage).toBe(
      'error',
    );
    expect(acquireJobToDownloadItem(job({ stage: null, state: 'done' })).stage).toBe('done');
    expect(acquireJobToDownloadItem(job({ stage: null, state: 'queued' })).stage).toBe('queued');
  });

  it('a failed job can be retried and removed but not cancelled', () => {
    const item = acquireJobToDownloadItem(job({ state: 'failed', stage: 'error' }));
    expect(item.canRetry).toBe(true);
    expect(item.canRemove).toBe(true);
    expect(item.canCancel).toBe(false);
  });
});

describe('buildDownloadFeed', () => {
  it('merges and sorts active stages before terminal ones', () => {
    const [done] = groupByAlbum([
      {
        username: 'peer',
        directories: [
          {
            directory: 'M\\Done',
            fileCount: 1,
            files: [file({ id: 'd', state: 'Completed, Succeeded' })],
          },
        ],
      },
    ]);
    const feed = buildDownloadFeed(
      [done],
      [job({ id: 'running', stage: 'downloading' }), job({ id: 'failed', state: 'failed', stage: 'error' })],
    );
    expect(feed.map((i) => i.stage)).toEqual(['downloading', 'error', 'done']);
  });
});
