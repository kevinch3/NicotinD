import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of } from 'rxjs';
import { TransferService } from './transfer.service';
import { DownloadsApiService } from './api/downloads-api.service';
import { SystemApiService } from './api/system-api.service';
import type { SlskdUserTransferGroup, AcquireJob } from '@nicotind/core';

function makeGroup(states: string[][]): SlskdUserTransferGroup {
  return {
    username: 'user',
    directories: states.map((fileStates, i) => ({
      directory: `/dir${i}`,
      fileCount: fileStates.length,
      files: fileStates.map((state, j) => ({
        id: `${i}-${j}`,
        username: 'user',
        filename: `file${j}`,
        size: 0,
        state: state as never,
        bytesTransferred: 0,
        averageSpeed: 0,
        percentComplete: 0,
      })),
    })),
  };
}

function makeApiMock(overrides: Partial<DownloadsApiService> = {}): DownloadsApiService {
  return {
    getDownloads: () => of([]),
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

  it('counts a directory with at least one InProgress file', () => {
    service.downloads.set([makeGroup([['InProgress'], ['Completed']])]);
    expect(service.activeDownloadCount()).toBe(1);
  });

  it('counts Queued and Initializing as active', () => {
    service.downloads.set([makeGroup([['Queued'], ['Initializing'], ['Completed']])]);
    expect(service.activeDownloadCount()).toBe(2);
  });

  it('counts across multiple users and directories', () => {
    service.downloads.set([
      makeGroup([['InProgress', 'InProgress'], ['Completed']]),
      makeGroup([['Queued'], ['Initializing']]),
    ]);
    expect(service.activeDownloadCount()).toBe(3);
  });

  it('is 0 when all files are terminal', () => {
    service.downloads.set([makeGroup([['Completed'], ['Failed'], ['Cancelled']])]);
    expect(service.activeDownloadCount()).toBe(0);
  });

  it('reacts to signal updates', () => {
    expect(service.activeDownloadCount()).toBe(0);
    service.downloads.set([makeGroup([['InProgress']])]);
    expect(service.activeDownloadCount()).toBe(1);
    service.downloads.set([]);
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
      getDownloads: () => {
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
      getDownloads: () => {
        pollCount++;
        return of([makeGroup([['InProgress']])]);
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
});

describe('TransferService libraryDirty flagging', () => {
  let service: TransferService;
  let getDownloadsMock: any;

  beforeEach(() => {
    getDownloadsMock = vi.fn().mockReturnValue(of([]));
    const api = makeApiMock({
      getDownloads: getDownloadsMock,
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

  it('does not flag libraryDirty on the first poll even if downloads are completed', async () => {
    getDownloadsMock.mockReturnValue(of([makeGroup([['Completed, Succeeded']])]));
    expect(service.libraryDirty()).toBe(false);
    await service.poll();
    expect(service.libraryDirty()).toBe(false);
  });

  it('flags libraryDirty on subsequent polls when a new completed download appears', async () => {
    getDownloadsMock.mockReturnValue(of([makeGroup([['InProgress']])]));
    await service.poll();
    expect(service.libraryDirty()).toBe(false);

    getDownloadsMock.mockReturnValue(of([makeGroup([['Completed, Succeeded']])]));
    await service.poll();
    expect(service.libraryDirty()).toBe(true);
  });
});
