import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { of } from 'rxjs';
import { DownloadsComponent } from './downloads.component';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { SystemApiService } from '../../services/api/system-api.service';
import { TransferService } from '../../services/transfer.service';
import { PullToRefreshService } from '../../services/pull-to-refresh.service';
import { ToastService } from '../../services/toast.service';
import type { AcquireJob } from '@nicotind/core';

function setup(opts: { acquireJobs?: AcquireJob[]; api?: Record<string, unknown> } = {}) {
  let scanned = false;
  let registeredHandler: (() => Promise<void> | void) | null = null;
  const transferStub = {
    downloads: signal([]),
    uploads: signal([]),
    acquireJobs: signal(opts.acquireJobs ?? []),
    acquisitionJobs: signal([]),
    libraryDirty: signal(false),
    kickPoll: vi.fn().mockResolvedValue(undefined),
  };
  const p2rStub = {
    register: (h: () => Promise<void> | void) => {
      registeredHandler = h;
    },
    refreshing: signal(false),
    hasHandler: signal(true),
    trigger: vi.fn(),
  };

  const toastShow = vi.fn().mockReturnValue('toast-id');

  TestBed.configureTestingModule({
    imports: [DownloadsComponent],
    providers: [
      provideRouter([]),
      { provide: DownloadsApiService, useValue: opts.api ?? {} },
      { provide: ToastService, useValue: { show: toastShow, dismiss: vi.fn() } },
      {
        provide: SystemApiService,
        useValue: {
          triggerScan: () => {
            scanned = true;
            return of({});
          },
          getDiskUsage: () => of({ total: 1000, free: 400, used: 600 }),
        },
      },
      { provide: TransferService, useValue: transferStub },
      { provide: PullToRefreshService, useValue: p2rStub },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  // No detectChanges: rendering the feed would mount <app-download-item>, whose
  // required `item` input the JIT harness can't set (NG0950). These tests read
  // the computed signals directly.
  const fixture = TestBed.createComponent(DownloadsComponent);
  return {
    component: fixture.componentInstance,
    wasScanned: () => scanned,
    transferService: transferStub,
    getRegisteredHandler: () => registeredHandler,
    toastShow,
  };
}

function job(id: string, state: AcquireJob['state']): AcquireJob {
  return {
    id,
    backend: 'ytdlp',
    url: 'https://example.com/x',
    label: `Job ${id}`,
    state,
    stage: state === 'running' ? 'downloading' : state === 'done' ? 'done' : null,
    storage_path: null,
    albumId: null,
    albumArtist: null,
    albumTitle: null,
    destinationAlbums: [],
    progress: null,
    tracks: [],
    isPlaylist: false,
    playlistId: null,
    error: null,
    created_at: 0,
  };
}

describe('DownloadsComponent — active feed', () => {
  it('renders no active downloads when nothing is in flight', () => {
    const { component } = setup();
    expect(component.downloadFeed().length).toBe(0);
    expect(component.activeFeedCount()).toBe(0);
  });

  it('counts in-progress vs clearable acquire jobs', () => {
    const { component } = setup({
      acquireJobs: [job('a', 'running'), job('b', 'done'), job('c', 'failed')],
    });
    // running → in progress; done/failed → clearable.
    expect(component.activeFeedCount()).toBe(1);
    expect(component.clearableFeedCount()).toBe(2);
  });

  it('triggerScan calls the system API', async () => {
    const { component, wasScanned } = setup();
    await component.triggerScan();
    expect(wasScanned()).toBe(true);
    expect(component.scanning()).toBe(false);
  });

  it('loads disk usage into the header pill signal', async () => {
    const { component } = setup();
    await Promise.resolve();
    expect(component.diskUsage()).toEqual({ total: 1000, free: 400, used: 600 });
  });

  it('registers a pull-to-refresh handler that kicks a transfer poll', async () => {
    const { transferService, getRegisteredHandler } = setup();
    const handler = getRegisteredHandler();
    expect(handler).not.toBeNull();
    await handler!();
    expect(transferService.kickPoll).toHaveBeenCalled();
  });

  // Issue #533: a failed job delete was `.catch(() => {})`-ed, so Remove
  // silently no-opped — the user-visible "old downloads I can't remove".
  it('surfaces a failed feed-row removal as an error toast', async () => {
    const { throwError } = await import('rxjs');
    const { component, toastShow } = setup({
      api: {
        deleteJob: () => throwError(() => ({ status: 400, error: { error: 'Job not found' } })),
      },
    });
    component.onItemRemove({
      key: 'job:j1',
      kind: 'network',
      title: 'X',
      method: 'slskd',
      stage: 'done',
      jobId: 'j1',
      canRetry: false,
      canCancel: false,
      canRemove: true,
    } as never);
    component.onConfirm();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(toastShow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('Job not found') }),
    );
  });

  const networkRow = (over: Record<string, unknown> = {}) =>
    ({
      key: 'job:j1',
      kind: 'network',
      title: 'X',
      method: 'ytdlp',
      stage: 'error',
      jobId: 'j1',
      canRetry: true,
      canCancel: false,
      canRemove: true,
      ...over,
    }) as never;

  /**
   * An addon-run URL acquire renders in the network lane but retries through
   * the acquire endpoint. `onItemRetry` used to short-circuit on
   * `kind !== 'network'`, so the button rendered and did nothing.
   */
  it('retries a network-lane URL acquire through the acquire endpoint', async () => {
    const retryAcquireJob = vi.fn().mockReturnValue(of({ jobId: 'j2' }));
    const { component, transferService } = setup({ api: { retryAcquireJob } });
    component.onItemRetry(networkRow());
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(retryAcquireJob).toHaveBeenCalledWith('j1');
    expect(transferService.kickPoll).toHaveBeenCalled();
  });

  it('surfaces a failed retry instead of swallowing it', async () => {
    const { throwError } = await import('rxjs');
    const { component, toastShow } = setup({
      api: {
        retryAcquireJob: () =>
          throwError(() => ({ status: 503, error: { error: 'No addon can handle this link' } })),
      },
    });
    component.onItemRetry(networkRow());
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(toastShow).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        message: expect.stringContaining('No addon can handle this link'),
      }),
    );
  });

  /** Swallowing this is how "the X does nothing" shipped (the #533 shape). */
  it('surfaces a failed cancel instead of swallowing it', async () => {
    const { throwError } = await import('rxjs');
    const { component, toastShow } = setup({
      api: {
        cancelJob: () => throwError(() => ({ status: 502, error: { error: 'addon is gone' } })),
      },
    });
    component.onItemCancel(networkRow({ stage: 'downloading', canCancel: true }));
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(toastShow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('addon is gone') }),
    );
  });
});
