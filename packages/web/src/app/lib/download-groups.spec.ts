import { describe, it, expect } from 'vitest';
import type { AcquireJob, AcquisitionJobView } from '@nicotind/core';
import {
  acquireJobToDownloadItem,
  acquireJobLabel,
  methodForBackend,
  buildDownloadFeed,
  mergeAcquisitionJobs,
  type DownloadItem,
} from './download-groups';

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
    tracks: [],
    isPlaylist: false,
    playlistId: null,
    progress: { done: 2, total: 5 },
    error: null,
    created_at: 1_000,
    bitRate: null,
    audioFormat: null,
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

  // Regression: URL resolvers became addons with suffixed ids, so an addon-backed
  // download rendered as "Unknown source" until these were mapped to the base method.
  it('maps the addon backend ids to their base method', () => {
    expect(methodForBackend('ytdlp-addon')).toBe('ytdlp');
    expect(methodForBackend('spotdl-addon')).toBe('spotdl');
    expect(methodForBackend('bundled-archive')).toBe('archive');
  });

  // Issue #532: same regression class for the network lane — every album-hunt
  // card since the slskd cutover rendered "?Unknown source" although the
  // Soulseek badge existed all along.
  it('maps the slskd addon ids to the Soulseek method', () => {
    expect(methodForBackend('slskd')).toBe('slskd');
    expect(methodForBackend('slskd-addon')).toBe('slskd');
  });
});

