import { TestBed } from '@angular/core/testing';
import { vi, beforeEach, describe, it, expect } from 'vitest';
import { of, throwError } from 'rxjs';
import { AdminComponent } from './admin.component';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { SystemApiService } from '../../services/api/system-api.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { ServiceReviewService } from '../../services/service-review.service';
import type {
  AdminUser,
  AlbumJob,
  IncompleteAlbumJob,
  LibraryFragmentReport,
  ProcessingSettings,
  ProcessingStatus,
  ServiceReview,
  UntrackedDownload,
} from '../../services/api/api-types';
import { AuthService } from '../../services/auth.service';

function makeReview(over: Partial<ServiceReview> = {}): ServiceReview {
  return {
    collectedAt: 1_700_000_000_000,
    version: '0.1.234',
    uptimeMs: 60_000,
    hardware: { cpuModel: 'Test CPU', cores: 4, arch: 'x64', platform: 'linux', totalMemoryBytes: 8000, gpuDetected: null },
    load: {
      cpu: { percent: 25, cores: 4, model: 'Test CPU' },
      memory: { totalBytes: 8000, usedBytes: 4000, freeBytes: 4000, processRssBytes: 100, processHeapBytes: 50 },
      gpu: null,
    },
    services: { slskd: { configured: true, healthy: true, connected: true } },
    library: { scanning: false, indexedSongCount: 1234 },
    updateCheck: {
      currentVersion: '0.1.234',
      latestVersion: null,
      updateAvailable: false,
      checkedAt: null,
      releaseUrl: null,
      versionHistory: [],
    },
    backups: [],
    backupsSummary: { total: 0, totalBytes: 0, newestAt: null, lastBackupName: null },
    processing: null,
    incompleteJobsCount: 0,
    untrackedCount: 0,
    auditTail: [],
    incompleteJobs: [],
    untracked: [],
    errors: [],
    ...over,
  };
}

function makeSvc(over: Partial<ServiceReview> = {}) {
  const r = makeReview(over);
  const svc: Partial<ServiceReviewService> = {
    review: (() => r) as ServiceReviewService['review'],
    start: vi.fn(() => () => {}),
    stop: vi.fn(),
    refresh: vi.fn(async () => undefined),
    cpu: (() => r.load.cpu) as ServiceReviewService['cpu'],
    memory: (() => r.load.memory) as ServiceReviewService['memory'],
    gpu: (() => r.load.gpu) as ServiceReviewService['gpu'],
    services: (() => r.services) as ServiceReviewService['services'],
    libraryState: (() => r.library) as ServiceReviewService['libraryState'],
    updateCheck: (() => r.updateCheck) as ServiceReviewService['updateCheck'],
    backups: (() => r.backups) as ServiceReviewService['backups'],
    backupsSummary: (() => r.backupsSummary) as ServiceReviewService['backupsSummary'],
    auditTail: (() => r.auditTail) as ServiceReviewService['auditTail'],
    incompleteJobsCount: (() => r.incompleteJobsCount) as ServiceReviewService['incompleteJobsCount'],
    untrackedCount: (() => r.untrackedCount) as ServiceReviewService['untrackedCount'],
    incompleteJobs: (() => r.incompleteJobs) as ServiceReviewService['incompleteJobs'],
    untracked: (() => r.untracked) as ServiceReviewService['untracked'],
  };
  return svc;
}

function makeAdminMocks(review: Partial<ServiceReview> = {}) {
  const getUsers = vi.fn(() => of([] as AdminUser[]));
  const resyncLibrary = vi.fn(() => of({ ok: true }));
  const emptyFragments: LibraryFragmentReport = {
    duplicateAlbums: [],
    hiddenByClassification: [],
    misSplitAlbums: [],
    totals: { duplicateAlbums: 0, hiddenByClassification: 0, misSplitAlbums: 0 },
    ok: true,
  };
  const getFragments = vi.fn(() => of(emptyFragments));
  const getStreaming = vi.fn(() =>
    of({
      transcodeEnabled: true,
      format: 'opus',
      maxBitRate: 192,
      forceTranscode: false,
      ffmpegAvailable: true,
    }),
  );
  const procStatus: ProcessingStatus = {
    phase: 'idle',
    currentTask: null,
    processed: 0,
    failed: 0,
    lastError: null,
    total: 0,
    lastItems: [],
    startedAt: null,
    updatedAt: null,
    taskPending: { bpm: 0, genre: 0, key: 0, energy: 0, 'audio-features': 0, 'artist-image': 0, 'artist-identity': 0, licence: 0 },
    availability: { bpm: true, genre: true, key: true, energy: true, 'audio-features': true, 'artist-image': true, 'artist-identity': true, licence: true },
    skipped: 0,
    quarantined: 0,
  };
  const getProcessing = vi.fn(() =>
    of({
      settings: {
        enabled: true,
        window: { start: '02:00', end: '06:00' },
        tasks: { bpm: true, genre: true, key: false, energy: false, 'audio-features': false },
      } as ProcessingSettings,
      status: procStatus,
    }),
  );
  return {
    getUsers,
    resyncLibrary,
    getFragments,
    getStreaming,
    getProcessing,
    procStatus,
    reviewService: makeSvc(review),
  };
}

