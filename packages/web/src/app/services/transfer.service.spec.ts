import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of } from 'rxjs';
import { TransferService } from './transfer.service';
import { DownloadsApiService } from './api/downloads-api.service';
import { SystemApiService } from './api/system-api.service';
import type { AcquireJob, AcquisitionJobView } from '@nicotind/core';

function makeJobView(stage: AcquisitionJobView['stage'], id = 'aj-1'): AcquisitionJobView {
  return {
    id,
    kind: 'album-hunt',
    method: 'slskd',
    state: stage === 'done' ? 'done' : 'active',
    stage,
    artistName: 'Artist',
    albumTitle: 'Album',
    displayTitle: null,
    sourceUrl: null,
    playlistId: null,
    lidarrAlbumId: null,
    sourceRef: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    albumId: null,
    progress: { expected: 1, delivered: stage === 'done' ? 1 : 0, unavailable: 0, failed: 0 },
    items: [
      {
        title: 'Song',
        status: stage === 'done' ? 'done' : 'downloading',
        username: 'peer',
        filename: 'file0',
      },
    ],
    sources: [{ username: 'peer', fileCount: 1, state: 'downloading' }],
    destinationAlbums: [],
  };
}

function makeApiMock(overrides: Partial<DownloadsApiService> = {}): DownloadsApiService {
  return {
    getAcquisitionJobs: () => of([]),
    getAcquireJobs: () => of([]),
    ...overrides,
  } as unknown as DownloadsApiService;
}

// TransferService also injects SystemApiService (getScanStatus, used only by the
// scan-poll path); provide a minimal stub so the real one isn't instantiated.
const systemApiMock = {
  getScanStatus: () => of({ scanning: false, count: 0 }),
} as unknown as SystemApiService;

function makeAcquireJob(state: AcquireJob['state']): AcquireJob {
  return {
    id: 'j1',
    state,
    url: 'http://x',
    backend: 'yt-dlp',
    label: null,
    stage: null,
    storage_path: null,
    albumId: null,
    albumArtist: null,
    albumTitle: null,
    destinationAlbums: [],
    tracks: [],
    isPlaylist: false,
    playlistId: null,
    progress: null,
    error: null,
    created_at: 0,
  };
}

describe('TransferService.activeDownloadCount', () => {
  let service: TransferService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        TransferService,
        { provide: DownloadsApiService, useValue: makeApiMock() },
        { provide: SystemApiService, useValue: systemApiMock },
      ],
    });
    service = TestBed.inject(TransferService);
  });

  it('is 0 with no downloads', () => {
    expect(service.activeDownloadCount()).toBe(0);
  });

  it('counts in-flight network jobs (unified feed since phase 3)', () => {
    service.acquisitionJobs.set([makeJobView('downloading'), makeJobView('done', 'aj-2')]);
    expect(service.activeDownloadCount()).toBe(1);
  });

  it('excludes URL jobs (they badge via acquire jobs)', () => {
    service.acquisitionJobs.set([{ ...makeJobView('downloading'), kind: 'url' }]);
    expect(service.activeDownloadCount()).toBe(0);
  });

  it('is 0 when all jobs are terminal', () => {
    service.acquisitionJobs.set([makeJobView('done'), makeJobView('done', 'aj-2')]);
    expect(service.activeDownloadCount()).toBe(0);
  });

  it('reacts to signal updates', () => {
    expect(service.activeDownloadCount()).toBe(0);
    service.acquisitionJobs.set([makeJobView('downloading')]);
    expect(service.activeDownloadCount()).toBe(1);
    service.acquisitionJobs.set([]);
    expect(service.activeDownloadCount()).toBe(0);
  });
});

describe('TransferService adaptive polling', () => {
  let service: TransferService;
  let pollCount: number;

  function setup(apiOverrides: Partial<DownloadsApiService> = {}): void {
    vi.useFakeTimers();
    pollCount = 0;
    const api = makeApiMock({
      getAcquisitionJobs: () => {
        pollCount++;
        return of([]);
      },
      getAcquireJobs: () => of([]),
      ...apiOverrides,
    });
    TestBed.configureTestingModule({
      providers: [
        TransferService,
        { provide: DownloadsApiService, useValue: api },
        { provide: SystemApiService, useValue: systemApiMock },
      ],
    });
    service = TestBed.inject(TransferService);
  }

  afterEach(() => {
    service.stopPolling();
    vi.useRealTimers();
  });

  it('polls once immediately on startPolling', async () => {
    setup();
    service.startPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollCount).toBe(1);
  });

  it('does not start a second loop if already running', async () => {
    setup();
    service.startPolling();
    service.startPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollCount).toBe(1);
  });

  it('uses 30 s interval when idle', async () => {
    setup();
    service.startPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollCount).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(pollCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pollCount).toBe(2);
  });

  it('uses 3 s interval when a transfer is active', async () => {
    // Mock keeps returning an active group so the signal stays active after each poll.
    setup({
      getAcquisitionJobs: () => {
        pollCount++;
        return of([makeJobView('downloading')]);
      },
    });
    service.startPolling();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pollCount).toBe(2);
  });

  it('uses 3 s interval when an acquire job is running', async () => {
    // Mock keeps returning running job so acquireJobs signal stays active after each poll.
    setup({ getAcquireJobs: () => of([makeAcquireJob('running')]) });
    service.startPolling();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pollCount).toBe(2);
  });

  it('stopPolling prevents further ticks', async () => {
    setup();
    service.startPolling();
    await vi.advanceTimersByTimeAsync(0);
    service.stopPolling();
    const countAfterStop = pollCount;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pollCount).toBe(countAfterStop);
  });

  it('kickPoll fires immediately and resets the timer', async () => {
    setup();
    service.startPolling();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    const before = pollCount;
    service.kickPoll();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollCount).toBe(before + 1);
  });

  it('kickPoll resolves after the poll completes', async () => {
    setup();
    const before = pollCount;
    await service.kickPoll();
    expect(pollCount).toBe(before + 1);
  });
});

