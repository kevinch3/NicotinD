import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { AlbumHuntModalComponent } from './album-hunt-modal.component';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { SearchApiService } from '../../services/api/search-api.service';
import type { DiscographyAlbum, FolderCandidate } from '../../services/api/api-types';
import type { ArchiveCandidate } from '../../../types/core';
import { TransferService } from '../../services/transfer.service';
import { AcquireService } from '../../services/acquire.service';
import { PluginService } from '../../services/plugin.service';

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
  // Two-phase hunt: startHunt() fires huntAlbumBase first, then huntAlbumSkew only
  // when the base phase reports skewNeeded.
  const huntAlbumBase = vi.fn(() => of({ candidates: [], totalTracks: 0, skewNeeded: false }));
  const huntAlbumSkew = vi.fn(() => of({ candidates: [] }));
  const huntDownload = vi.fn(() => of({}));
  const archiveSearchAlbum = vi.fn(() => of({ candidates: [] as ArchiveCandidate[] }));
  const acquireSubmit = vi.fn(() => Promise.resolve('job1'));
  let archiveEnabled = false;

  beforeEach(async () => {
    huntAlbumBase.mockClear();
    huntAlbumBase.mockReturnValue(of({ candidates: [], totalTracks: 0, skewNeeded: false }));
    huntAlbumSkew.mockClear();
    huntAlbumSkew.mockReturnValue(of({ candidates: [] }));
    huntDownload.mockClear();
    huntDownload.mockReturnValue(of({}));
    archiveSearchAlbum.mockClear();
    archiveSearchAlbum.mockReturnValue(of({ candidates: [] }));
    acquireSubmit.mockClear();
    archiveEnabled = false;

    await TestBed.configureTestingModule({
      imports: [AlbumHuntModalComponent],
      providers: [
        {
          provide: DownloadsApiService,
          useValue: { huntAlbumBase, huntAlbumSkew, huntDownload },
        },
        { provide: SearchApiService, useValue: { archiveSearchAlbum } },
        { provide: TransferService, useValue: { poll: vi.fn(), kickPoll: vi.fn() } },
        { provide: AcquireService, useValue: { submit: acquireSubmit } },
        { provide: PluginService, useValue: { hasArchive: () => archiveEnabled } },
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

  it('forwards the resolved localAlbumId so the server filters out on-disk tracks', async () => {
    const c = create();
    (c as unknown as { album: () => DiscographyAlbum }).album = () =>
      ({ ...ALBUM, localAlbumId: 'local-42' }) as DiscographyAlbum;
    c.candidates.set([candidate({ username: 'best' })]);

    await c.downloadSelected();

    expect(huntDownload).toHaveBeenCalledWith(
      ALBUM.lidarrId,
      expect.objectContaining({ localAlbumId: 'local-42' }),
      false,
    );
  });

  it('shows the already-complete notice (not a silent close) when the server queues nothing', async () => {
    huntDownload.mockReturnValue(of({ ok: true, queued: 0, alreadyComplete: true }));
    const c = create();
    (c as unknown as { album: () => DiscographyAlbum }).album = () => ALBUM;
    const closed = vi.fn();
    c.closed.subscribe(closed);
    c.candidates.set([candidate({ username: 'best' })]);

    await c.downloadSelected();

    expect(c.state()).toBe('already-complete');
    expect(closed).not.toHaveBeenCalled();
  });

  it('maps the 409 already-complete error to a positive notice, not the red error state', async () => {
    huntDownload.mockReturnValue(throwError(() => ({ error: { error: 'already-complete' } })));
    const c = create();
    (c as unknown as { album: () => DiscographyAlbum }).album = () => ALBUM;
    c.candidates.set([candidate({ username: 'best' })]);

    await c.downloadSelected();

    expect(c.state()).toBe('already-complete');
  });

  it('maps the 409 already-downloading error to the already-downloading notice', async () => {
    huntDownload.mockReturnValue(throwError(() => ({ error: { error: 'already-downloading' } })));
    const c = create();
    (c as unknown as { album: () => DiscographyAlbum }).album = () => ALBUM;
    c.candidates.set([candidate({ username: 'best' })]);

    await c.downloadSelected();

    expect(c.state()).toBe('already-downloading');
  });

  it('keeps a genuine failure in the red error state', async () => {
    huntDownload.mockReturnValue(throwError(() => new Error('peer offline')));
    const c = create();
    (c as unknown as { album: () => DiscographyAlbum }).album = () => ALBUM;
    c.candidates.set([candidate({ username: 'best' })]);

    await c.downloadSelected();

    expect(c.state()).toBe('error');
    expect(c.errorMsg()).toBe('peer offline');
  });

  it('searchArchive populates candidates when the archive plugin is enabled', async () => {
    archiveEnabled = true;
    archiveSearchAlbum.mockReturnValue(
      of({
        candidates: [
          { identifier: 'a1', title: 'Album', creator: 'Artist', year: '2016', detailsUrl: 'u1' },
        ],
      }),
    );
    const c = create();
    (c as unknown as { album: () => DiscographyAlbum }).album = () => ALBUM;
    (c as unknown as { artistName: () => string }).artistName = () => 'Test Artist';

    await c.searchArchive();

    expect(archiveSearchAlbum).toHaveBeenCalledWith('Test Artist', ALBUM.title);
    expect(c.archiveState()).toBe('done');
    expect(c.archiveCandidates().map((x) => x.identifier)).toEqual(['a1']);
  });

  it('searchArchive no-ops when the archive plugin is disabled', async () => {
    archiveEnabled = false;
    const c = create();
    (c as unknown as { album: () => DiscographyAlbum }).album = () => ALBUM;
    (c as unknown as { artistName: () => string }).artistName = () => 'Test Artist';

    await c.searchArchive();

    expect(archiveSearchAlbum).not.toHaveBeenCalled();
    expect(c.archiveState()).toBe('idle');
  });

  it('blends archive + Spotify into one otherSources list and getOtherSource submits a candidate', async () => {
    const c = create();
    const candidate = {
      id: 'archive:a1',
      source: 'archive' as const,
      sourceLabel: 'Internet Archive',
      title: 'Album',
      subtitle: 'Artist',
      score: 62,
      acquire: { via: 'url' as const, url: 'https://archive.org/details/a1' },
    };

    await c.getOtherSource(candidate);

    expect(acquireSubmit).toHaveBeenCalledWith('https://archive.org/details/a1');
    expect(c.isOtherSourceAcquired(candidate)).toBe(true);
  });

  it('passes the current skewSearch flag to the base hunt phase', async () => {
    const c = create();
    // Stub the required signal inputs directly (binding is unreliable in the
    // optimized CI test build).
    (c as unknown as { album: () => DiscographyAlbum }).album = () => ALBUM;
    (c as unknown as { artistName: () => string }).artistName = () => 'Test Artist';

    c.skewSearch.set(true);
    await c.startHunt();

    expect(huntAlbumBase).toHaveBeenCalledWith(
      ALBUM.lidarrId,
      expect.objectContaining({ skewSearch: true }),
    );
  });
});
