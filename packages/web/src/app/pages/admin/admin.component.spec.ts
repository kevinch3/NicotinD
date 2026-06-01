import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of } from 'rxjs';
import { AdminComponent } from './admin.component';
import { ApiService, type AlbumJob } from '../../services/api.service';
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
  const getUntrackedDownloads = vi.fn(() => of({ total: 0, rows: [] }));

  beforeEach(async () => {
    listAlbumJobs.mockClear();
    getUntrackedDownloads.mockClear();
    listAlbumJobs.mockReturnValue(of({ jobs: [] }));
    getUntrackedDownloads.mockReturnValue(of({ total: 0, rows: [] }));

    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: ApiService, useValue: { listAlbumJobs, getUntrackedDownloads } },
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
      of({ total: 5, rows: [{ transferKey: 'k', username: 'u', directory: 'd', filename: 'f.mp3', basename: 'f.mp3', completedAt: 1 }] }),
    );
    const c = create();
    await c.loadUntracked();
    expect(c.untrackedTotal()).toBe(5);
    expect(c.untracked()).toHaveLength(1);
  });

  it('jobStateClass maps states to colors', () => {
    const c = create();
    expect(c.jobStateClass('exhausted')).toContain('red');
    expect(c.jobStateClass('active')).toContain('amber');
  });
});
