import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { AdminComponent } from './admin.component';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { SystemApiService } from '../../services/api/system-api.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { AlbumJob, UntrackedDownload } from '../../services/api/api-types';
import { AuthService } from '../../services/auth.service';
import { TransferService } from '../../services/transfer.service';

function job(overrides: Partial<AlbumJob>): AlbumJob {
  return {
    id: 1,
    lidarrAlbumId: 10,
    artistName: 'Soda Stereo',
    albumTitle: 'Canción Animal',
    username: 'peer',
    directory: 'Soda Stereo - Cancion Animal',
    state: 'exhausted',
    fallbackAttempts: 5,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('AdminComponent (incomplete albums + untracked)', () => {
  const listAlbumJobs = vi.fn(() => of({ jobs: [] as AlbumJob[] }));
  const getUntrackedDownloads = vi.fn(() => of({ total: 0, rows: [] as UntrackedDownload[] }));
  const resyncLibrary = vi.fn(() => of({ ok: true }));

  beforeEach(async () => {
    listAlbumJobs.mockClear();
    getUntrackedDownloads.mockClear();
    resyncLibrary.mockClear();
    listAlbumJobs.mockReturnValue(of({ jobs: [] }));
    getUntrackedDownloads.mockReturnValue(of({ total: 0, rows: [] }));
    resyncLibrary.mockReturnValue(of({ ok: true }));

    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: DownloadsApiService, useValue: { listAlbumJobs, getUntrackedDownloads } },
        { provide: SystemApiService, useValue: {} },
        { provide: LibraryApiService, useValue: { resyncLibrary } },
        { provide: AuthService, useValue: { token: () => null } },
        { provide: TransferService, useValue: { poll: vi.fn() } },
      ],
    }).compileComponents();
  });

  // Instantiate without detectChanges so ngOnInit / the log-stream effect never
  // run; the new methods are exercised directly (mirrors the hunt-modal spec).
  function create() {
    return TestBed.createComponent(AdminComponent).componentInstance;
  }

  it('retryHunt builds a DiscographyAlbum from the job and sets the artist', () => {
    const c = create();
    c.retryHunt(job({ lidarrAlbumId: 42, albumTitle: 'Dynamo', artistName: 'Soda Stereo' }));
    expect(c.retryArtist()).toBe('Soda Stereo');
    expect(c.retryAlbum()?.lidarrId).toBe(42);
    expect(c.retryAlbum()?.title).toBe('Dynamo');
  });

  it('retryHunt is a no-op when the job has no Lidarr album id', () => {
    const c = create();
    c.retryHunt(job({ lidarrAlbumId: null }));
    expect(c.retryAlbum()).toBeNull();
  });

  it('loadIncompleteJobs populates the signal from the API', async () => {
    listAlbumJobs.mockReturnValue(of({ jobs: [job({}), job({ id: 2, state: 'active' })] }));
    const c = create();
    await c.loadIncompleteJobs();
    expect(listAlbumJobs).toHaveBeenCalledWith('incomplete');
    expect(c.incompleteJobs()).toHaveLength(2);
    expect(c.jobsLoading()).toBe(false);
  });

  it('loadUntracked stores rows and total', async () => {
    getUntrackedDownloads.mockReturnValue(
      of({
        total: 5,
        rows: [
          {
            transferKey: 'k',
            username: 'u',
            directory: 'd',
            filename: 'f.mp3',
            basename: 'f.mp3',
            completedAt: 1,
          },
        ],
      }),
    );
    const c = create();
    await c.loadUntracked();
    expect(c.untrackedTotal()).toBe(5);
    expect(c.untracked()).toHaveLength(1);
  });

  it('jobStateClass maps states to colors', () => {
    const c = create();
    expect(c.jobStateClass('exhausted')).toContain('status-error');
    expect(c.jobStateClass('active')).toContain('status-warn');
  });

  it('syncLibrary calls resyncLibrary and reports success', async () => {
    const c = create();
    expect(c.syncing()).toBe(false);
    await c.syncLibrary();
    expect(resyncLibrary).toHaveBeenCalled();
    expect(c.syncing()).toBe(false);
    expect(c.syncMsg()).toBe('Library rescan complete.');
  });

  it('syncLibrary surfaces an error message on failure', async () => {
    resyncLibrary.mockReturnValueOnce(throwError(() => new Error('boom')));
    const c = create();
    await c.syncLibrary();
    expect(c.syncing()).toBe(false);
    expect(c.syncMsg()).toBe('boom');
  });
});

// Full render pass validating the sections moved in from Settings (streaming,
// library processing, find-duplicates). `token: () => null` keeps ngOnInit from
// opening any EventSource so detectChanges is safe.
describe('AdminComponent (moved admin panels render)', () => {
  const systemApi = {
    getUsers: vi.fn(() => of([])),
    getStatus: vi.fn(() => of({ slskd: { healthy: true, connected: true } })),
    getScanStatus: vi.fn(() => of({ scanning: false, count: 10 })),
    getStreamingSettings: vi.fn(() =>
      of({
        transcodeEnabled: true,
        format: 'opus',
        maxBitRate: 192,
        forceTranscode: false,
        ffmpegAvailable: true,
      }),
    ),
    saveStreamingSettings: vi.fn((p: unknown) => of({ ...(p as object) })),
    getProcessing: vi.fn(() =>
      of({
        settings: {
          enabled: true,
          window: { start: '02:00', end: '06:00' },
          tasks: { bpm: true, genre: true, key: false, energy: false, 'audio-features': false },
        },
        status: {
          phase: 'idle',
          availability: {},
          failed: 0,
          skipped: 0,
          processed: 0,
          total: 0,
          taskPending: { bpm: 0, genre: 0, key: 0, energy: 0, 'audio-features': 0 },
          lastItems: [],
        },
      }),
    ),
  };

  beforeEach(async () => {
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
        { provide: SystemApiService, useValue: systemApi },
        { provide: LibraryApiService, useValue: {} },
        { provide: AuthService, useValue: { token: () => null } },
        { provide: TransferService, useValue: { poll: vi.fn() } },
      ],
    }).compileComponents();
  });

  it('renders streaming, library-processing and duplicates panels', async () => {
    const fixture = TestBed.createComponent(AdminComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="streaming-panel"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="processing-panel"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="duplicates-panel"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="processing-run-now"]')).toBeTruthy();
    fixture.destroy();
  });
});