describe('TransferService item status → transfer state mapping', () => {
  let service: TransferService;
  let getDownloadsMock: any;

  type ItemStatus = AcquisitionJobView['items'][number]['status'];

  function jobWithItemStatus(status: ItemStatus): AcquisitionJobView {
    const job = makeJobView('downloading');
    return { ...job, items: [{ title: 'Song', status, username: 'peer', filename: 'file0' }] };
  }

  beforeEach(() => {
    getDownloadsMock = vi.fn().mockReturnValue(of([]));
    const api = makeApiMock({
      getAcquisitionJobs: getDownloadsMock,
      getAcquireJobs: () => of([]),
    });
    TestBed.configureTestingModule({
      providers: [
        TransferService,
        { provide: DownloadsApiService, useValue: api },
        { provide: SystemApiService, useValue: systemApiMock },
      ],
    });
    service = TestBed.inject(TransferService);
  });

  async function stateFor(status: ItemStatus): Promise<string | undefined> {
    getDownloadsMock.mockReturnValue(of([jobWithItemStatus(status)]));
    await service.poll();
    return service.getStatus('peer', 'file0')?.state;
  }

  it('maps pending to a queued state, not fake progress (#663)', async () => {
    expect(await stateFor('pending')).toBe('Queued, Remotely');
  });

  it('maps downloading to InProgress', async () => {
    expect(await stateFor('downloading')).toBe('InProgress');
  });

  it('maps skipped to a terminal errored state (the track will never land)', async () => {
    expect(await stateFor('skipped')).toBe('Completed, Errored');
  });

  it('maps failed to Completed, Errored', async () => {
    expect(await stateFor('failed')).toBe('Completed, Errored');
  });

  it('maps done to Completed, Succeeded', async () => {
    expect(await stateFor('done')).toBe('Completed, Succeeded');
  });
});

describe('TransferService libraryDirty flagging', () => {
  let service: TransferService;
  let getDownloadsMock: any;

  beforeEach(() => {
    getDownloadsMock = vi.fn().mockReturnValue(of([]));
    const api = makeApiMock({
      getAcquisitionJobs: getDownloadsMock,
      getAcquireJobs: () => of([]),
    });
    TestBed.configureTestingModule({
      providers: [
        TransferService,
        { provide: DownloadsApiService, useValue: api },
        { provide: SystemApiService, useValue: systemApiMock },
      ],
    });
    service = TestBed.inject(TransferService);
  });

  it('does not flag libraryDirty on the first poll even if items are completed', async () => {
    getDownloadsMock.mockReturnValue(of([makeJobView('done')]));
    expect(service.libraryDirty()).toBe(false);
    await service.poll();
    expect(service.libraryDirty()).toBe(false);
  });

  it('flags libraryDirty on subsequent polls when an item newly completes', async () => {
    getDownloadsMock.mockReturnValue(of([makeJobView('downloading')]));
    await service.poll();
    expect(service.libraryDirty()).toBe(false);

    getDownloadsMock.mockReturnValue(of([makeJobView('done')]));
    await service.poll();
    expect(service.libraryDirty()).toBe(true);
  });
});

// noteAlbumsLanded/newlyLandedAlbumIds (issue #708): deliberately narrower
// than libraryDirty — it only ever holds ids a caller can point to, so a
// listener can react without a blanket "something changed, reload
// everything" reset. See ReviewInboxComponent, which is the only caller.
describe('TransferService.noteAlbumsLanded', () => {
  let service: TransferService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        TransferService,
        { provide: DownloadsApiService, useValue: makeApiMock() },
        { provide: SystemApiService, useValue: systemApiMock },
      ],
    });
    service = TestBed.inject(TransferService);
  });

  it('starts empty', () => {
    expect(service.newlyLandedAlbumIds().size).toBe(0);
  });

  it('accumulates album ids across calls', () => {
    service.noteAlbumsLanded(['al1']);
    service.noteAlbumsLanded(['al2', 'al3']);
    expect([...service.newlyLandedAlbumIds()]).toEqual(['al1', 'al2', 'al3']);
  });

  it('an empty list is a no-op', () => {
    service.noteAlbumsLanded(['al1']);
    service.noteAlbumsLanded([]);
    expect([...service.newlyLandedAlbumIds()]).toEqual(['al1']);
  });

  it('clearNewlyLandedAlbumIds empties the set', () => {
    service.noteAlbumsLanded(['al1']);
    service.clearNewlyLandedAlbumIds();
    expect(service.newlyLandedAlbumIds().size).toBe(0);
  });
});