describe('AdminComponent (snapshot-driven via ServiceReview)', () => {
  beforeEach(async () => {
    const mocks = makeAdminMocks();
    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        {
          provide: DownloadsApiService,
          useValue: {
            listAlbumJobs: vi.fn(() => of({ jobs: [] })),
            getUntrackedDownloads: vi.fn(() => of({ total: 0, rows: [] })),
          },
        },
        {
          provide: SystemApiService,
          useValue: {
            getUsers: mocks.getUsers,
            getStreamingSettings: mocks.getStreaming,
            saveStreamingSettings: vi.fn((p: unknown) => of(p as object)),
            getProcessing: mocks.getProcessing,
            saveProcessing: vi.fn((p: unknown) => of(p as object)),
          },
        },
        { provide: LibraryApiService, useValue: { resyncLibrary: mocks.resyncLibrary, getFragments: mocks.getFragments } },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();
  });

  function create() {
    return TestBed.createComponent(AdminComponent).componentInstance;
  }

  it('renders the metrics-pills row + every moved admin panel', async () => {
    const f = TestBed.createComponent(AdminComponent);
    f.componentInstance.loading.set(false);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="metrics-pills"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="streaming-panel"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="processing-panel"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="duplicates-panel"]')).toBeTruthy();
    f.destroy();
  });
});

describe('AdminComponent (incompleteJobs / untracked via ServiceReview)', () => {
  beforeEach(async () => {
    const mocks = makeAdminMocks();
    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: DownloadsApiService, useValue: {} },
        { provide: SystemApiService, useValue: { getUsers: vi.fn(() => of([])), getStreamingSettings: mocks.getStreaming, saveStreamingSettings: vi.fn((p: unknown) => of(p as object)), getProcessing: mocks.getProcessing, saveProcessing: vi.fn((p: unknown) => of(p as object)) } },
        { provide: LibraryApiService, useValue: { resyncLibrary: vi.fn(() => of({ ok: true })), getFragments: vi.fn(() => of({ duplicateAlbums: [], hiddenByClassification: [], misSplitAlbums: [], totals: { duplicateAlbums: 0, hiddenByClassification: 0, misSplitAlbums: 0 }, ok: true } as LibraryFragmentReport)) } },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();
  });

  it('retryHunt builds a DiscographyAlbum from the incomplete-job and sets the artist', () => {
    const c = TestBed.createComponent(AdminComponent).componentInstance;
    const job: IncompleteAlbumJob = {
      id: 1,
      lidarrAlbumId: 10,
      artistName: 'Soda Stereo',
      albumTitle: 'Canción Animal',
      username: 'peer',
      directory: 'Soda Stereo - Cancion Animal',
      state: 'exhausted',
      fallbackAttempts: 5,
      createdAt: 1_700_000_000_000,
    };
    c.retryHunt(job);
    expect(c.retryArtist()).toBe('Soda Stereo');
    expect(c.retryAlbum()?.lidarrId).toBe(10);
    expect(c.retryAlbum()?.title).toBe('Canción Animal');
  });

  it('retryHunt is a no-op when the job has no Lidarr album id', () => {
    const c = TestBed.createComponent(AdminComponent).componentInstance;
    c.retryHunt({ id: 1, lidarrAlbumId: null, artistName: '', albumTitle: null, username: '', directory: '', state: 'exhausted', fallbackAttempts: 0, createdAt: 1 });
    expect(c.retryAlbum()).toBeNull();
  });

  it('jobStateClass maps states to colors', () => {
    const c = TestBed.createComponent(AdminComponent).componentInstance;
    expect(c.jobStateClass('exhausted')).toContain('status-error');
    expect(c.jobStateClass('active')).toContain('status-warn');
  });

  it('syncLibrary calls resyncLibrary and reports success', async () => {
    const c = TestBed.createComponent(AdminComponent).componentInstance;
    await c.syncLibrary();
    expect(c.syncMsg()).toBe('Library rescan complete.');
  });

  it('syncLibrary surfaces an error message on failure', async () => {
    const resyncLibrary = vi.fn(() => throwError(() => new Error('boom')));
    TestBed.resetTestingModule();
    const mocks = makeAdminMocks();
    TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: DownloadsApiService, useValue: {} },
        { provide: SystemApiService, useValue: { getUsers: vi.fn(() => of([])), getStreamingSettings: mocks.getStreaming, saveStreamingSettings: vi.fn((p: unknown) => of(p as object)), getProcessing: mocks.getProcessing, saveProcessing: vi.fn((p: unknown) => of(p as object)) } },
        { provide: LibraryApiService, useValue: { resyncLibrary, getFragments: vi.fn(() => of({ duplicateAlbums: [], hiddenByClassification: [], misSplitAlbums: [], totals: { duplicateAlbums: 0, hiddenByClassification: 0, misSplitAlbums: 0 }, ok: true } as LibraryFragmentReport)) } },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();
    const c = TestBed.createComponent(AdminComponent).componentInstance;
    await c.syncLibrary();
    expect(c.syncMsg()).toBe('boom');
  });
});
