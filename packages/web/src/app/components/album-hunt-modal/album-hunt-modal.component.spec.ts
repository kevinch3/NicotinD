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

  beforeEach(async () => {
    huntAlbum.mockClear();
    huntAlbum.mockReturnValue(of({ candidates: [], totalTracks: 0 }));

    await TestBed.configureTestingModule({
      imports: [AlbumHuntModalComponent],
      providers: [
        { provide: ApiService, useValue: { huntAlbum } },
        { provide: TransferService, useValue: { poll: vi.fn() } },
      ],
    }).compileComponents();
  });

  function create() {
    const fixture = TestBed.createComponent(AlbumHuntModalComponent);
    fixture.componentRef.setInput('album', ALBUM);
    fixture.componentRef.setInput('artistName', 'Test Artist');
    return fixture;
  }

  it('uses the new filter defaults', () => {
    const c = create().componentInstance;
    expect(c.includeFlac()).toBe(true);
    expect(c.includeLive()).toBe(false);
    expect(c.minMatchPct()).toBe(10);
    expect(c.skewSearch()).toBe(false);
  });

  it('hides FLAC candidates when "Include flac" is unchecked', () => {
    const c = create().componentInstance;
    c.candidates.set([
      candidate({ username: 'flac', format: 'FLAC' }),
      candidate({ username: 'mp3', format: 'MP3 320kbps' }),
    ]);

    expect(c.filteredCandidates().map((x) => x.username)).toEqual(['flac', 'mp3']);

    c.includeFlac.set(false);
    expect(c.filteredCandidates().map((x) => x.username)).toEqual(['mp3']);
  });

  it('hides live candidates unless "Include live" is checked', () => {
    const c = create().componentInstance;
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
    const c = create().componentInstance;
    c.candidates.set([
      candidate({ username: 'high', matchPct: 80 }),
      candidate({ username: 'low', matchPct: 5 }),
    ]);

    // default min match is 10%
    expect(c.filteredCandidates().map((x) => x.username)).toEqual(['high']);
  });

  it('passes the current skewSearch flag to huntAlbum', async () => {
    const c = create().componentInstance;
    c.skewSearch.set(true);
    await c.startHunt();

    expect(huntAlbum).toHaveBeenCalledWith(
      ALBUM.lidarrId,
      expect.objectContaining({ skewSearch: true }),
    );
  });
});
