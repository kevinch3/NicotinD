import { describe, it, expect } from 'vitest';
import type { AcquireJob, AcquisitionJobView, SlskdUserTransferGroup } from '@nicotind/core';
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
  mergeAcquisitionJobs,
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
            albumId: 'album-trance-zomba',
          },
        },
      ],
    },
  ];

  it('carries canonical artist/album/track-count and deep-link album id onto the group', () => {
    const [g] = groupByAlbum(downloads);
    expect(g.artistName).toBe('Babasónicos');
    expect(g.albumTitle).toBe('Trance Zomba');
    expect(g.expectedTracks).toBe(12);
    expect(g.albumId).toBe('album-trance-zomba');
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

  it('falls back to the peer folder name and file count, with no deep-link album id', () => {
    const [g] = groupByAlbum(downloads);
    expect(g.artistName).toBeUndefined();
    expect(g.albumId).toBeUndefined();
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
    albumId: null,
    albumArtist: null,
    albumTitle: null,
    destinationAlbums: [],
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
            albumJob: {
              artistName: 'Artist',
              albumTitle: 'Album',
              canonicalTrackCount: 10,
              albumId: 'album-id-1',
            },
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
    expect(item.albumId).toBe('album-id-1');
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

  it('carries the deep-link album id when the job resolved one, else undefined', () => {
    expect(
      acquireJobToDownloadItem(job({ state: 'done', stage: 'done', albumId: 'acq-album-1' })).albumId,
    ).toBe('acq-album-1');
    expect(acquireJobToDownloadItem(job({ albumId: null })).albumId).toBeUndefined();
  });

  it('a done job with a partial-download warning can be retried, not just removed', () => {
    const item = acquireJobToDownloadItem(
      job({ state: 'done', stage: 'done', error: 'Downloaded 1 of 16 tracks — the rest failed or were skipped.' }),
    );
    expect(item.canRetry).toBe(true);
    expect(item.canRemove).toBe(true);
    expect(item.error).toContain('1 of 16');
  });

  it('a clean done job (no error) cannot be retried', () => {
    const item = acquireJobToDownloadItem(job({ state: 'done', stage: 'done', error: null }));
    expect(item.canRetry).toBe(false);
  });
});

function acqJob(over: Partial<AcquisitionJobView> = {}): AcquisitionJobView {
  return {
    id: 'aj1',
    kind: 'album-hunt',
    method: 'slskd',
    state: 'active',
    stage: 'downloading',
    artistName: 'Artist',
    albumTitle: 'Album',
    lidarrAlbumId: null,
    sourceRef: 'peer',
    error: null,
    createdAt: 1000,
    updatedAt: 1000,
    albumId: 'album-id-1',
    progress: { expected: 2, delivered: 1, unavailable: 0, failed: 0 },
    ...over,
  };
}

describe('mergeAcquisitionJobs', () => {
  const doneGroupItems = () =>
    buildDownloadFeed(
      groupByAlbum([
        {
          username: 'peer',
          directories: [
            {
              directory: 'M\\Album',
              fileCount: 1,
              files: [file({ id: 'a', state: 'Completed, Succeeded' })],
              albumJob: {
                artistName: 'Artist',
                albumTitle: 'Album',
                canonicalTrackCount: 2,
                albumId: 'album-id-1',
              },
            },
          ],
        },
      ]),
      [],
    );

  it('collapses every peer folder of one album into a single card', () => {
    // One hunt whose transfers ended up in three slskd folder groups: the
    // primary peer's CD1/CD2 subfolders plus an alternate-peer fallback pull.
    // The user must see ONE card for the album, not three.
    const meta = {
      artistName: 'Los Chalchaleros',
      albumTitle: 'Los Chalchaleros',
      canonicalTrackCount: 13,
      albumId: 'chalcha-1',
    };
    const items = buildDownloadFeed(
      groupByAlbum([
        {
          username: 'primary',
          directories: [
            {
              directory: 'M\\Album\\CD1',
              fileCount: 2,
              files: [
                file({ id: 'a', state: 'Completed, Succeeded' }),
                file({ id: 'b', state: 'InProgress' }),
              ],
              albumJob: meta,
            },
            {
              directory: 'M\\Album\\CD2',
              fileCount: 1,
              files: [file({ id: 'c', state: 'Completed, Succeeded' })],
              albumJob: meta,
            },
          ],
        },
        {
          username: 'alt-peer',
          directories: [
            {
              directory: 'Elsewhere\\Album',
              fileCount: 1,
              files: [file({ id: 'd', state: 'Completed, Succeeded' })],
              albumJob: meta,
            },
          ],
        },
      ]),
      [],
    );
    expect(items).toHaveLength(3); // sanity: pre-merge fragmentation

    const merged = mergeAcquisitionJobs(items, [
      acqJob({
        id: 'job-ch',
        albumId: 'chalcha-1',
        artistName: 'Los Chalchaleros',
        albumTitle: 'Los Chalchaleros',
        progress: { expected: 13, delivered: 9, unavailable: 0, failed: 0 },
      }),
    ]);

    expect(merged).toHaveLength(1);
    const card = merged[0];
    expect(card.title).toBe('Los Chalchaleros');
    expect(card.subtitle).toBe('Los Chalchaleros');
    // The job's item tallies are authoritative: "9 of 13".
    expect(card.progress).toEqual({ done: 9, total: 13 });
    // One member still downloading → the card is downloading (never hides live work).
    expect(card.stage).toBe('downloading');
    // Actions must fan out to every member folder group.
    expect(card.memberKeys?.sort()).toEqual([
      'alt-peer:Elsewhere\\Album',
      'primary:M\\Album\\CD1',
      'primary:M\\Album\\CD2',
    ]);
    expect(card.canCancel).toBe(true);
  });

  it('collapses same-album folders even without a matching job row (shared albumId)', () => {
    const meta = {
      artistName: 'A',
      albumTitle: 'B',
      canonicalTrackCount: 10,
      albumId: 'ab-1',
    };
    const items = buildDownloadFeed(
      groupByAlbum([
        {
          username: 'p1',
          directories: [
            {
              directory: 'x\\B',
              fileCount: 1,
              files: [file({ id: 'a', state: 'Completed, Succeeded' })],
              albumJob: meta,
            },
          ],
        },
        {
          username: 'p2',
          directories: [
            {
              directory: 'y\\B',
              fileCount: 1,
              files: [file({ id: 'b', state: 'Completed, Succeeded' })],
              albumJob: meta,
            },
          ],
        },
      ]),
      [],
    );
    const merged = mergeAcquisitionJobs(items, []);
    expect(merged).toHaveLength(1);
    // No job tallies → sum member completions against the canonical total.
    expect(merged[0].progress).toEqual({ done: 2, total: 10 });
  });

  it("upgrades a finished slskd group to the job's post-download stage", () => {
    const merged = mergeAcquisitionJobs(doneGroupItems(), [acqJob({ stage: 'processing' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].stage).toBe('processing');
  });

  it('annotates unavailable tracks so the row reads as an honest partial', () => {
    const merged = mergeAcquisitionJobs(doneGroupItems(), [
      acqJob({
        state: 'done',
        stage: 'done',
        progress: { expected: 13, delivered: 11, unavailable: 2, failed: 0 },
      }),
    ]);
    expect(merged[0].stage).toBe('done');
    expect(merged[0].unavailable).toBe(2);
  });

  it('never downgrades an in-flight slskd row', () => {
    const items = buildDownloadFeed(
      groupByAlbum([
        {
          username: 'peer',
          directories: [
            {
              directory: 'M\\Album',
              fileCount: 1,
              files: [file({ id: 'a', state: 'InProgress' })],
              albumJob: {
                artistName: 'Artist',
                albumTitle: 'Album',
                canonicalTrackCount: 2,
                albumId: 'album-id-1',
              },
            },
          ],
        },
      ]),
      [],
    );
    const merged = mergeAcquisitionJobs(items, [acqJob({ stage: 'downloading' })]);
    expect(merged[0].stage).toBe('downloading');
    expect(merged[0].percent).toBeDefined();
  });

  it('appends an active job whose transfers vanished from slskd', () => {
    const merged = mergeAcquisitionJobs([], [acqJob({ stage: 'scanning' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('Album');
    expect(merged[0].subtitle).toBe('Artist');
    expect(merged[0].stage).toBe('scanning');
    expect(merged[0].albumId).toBe('album-id-1');
  });

  it('skips url-kind jobs (the AcquireJob lane already renders them)', () => {
    const merged = mergeAcquisitionJobs([], [acqJob({ kind: 'url', method: 'spotdl' })]);
    expect(merged).toHaveLength(0);
  });

  it('does not append finished jobs with no matching transfers (history, not feed)', () => {
    const merged = mergeAcquisitionJobs([], [acqJob({ state: 'done', stage: 'done' })]);
    expect(merged).toHaveLength(0);
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
