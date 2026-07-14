import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { DownloadsComponent } from './downloads.component';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { SystemApiService } from '../../services/api/system-api.service';
import { TransferService } from '../../services/transfer.service';
import type { AcquireJob } from '@nicotind/core';

function setup(opts: { acquireJobs?: AcquireJob[] } = {}) {
  let scanned = false;
  const transferStub = {
    downloads: signal([]),
    uploads: signal([]),
    acquireJobs: signal(opts.acquireJobs ?? []),
    acquisitionJobs: signal([]),
    libraryDirty: signal(false),
    kickPoll: () => {},
  };

  TestBed.configureTestingModule({
    imports: [DownloadsComponent],
    providers: [
      provideRouter([]),
      { provide: DownloadsApiService, useValue: {} },
      {
        provide: SystemApiService,
        useValue: {
          triggerScan: () => {
            scanned = true;
            return of({});
          },
        },
      },
      { provide: TransferService, useValue: transferStub },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  // No detectChanges: rendering the feed would mount <app-download-item>, whose
  // required `item` input the JIT harness can't set (NG0950). These tests read
  // the computed signals directly.
  const fixture = TestBed.createComponent(DownloadsComponent);
  return { component: fixture.componentInstance, wasScanned: () => scanned };
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
});