describe('acquireJobLabel', () => {
  it('prefers the explicit label', () => {
    expect(acquireJobLabel(job({ label: 'My Playlist' }))).toBe('My Playlist');
  });
  it('shortens the URL when no label', () => {
    expect(acquireJobLabel(job({ url: 'https://archive.org/details/foo' }))).toContain(
      'archive.org',
    );
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
    expect(
      acquireJobToDownloadItem(job({ stage: null, state: 'failed', error: 'boom' })).stage,
    ).toBe('error');
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
      acquireJobToDownloadItem(job({ state: 'done', stage: 'done', albumId: 'acq-album-1' }))
        .albumId,
    ).toBe('acq-album-1');
    expect(acquireJobToDownloadItem(job({ albumId: null })).albumId).toBeUndefined();
  });

  it('a done job with a partial-download warning can be retried, not just removed', () => {
    const item = acquireJobToDownloadItem(
      job({
        state: 'done',
        stage: 'done',
        error: 'Downloaded 1 of 16 tracks — the rest failed or were skipped.',
      }),
    );
    expect(item.canRetry).toBe(true);
    expect(item.canRemove).toBe(true);
    expect(item.error).toContain('1 of 16');
  });

  it('a clean done job (no error) cannot be retried', () => {
    const item = acquireJobToDownloadItem(job({ state: 'done', stage: 'done', error: null }));
    expect(item.canRetry).toBe(false);
  });

  it('carries destinationAlbums through unchanged', () => {
    const destinationAlbums = [
      { albumArtist: 'Artist A', albumTitle: 'Album A', albumId: 'alb-a' },
      { albumArtist: 'Artist B', albumTitle: 'Album B', albumId: 'alb-b' },
    ];
    const item = acquireJobToDownloadItem(job({ destinationAlbums }));
    expect(item.destinationAlbums).toEqual(destinationAlbums);
  });

  it('defaults destinationAlbums to an empty array when the job has none', () => {
    const item = acquireJobToDownloadItem(job({ destinationAlbums: [] }));
    expect(item.destinationAlbums).toEqual([]);
  });

  it('carries tracks through from the acquire job onto the unified field', () => {
    const tracks = [
      { title: 'Track One', status: 'done' as const },
      { title: 'Track Two', status: 'downloading' as const },
      { title: 'Track Three', status: 'pending' as const },
    ];
    const item = acquireJobToDownloadItem(job({ tracks }));
    expect(item.tracks).toEqual(tracks);
  });

  it('surfaces bitRate + audioFormat from the acquire job for the quality chip', () => {
    const item = acquireJobToDownloadItem(job({ bitRate: 192, audioFormat: 'opus' }));
    expect(item.bitrateKbps).toBe(192);
    expect(item.audioFormat).toBe('opus');
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
    items: [],
    sources: [],
    ...over,
  };
}

describe('mergeAcquisitionJobs', () => {
  it('renders one card per network job, straight from the feed row', () => {
    const merged = mergeAcquisitionJobs([], [acqJob()]);
    expect(merged).toHaveLength(1);
    const card = merged[0]!;
    expect(card.key).toBe('job:aj1');
    expect(card.kind).toBe('network');
    expect(card.title).toBe('Album');
    expect(card.subtitle).toBe('Artist');
    expect(card.stage).toBe('downloading');
    expect(card.albumId).toBe('album-id-1');
    expect(card.progress).toEqual({ done: 1, total: 2 });
    expect(card.canCancel).toBe(true);
  });

  // Regression: an in-flight addon URL job (no resolved metadata yet) rendered
  // with an "Unknown source" chip and the raw `addon:<id>:<uuid>` transfer key as
  // its title. It should show the mapped source chip + a friendly label.
  it('renders an addon URL job with a mapped source chip and no raw addon key', () => {
    const merged = mergeAcquisitionJobs(
      [],
      [
        acqJob({
          id: 'u1',
          kind: 'url',
          method: 'spotdl-addon',
          artistName: null,
          albumTitle: null,
          sourceRef: 'addon:spotdl-addon:767ce23a-e417-47c8-9a5b-f09129ec3443',
        }),
      ],
    );
    expect(merged).toHaveLength(1);
    const card = merged[0]!;
    expect(card.method).toBe('spotdl');
    expect(card.title).toBe('Spotify download');
    expect(card.title).not.toContain('addon:');
  });

  /**
   * Issue #261: card identity used to be re-derived from `albumId` at read
   * time, so the same album acquired twice collapsed into one card. Identity
   * is the job the server recorded at enqueue time.
   */
  it('keeps two separate jobs for the SAME album as two cards', () => {
    const merged = mergeAcquisitionJobs([], [acqJob({ id: 'job-1' }), acqJob({ id: 'job-2' })]);
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.key).sort()).toEqual(['job:job-1', 'job:job-2']);
  });

  it("exposes the job's peer breakdown on the card", () => {
    const merged = mergeAcquisitionJobs(
      [],
      [
        acqJob({
          sources: [
            { username: 'smuks-aef771', fileCount: 10, state: 'done' },
            { username: 'dolche', fileCount: 1, state: 'failed' },
          ],
        }),
      ],
    );
    expect(merged[0]!.sources).toHaveLength(2);
    expect(merged[0]!.sources?.[0].username).toBe('smuks-aef771');
  });

  it('annotates unavailable tracks so the row reads as an honest partial', () => {
    const merged = mergeAcquisitionJobs(
      [],
      [
        acqJob({
          state: 'done',
          stage: 'done',
          progress: { expected: 13, delivered: 11, unavailable: 2, failed: 0 },
        }),
      ],
    );
    expect(merged[0]!.stage).toBe('done');
    expect(merged[0]!.unavailable).toBe(2);
  });

  it("carries the job's per-item statuses through onto the unified tracks field", () => {
    const items = [
      { title: 'Track One', status: 'done' as const },
      { title: 'Track Two', status: 'downloading' as const },
    ];
    const merged = mergeAcquisitionJobs([], [acqJob({ items })]);
    expect(merged[0]!.tracks).toEqual(items);
  });

  it('renders an addon-backed url job (no acquire-lane twin)', () => {
    // An addon url job has only an acquisition_jobs row → it renders through the
    // unified lane like a network job (#509 cause 1).
    const merged = mergeAcquisitionJobs(
      [],
      [acqJob({ id: 'u1', kind: 'url', method: 'bundled-archive' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.key).toBe('job:u1');
  });

  it('skips a url job already rendered by the in-process acquire lane', () => {
    // The in-process url job shares its id with an acquire-lane card (same UUID)
    // → skip the mirror to avoid a double card.
    const acquireItem = {
      key: 'u2',
      kind: 'acquire',
      title: 't',
      method: 'spotdl',
      stage: 'downloading',
    } as DownloadItem;
    const merged = mergeAcquisitionJobs(
      [acquireItem],
      [acqJob({ id: 'u2', kind: 'url', method: 'spotdl' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged.every((m) => m.kind !== 'network')).toBe(true); // only the acquire card, no mirror
  });

  it('renders finished jobs too — the feed row alone carries a card since phase 3', () => {
    const merged = mergeAcquisitionJobs([], [acqJob({ state: 'done', stage: 'done' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.stage).toBe('done');
    expect(merged[0]!.canRemove).toBe(true);
  });

  it('keeps URL-lane items and sorts active stages before terminal ones', () => {
    const merged = mergeAcquisitionJobs(
      buildDownloadFeed([
        job({ id: 'url-running', stage: 'downloading' }),
        job({ id: 'url-done', state: 'done', stage: 'done' }),
      ]),
      [acqJob({ state: 'done', stage: 'done' })],
    );
    expect(merged.map((i) => i.stage)).toEqual(['downloading', 'done', 'done']);
    expect(merged[0]!.key).toBe('url-running');
  });
});

describe('buildDownloadFeed', () => {
  it('sorts active stages before terminal ones', () => {
    const feed = buildDownloadFeed([
      job({ id: 'done', state: 'done', stage: 'done' }),
      job({ id: 'running', stage: 'downloading' }),
      job({ id: 'failed', state: 'failed', stage: 'error' }),
    ]);
    expect(feed.map((i) => i.stage)).toEqual(['downloading', 'error', 'done']);
  });
});
