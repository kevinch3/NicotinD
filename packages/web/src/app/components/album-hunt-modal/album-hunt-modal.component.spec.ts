import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of } from 'rxjs';
import { AlbumHuntModalComponent } from './album-hunt-modal.component';
import {
  ApiService,
  type DiscographyAlbum,
  type FolderCandidate,
} from '../../services/api.service';
import { TransferService } from '../../services/transfer.service';

const ALBUM: DiscographyAlbum = {
  lidarrId: 42,
  foreignAlbumId: 'fa42',
  title: 'Test Album',
} as DiscographyAlbum;

function candidate(overrides: Partial<FolderCandidate>): FolderCandidate {
  return {
    directory: 'Artist/Album',
    username: 'user',
    files: [{ filename: 'Artist/Album/01 Song.flac', size: 1 }],
    matchedTracks: 10,
    totalTracks: 10,
    matchPct: 100,
    format: 'FLAC',
    estimatedSizeMb: 100,
    isLive: false,
    freeUploadSlots: 1,
    queueLength: 0,
    uploadSpeed: 1,
    ...overrides,
  } as FolderCandidate;
}

describe('AlbumHuntModalComponent', () => {
  const huntAlbum = vi.fn(() => of({ candidates: [], totalTracks: 0 }));
  const huntDownload = vi.fn(() => of({}));

  beforeEach(async () => {
    huntAlbum.mockClear();
    huntAlbum.mockReturnValue(of({ candidates: [], totalTracks: 0 }));
    huntDownload.mockClear();
    huntDownload.mockReturnValue(of({}));

    await TestBed.configureTestingModule({
      imports: [AlbumHuntModalComponent],
      providers: [
        { provide: ApiService, useValue: { huntAlbum, huntDownload } },
        { provide: TransferService, useValue: { poll: vi.fn() } },
      ],
    }).compileComponents();
  });

  // We instantiate without detectChanges so ngOnInit (which reads the required
  // inputs) never runs — the filter logic and startHunt() are exercised
  // directly. The required `album`/`artistName` signal inputs are stubbed on
  // the instance for the one test that needs them, because input binding is
  // unreliable under the optimized test build CI runs.
  function create() {
    const fixture = TestBed.createComponent(AlbumHuntModalComponent);
    return fixture.componentInstance;
  }

  it('uses the new filter defaults', () => {
    const c = create();
    expect(c.includeFlac()).toBe(true);
    expect(c.includeLive()).toBe(false);
    expect(c.minMatchPct()).toBe(10);
    expect(c.skewSearch()).toBe(true);
  });

  it('hides FLAC candidates when "Include flac" is unchecked', () => {
    const c = create();
    c.candidates.set([
      candidate({ username: 'flac', format: 'FLAC' }),
      candidate({ username: 'mp3', format: 'MP3 320kbps' }),
    ]);

    expect(c.filteredCandidates().map((x) => x.username)).toEqual(['flac', 'mp3']);

    c.includeFlac.set(false);
    expect(c.filteredCandidates().map((x) => x.username)).toEqual(['mp3']);
  });

  it('hides live candidates unless "Include live" is checked', () => {
    const c = create();
    c.candidates.set([
      candidate({ username: 'studio', isLive: false }),
      candidate({ username: 'live', isLive: true }),
    ]);

    // default: include live is off
    expect(c.filteredCandidates().map((x) => x.username)).toEqual(['studio']);

    c.includeLive.set(true);
    expect(c.filteredCandidates().map((x) => x.username)).toEqual(['studio', 'live']);
  });

  it('hides candidates below the minimum match %', () => {
    const c = create();
    c.candidates.set([
      candidate({ username: 'high', matchPct: 80 }),
      candidate({ username: 'low', matchPct: 5 }),
    ]);

    // default min match is 10%
    expect(c.filteredCandidates().map((x) => x.username)).toEqual(['high']);
  });

  it('defaults the effective candidate to the best (first ranked) with no manual pick', () => {
    const c = create();
    c.candidates.set([
      candidate({ username: 'best', matchPct: 100 }),
      candidate({ username: 'second', matchPct: 80 }),
    ]);
    expect(c.selectedCandidate()).toBeNull();
    expect(c.effectiveCandidate()?.username).toBe('best');
    expect(c.isAutoBest(c.filteredCandidates()[0])).toBe(true);
    expect(c.isSelected(c.filteredCandidates()[0])).toBe(true);
  });

  it('lets an explicit row selection override the auto-best', () => {
    const c = create();
    const best = candidate({ username: 'best', matchPct: 100 });
    const second = candidate({ username: 'second', matchPct: 80 });
    c.candidates.set([best, second]);

    c.select(second);
    expect(c.effectiveCandidate()?.username).toBe('second');
    expect(c.isAutoBest(best)).toBe(false);

    // toggling the same row off falls back to the auto-best
    c.select(second);
    expect(c.effectiveCandidate()?.username).toBe('best');
  });

  it('downloads the best candidate (rest as alternates) with a single tap, no manual pick', async () => {
    const c = create();
    (c as unknown as { album: () => DiscographyAlbum }).album = () => ALBUM;
    const best = candidate({ username: 'best', directory: 'A/Best' });
    const alt = candidate({ username: 'alt', directory: 'A/Alt', matchPct: 80 });
    c.candidates.set([best, alt]);

    await c.downloadSelected();

    expect(huntDownload).toHaveBeenCalledWith(
      ALBUM.lidarrId,
      expect.objectContaining({
        selected: expect.objectContaining({ username: 'best', directory: 'A/Best' }),
        alternates: expect.arrayContaining([expect.objectContaining({ username: 'alt' })]),
      }),
      false,
    );
  });

  it('passes the current skewSearch flag to huntAlbum', async () => {
    const c = create();
    // Stub the required signal inputs directly (binding is unreliable in the
    // optimized CI test build).
    (c as unknown as { album: () => DiscographyAlbum }).album = () => ALBUM;
    (c as unknown as { artistName: () => string }).artistName = () => 'Test Artist';

    c.skewSearch.set(true);
    await c.startHunt();

    expect(huntAlbum).toHaveBeenCalledWith(
      ALBUM.lidarrId,
      expect.objectContaining({ skewSearch: true }),
    );
  });
});
