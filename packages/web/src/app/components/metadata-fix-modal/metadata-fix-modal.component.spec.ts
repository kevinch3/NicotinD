import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of } from 'rxjs';
import type { AlbumCoverCandidate } from '../../../types/core';
import { MetadataFixModalComponent } from './metadata-fix-modal.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { ReviewApiService } from '../../services/api/review-api.service';
import { AuthService } from '../../services/auth.service';
import { ServerConfigService } from '../../services/server-config.service';
import { ConfirmService } from '../../services/confirm.service';
import { ToastService } from '../../services/toast.service';
import { TranslateService } from '../../services/translate.service';
import type { ReviewQueueAlbum, SongSteps } from '../../services/api/api-types';

// Instantiated without detectChanges (so ngOnInit, which reads required inputs,
// never runs); the cover-apply logic is exercised directly. Input binding is
// unreliable under the optimized JIT test build, so albumId is set explicitly.
describe('MetadataFixModalComponent cover picker', () => {
  const getCoverCandidates = vi.fn(() => of({ current: null, lidarr: [], files: [] }));
  const applyCover = vi.fn(() => of({ ok: true }));
  const uploadAlbumCover = vi.fn(() => of({ ok: true }));

  function create() {
    getCoverCandidates.mockClear();
    applyCover.mockClear();
    uploadAlbumCover.mockClear();
    getCoverCandidates.mockReturnValue(of({ current: null, lidarr: [], files: [] }));
    applyCover.mockReturnValue(of({ ok: true }));
    uploadAlbumCover.mockReturnValue(of({ ok: true }));

    TestBed.configureTestingModule({
      imports: [MetadataFixModalComponent],
      providers: [
        {
          provide: LibraryApiService,
          useValue: {
            getCoverCandidates,
            applyCover,
            uploadAlbumCover,
            getMetadataCandidates: vi.fn(),
            deleteSongs: vi.fn(() => of({ ok: true, deletedCount: 1 })),
          },
        },
        {
          provide: ReviewApiService,
          useValue: {
            identifySong: vi.fn(),
            identifyAlbum: vi.fn(),
            retagTracks: vi.fn(),
          },
        },
        { provide: AuthService, useValue: { token: () => 'tok' } },
        { provide: ServerConfigService, useValue: { apiUrl: (p: string) => p } },
        { provide: ConfirmService, useValue: { ask: vi.fn(() => Promise.resolve(true)) } },
        { provide: ToastService, useValue: { show: vi.fn() } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    });
    const fixture = TestBed.createComponent(MetadataFixModalComponent);
    const c = fixture.componentInstance;
    // Input binding is unreliable under the optimized JIT test build, so stub the
    // required albumId signal directly on the instance.
    (c as unknown as { albumId: () => string }).albumId = () => 'album-1';
    return c;
  }

  const lidarr: AlbumCoverCandidate = { source: 'lidarr', url: 'https://img/x.jpg', label: 'X' };
  const current: AlbumCoverCandidate = {
    source: 'current',
    url: '/api/cover/album-1',
    label: 'Current',
  };

  it('applies a Lidarr cover by URL and emits coverChanged', async () => {
    const c = create();
    const emitted = vi.fn();
    c.coverChanged.subscribe(emitted);

    await c.selectCover(lidarr);

    expect(applyCover).toHaveBeenCalledWith('album-1', { coverUrl: 'https://img/x.jpg' });
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it('does not apply when the current cover is selected', async () => {
    const c = create();
    await c.selectCover(current);
    expect(applyCover).not.toHaveBeenCalled();
  });

  it('applies a pasted custom URL and clears the input', async () => {
    const c = create();
    c.customCoverUrl.set('  https://img/custom.jpg ');
    await c.applyCustomCover();
    expect(applyCover).toHaveBeenCalledWith('album-1', { coverUrl: 'https://img/custom.jpg' });
    expect(c.customCoverUrl()).toBe('');
  });

  it('refuses a blank custom URL with a message', async () => {
    const c = create();
    c.customCoverUrl.set('   ');
    await c.applyCustomCover();
    expect(applyCover).not.toHaveBeenCalled();
    expect(c.msg()).toBeTruthy();
  });

  it('uploads a selected file and emits coverChanged', async () => {
    const c = create();
    const emitted = vi.fn();
    c.coverChanged.subscribe(emitted);
    const file = new File([new Uint8Array([1, 2, 3])], 'cover.png', { type: 'image/png' });
    const event = { target: { files: [file], value: 'x' } } as unknown as Event;

    await c.onCoverFileSelected(event);

    expect(uploadAlbumCover).toHaveBeenCalledWith('album-1', file);
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no file is selected for upload', async () => {
    const c = create();
    const event = { target: { files: [], value: '' } } as unknown as Event;
    await c.onCoverFileSelected(event);
    expect(uploadAlbumCover).not.toHaveBeenCalled();
  });
});

// Review mode (issue #411 Task 12): the per-track grid, per-track/album
// fingerprint identify, and Save tracks. ngOnInit IS invoked here (directly,
// not via detectChanges) since it's what seeds `tracks()` from the
// `reviewTracks` input and kicks the candidate search.
describe('MetadataFixModalComponent review mode', () => {
  const doneSteps: SongSteps = {
    download: 'done',
    bpm: 'done',
    key: 'done',
    energy: 'done',
    genre: 'done',
    mood: 'done',
  };
  const reviewSongs: ReviewQueueAlbum['songs'] = [
    { id: 's1', title: 'Track One', track: 1, steps: doneSteps },
    { id: 's2', title: 'Track Two', track: 2, steps: doneSteps },
  ];

  const getMetadataCandidates = vi.fn();
  const getCoverCandidates = vi.fn(() => of({ current: null, lidarr: [], files: [] }));
  const deleteSongs = vi.fn(() => of({ ok: true, deletedCount: 1 }));
  const getCanonicalTracklist = vi.fn();
  const identifySong = vi.fn();
  const identifyAlbum = vi.fn();
  const retagTracks = vi.fn();
  const confirmAsk = vi.fn(() => Promise.resolve(true));
  const toastShow = vi.fn();

  function create() {
    getMetadataCandidates.mockReset();
    getCoverCandidates.mockClear();
    deleteSongs.mockClear();
    getCanonicalTracklist.mockReset();
    identifySong.mockReset();
    identifyAlbum.mockReset();
    retagTracks.mockReset();
    confirmAsk.mockReset().mockReturnValue(Promise.resolve(true));
    toastShow.mockClear();
    getMetadataCandidates.mockReturnValue(
      of({
        album: { id: 'album-1', name: 'Album', artist: 'Artist' },
        query: 'Artist Album',
        candidates: [],
        sources: [],
        identifyAvailable: true,
      }),
    );

    TestBed.configureTestingModule({
      imports: [MetadataFixModalComponent],
      providers: [
        {
          provide: LibraryApiService,
          useValue: {
            getCoverCandidates,
            getMetadataCandidates,
            deleteSongs,
            getCanonicalTracklist,
          },
        },
        { provide: ReviewApiService, useValue: { identifySong, identifyAlbum, retagTracks } },
        { provide: AuthService, useValue: { token: () => 'tok' } },
        { provide: ServerConfigService, useValue: { apiUrl: (p: string) => p } },
        { provide: ConfirmService, useValue: { ask: confirmAsk } },
        { provide: ToastService, useValue: { show: toastShow } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    });
    const fixture = TestBed.createComponent(MetadataFixModalComponent);
    const c = fixture.componentInstance;
    (c as unknown as { albumId: () => string }).albumId = () => 'album-1';
    (c as unknown as { currentArtist: () => string }).currentArtist = () => 'Artist';
    (c as unknown as { currentAlbum: () => string }).currentAlbum = () => 'Album';
    (c as unknown as { reviewTracks: () => ReviewQueueAlbum['songs'] }).reviewTracks = () =>
      reviewSongs;
    return c;
  }

  it('exposes tracks state seeded from the reviewTracks input, ordered by track number', async () => {
    const c = create();
    c.ngOnInit();
    await Promise.resolve();
    expect(c.tracks().map((t) => t.id)).toEqual(['s1', 's2']);
    expect(c.isReviewMode()).toBe(true);
  });

  it('saveTracks posts only dirty rows, emits tracksSaved, and clears the dirty flag on success', async () => {
    const c = create();
    c.ngOnInit();
    await Promise.resolve();
    retagTracks.mockReturnValue(of({ updated: 1, failed: [], rescanned: true }));
    const emitted = vi.fn();
    c.tracksSaved.subscribe(emitted);

    c.onTrackTitleChange('s1', 'New Title');
    await c.saveTracks();

    expect(retagTracks).toHaveBeenCalledWith('album-1', [{ id: 's1', title: 'New Title' }]);
    expect(emitted).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'success', message: 'review.tracksSaved' }),
    );
    expect(c.tracks().find((t) => t.id === 's1')).toMatchObject({ dirtyTitle: false });
  });

  it('a partial failure sets msg, shows no success toast, does not emit tracksSaved, and only clears the succeeded row', async () => {
    const c = create();
    c.ngOnInit();
    await Promise.resolve();
    retagTracks.mockReturnValue(
      of({
        updated: 1,
        failed: [{ id: 's2', error: 'Invalid path' }],
        rescanned: true,
      }),
    );
    const emitted = vi.fn();
    c.tracksSaved.subscribe(emitted);

    c.onTrackTitleChange('s1', 'New Title');
    c.onTrackTitleChange('s2', 'Bad Title');
    await c.saveTracks();

    expect(emitted).not.toHaveBeenCalled();
    expect(toastShow).not.toHaveBeenCalled();
    expect(c.msg()).toBe('review.tracksPartial');
    expect(c.tracks().find((t) => t.id === 's1')).toMatchObject({
      title: 'New Title',
      dirtyTitle: false,
    });
    expect(c.tracks().find((t) => t.id === 's2')).toMatchObject({
      title: 'Bad Title',
      dirtyTitle: true,
    });
  });

  it('does not save when no row is dirty', async () => {
    const c = create();
    c.ngOnInit();
    await Promise.resolve();
    await c.saveTracks();
    expect(retagTracks).not.toHaveBeenCalled();
  });

  it('identify-album vote prefills manualArtist/manualAlbum and injects a top candidate', async () => {
    const c = create();
    c.ngOnInit();
    await Promise.resolve();
    identifyAlbum.mockReturnValue(
      of({
        perTrack: [],
        vote: { artist: 'Voted Artist', album: 'Voted Album', votes: 3, total: 4 },
      }),
    );

    await c.identifyAlbumFingerprint();

    expect(c.manualArtist()).toBe('Voted Artist');
    expect(c.manualAlbum()).toBe('Voted Album');
    expect(c.candidates()[0]).toMatchObject({
      artist: 'Voted Artist',
      title: 'Voted Album',
      source: 'acoustid',
      score: 75,
    });
  });

  it('identifyTrack merges a per-track fingerprint match into the grid', async () => {
    const c = create();
    c.ngOnInit();
    await Promise.resolve();
    identifySong.mockReturnValue(of({ result: { acoustId: 'x', score: 0.9, title: 'Fixed' } }));

    await c.identifyTrack(c.tracks()[0]!);

    expect(c.tracks()[0]).toMatchObject({ id: 's1', title: 'Fixed', dirtyTitle: true });
    expect(c.identifyFailure('s1')).toBeUndefined();
  });

  // Issue #414: the four ways an identify can come back empty ask for opposite
  // curator actions, so they must not render (or toast) identically.
  describe('identify failure taxonomy (issue #414)', () => {
    it('records an undecodable file with its stderr detail and warns', async () => {
      const c = create();
      c.ngOnInit();
      await Promise.resolve();
      identifySong.mockReturnValue(
        of({ result: null, outcome: { kind: 'undecodable', detail: 'ERROR: invalid data' } }),
      );

      await c.identifyTrack(c.tracks()[0]!);

      expect(c.identifyFailure('s1')).toEqual({
        kind: 'undecodable',
        detail: 'ERROR: invalid data',
      });
      // A broken file is an error, not the neutral "nothing found" note.
      expect(toastShow).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'error', message: 'review.identifyUndecodable' }),
      );
    });

    it('keeps a genuine no-match neutral', async () => {
      const c = create();
      c.ngOnInit();
      await Promise.resolve();
      identifySong.mockReturnValue(of({ result: null, outcome: { kind: 'no-match' } }));

      await c.identifyTrack(c.tracks()[0]!);

      expect(c.identifyFailure('s1')).toEqual({ kind: 'no-match', detail: undefined });
      expect(toastShow).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'info', message: 'review.identifyNoMatch' }),
      );
    });

    it('maps every kind to its own copy', () => {
      const c = create();
      expect(c.identifyFailureLabel('fpcalc-missing')).toBe('review.identifyFpcalcMissing');
      expect(c.identifyFailureLabel('undecodable')).toBe('review.identifyUndecodable');
      expect(c.identifyFailureLabel('source-error')).toBe('review.identifySourceError');
      expect(c.identifyFailureLabel('file-missing')).toBe('review.identifyFileMissing');
      expect(c.identifyFailureLabel('no-match')).toBe('review.identifyNoMatch');
    });

    it('a later match clears a previously recorded failure', async () => {
      const c = create();
      c.ngOnInit();
      await Promise.resolve();
      identifySong.mockReturnValue(of({ result: null, outcome: { kind: 'source-error' } }));
      await c.identifyTrack(c.tracks()[0]!);
      expect(c.identifyFailure('s1')?.kind).toBe('source-error');

      identifySong.mockReturnValue(of({ result: { acoustId: 'x', score: 0.9, title: 'Fixed' } }));
      await c.identifyTrack(c.tracks()[0]!);
      expect(c.identifyFailure('s1')).toBeUndefined();
    });

    it('album identify records per-track failures alongside its matches', async () => {
      const c = create();
      c.ngOnInit();
      await Promise.resolve();
      identifyAlbum.mockReturnValue(
        of({
          perTrack: [
            { songId: 's1', result: { acoustId: 'x', score: 0.9, title: 'Fixed' } },
            { songId: 's2', result: null, outcome: { kind: 'undecodable', detail: 'bad frame' } },
          ],
          vote: null,
        }),
      );

      await c.identifyAlbumFingerprint();

      expect(c.identifyFailure('s1')).toBeUndefined();
      expect(c.identifyFailure('s2')).toEqual({ kind: 'undecodable', detail: 'bad frame' });
    });
  });

  it('removeTrack confirms, deletes, and drops the row', async () => {
    const c = create();
    c.ngOnInit();
    await Promise.resolve();

    await c.removeTrack(c.tracks()[0]!);

    expect(deleteSongs).toHaveBeenCalledWith(['s1']);
    expect(c.tracks().map((t) => t.id)).toEqual(['s2']);
  });

  // Issue #413: MusicBrainz is the one candidate source with a per-track
  // tracklist, so the action is offered only when an MB candidate is present.
  describe('apply canonical tracklist (issue #413)', () => {
    function withMbCandidate(c: ReturnType<typeof create>) {
      c.candidates.set([
        {
          releaseGroupId: 'rg-1',
          artist: 'Artist',
          title: 'Album',
          year: null,
          releaseType: null,
          coverUrl: null,
          score: 90,
          source: 'musicbrainz',
        },
      ]);
    }

    it('is offered only for a MusicBrainz candidate carrying a release-group id', () => {
      const c = create();
      expect(c.tracklistCandidate()).toBeNull();

      c.candidates.set([
        {
          releaseGroupId: null,
          artist: 'A',
          title: 'B',
          year: null,
          releaseType: null,
          coverUrl: null,
          score: 50,
          source: 'lidarr',
        },
      ]);
      expect(c.tracklistCandidate()).toBeNull();

      withMbCandidate(c);
      expect(c.tracklistCandidate()?.releaseGroupId).toBe('rg-1');
    });

    it('fills the grid by position and leaves the rows dirty for the curator to save', async () => {
      const c = create();
      c.ngOnInit();
      await Promise.resolve();
      withMbCandidate(c);
      getCanonicalTracklist.mockReturnValue(
        of({
          tracks: [
            { position: 1, title: 'Canonical One' },
            { position: 2, title: 'Canonical Two' },
          ],
        }),
      );

      await c.applyCanonicalTitles();

      expect(getCanonicalTracklist).toHaveBeenCalledWith('rg-1');
      expect(c.tracks().map((t) => [t.title, t.dirtyTitle])).toEqual([
        ['Canonical One', true],
        ['Canonical Two', true],
      ]);
      // Nothing is persisted here — saving stays the curator's explicit step.
      expect(retagTracks).not.toHaveBeenCalled();
    });

    it('says so when MusicBrainz has no tracklist, without touching the grid', async () => {
      const c = create();
      c.ngOnInit();
      await Promise.resolve();
      withMbCandidate(c);
      const before = c.tracks().map((t) => t.title);
      getCanonicalTracklist.mockReturnValue(of({ tracks: [] }));

      await c.applyCanonicalTitles();

      expect(c.tracks().map((t) => t.title)).toEqual(before);
      expect(toastShow).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'review.tracklistEmpty' }),
      );
    });

    it('does nothing when there is no MusicBrainz candidate', async () => {
      const c = create();
      c.ngOnInit();
      await Promise.resolve();
      await c.applyCanonicalTitles();
      expect(getCanonicalTracklist).not.toHaveBeenCalled();
    });
  });
});
