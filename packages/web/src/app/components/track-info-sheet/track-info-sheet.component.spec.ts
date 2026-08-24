import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { vi } from 'vitest';
import { asRole, canCurate as canCurateRole } from '../../../types/core';
import { of, throwError } from 'rxjs';
import { TrackInfoSheetComponent } from './track-info-sheet.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { LikeService } from '../../services/like.service';
import { TranslateService } from '../../services/translate.service';

// Instantiated without detectChanges so ngOnInit (which reads required inputs +
// fetches provenance) never runs; the analysis methods are exercised directly.
// The required `songId` signal input is stubbed on the instance because input
// binding is unreliable under the optimized test build CI runs.
describe('TrackInfoSheetComponent (analysis)', () => {
  const analyzeSong = vi.fn(() => of({ bpm: 122, source: 'analyzed' as const }));
  const getGenreSuggestion = vi.fn(() =>
    of({
      current: 'IDM',
      suggested: 'Electronic',
      candidates: ['Electronic', 'IDM'],
      source: 'lidarr' as const,
    }),
  );
  const applyGenre = vi.fn(() => of({ ok: true, genre: 'Electronic' }));
  const getLicenceSuggestion = vi.fn(() =>
    of({ current: null, suggested: 'cc-by', source: 'musicbrainz' as const }),
  );
  const setLicence = vi.fn(() => of({ ok: true, licence: 'cc-by' as string | null }));
  const getSong = vi.fn(() => of({ id: 'song-1', bpm: 128, genre: 'Latin' } as never));
  const getIdentifyAvailable = vi.fn(() => of({ available: true }));
  const identifyLibrarySong = vi.fn(() =>
    of({ result: null, outcome: { kind: 'no-match' } } as never),
  );
  const applyIdentify = vi.fn(() => of({ ok: true, rescanned: true }));
  const role = signal<string | null>('admin');

  beforeEach(async () => {
    analyzeSong.mockClear();
    analyzeSong.mockReturnValue(of({ bpm: 122, source: 'analyzed' as const }));
    getGenreSuggestion.mockClear();
    applyGenre.mockClear();
    applyGenre.mockReturnValue(of({ ok: true, genre: 'Electronic' }));
    getLicenceSuggestion.mockClear();
    setLicence.mockClear();
    setLicence.mockReturnValue(of({ ok: true, licence: 'cc-by' as string | null }));
    getSong.mockClear();
    getSong.mockReturnValue(of({ id: 'song-1', bpm: 128, genre: 'Latin' } as never));
    getIdentifyAvailable.mockClear();
    identifyLibrarySong.mockClear();
    identifyLibrarySong.mockReturnValue(
      of({ result: null, outcome: { kind: 'no-match' } } as never),
    );
    applyIdentify.mockClear();
    applyIdentify.mockReturnValue(of({ ok: true, rescanned: true }));
    role.set('admin');

    await TestBed.configureTestingModule({
      imports: [TrackInfoSheetComponent],
      providers: [
        {
          provide: LibraryApiService,
          useValue: {
            analyzeSong,
            getGenreSuggestion,
            applyGenre,
            getLicenceSuggestion,
            setLicence,
            getSong,
            getSongProvenance: vi.fn(() => of([])),
            getSongAcquisition: vi.fn(() => of(null)),
            getLyrics: vi.fn(() => of(null)),
            getIdentifyAvailable,
            identifyLibrarySong,
            applyIdentify,
          },
        },
        { provide: TranslateService, useValue: { t: (k: string) => k } },
        {
          provide: AuthService,
          useValue: { role, canCurate: computed(() => canCurateRole(asRole(role()))) },
        },
        { provide: LikeService, useValue: { isLiked: () => false, toggle: vi.fn() } },
      ],
    }).compileComponents();
  });

  function create() {
    const c = TestBed.createComponent(TrackInfoSheetComponent).componentInstance;
    (c as unknown as { songId: () => string }).songId = () => 'song-1';
    return c;
  }

  it('analyze() stores the detected bpm and its source', () => {
    const c = create();
    expect(c.bpm()).toBeNull();
    c.analyze();
    expect(analyzeSong).toHaveBeenCalledWith('song-1');
    expect(c.bpm()).toBe(122);
    expect(c.bpmSource()).toBe('analyzed');
    expect(c.analyzing()).toBe(false);
  });

  it('analyze() clears the spinner on error', () => {
    analyzeSong.mockReturnValueOnce(throwError(() => new Error('boom')));
    const c = create();
    c.analyze();
    expect(c.analyzing()).toBe(false);
    expect(c.bpm()).toBeNull();
  });

  it('verifyGenreNow() loads the suggestion', () => {
    const c = create();
    c.verifyGenreNow();
    expect(getGenreSuggestion).toHaveBeenCalledWith('song-1');
    expect(c.genreSuggestion()?.suggested).toBe('Electronic');
  });

  it('applySuggestedGenre() appends, and adopts the server-returned set', () => {
    // Issue #684: the server appends, but the sheet used to overwrite its whole
    // chip list with just the applied genre — so an append rendered as a wipe.
    applyGenre.mockReturnValueOnce(
      of({ ok: true, genre: 'Latin', genres: ['Latin', 'Electronic'] }) as never,
    );
    const c = create();
    c.applySuggestedGenre('Electronic');
    expect(applyGenre).toHaveBeenCalledWith('song-1', 'Electronic', 'append');
    expect(c.genreList()).toEqual(['Latin', 'Electronic']);
  });

  it('detectLicenceNow() loads the licence suggestion', () => {
    const c = create();
    c.detectLicenceNow();
    expect(getLicenceSuggestion).toHaveBeenCalledWith('song-1');
    expect(c.licenceSuggestion()?.suggested).toBe('cc-by');
    expect(c.detectingLicence()).toBe(false);
  });

  it('applyLicence() sets the current licence code + label on success', () => {
    const c = create();
    expect(c.currentLicence()).toBe('unknown');
    c.applyLicence('cc-by');
    expect(setLicence).toHaveBeenCalledWith('song-1', 'cc-by');
    expect(c.currentLicence()).toBe('cc-by');
    expect(c.currentLicenceLabel()).toBe('CC BY');
  });

  it('applyLicence() reflects a cleared (null) licence as unknown', () => {
    setLicence.mockReturnValueOnce(of({ ok: true, licence: null }));
    const c = create();
    c.applyLicence('unknown');
    expect(c.currentLicence()).toBe('unknown');
    expect(c.currentLicenceLabel()).toBe('Unknown');
  });

  it('ngOnInit fetches the song by id and shows its stored bpm + genre', () => {
    // The player opens the sheet with only a songId (no Song input), so without
    // the lazy fetch the stored analysis would render as "Unknown".
    const c = create();
    c.ngOnInit();
    expect(getSong).toHaveBeenCalledWith('song-1');
    expect(c.bpm()).toBe(128);
    expect(c.bpmSource()).toBe('tag');
    expect(c.currentGenre()).toBe('Latin');
  });

  it('canCurate() reflects the auth role (admin/refiner yes, user/listener no)', () => {
    const c = create();
    expect(c.canCurate()).toBe(true);
    role.set('refiner');
    expect(c.canCurate()).toBe(true);
    role.set('user');
    expect(c.canCurate()).toBe(false);
    role.set('listener');
    expect(c.canCurate()).toBe(false);
  });

  it('featureRows() renders percentages, key and capitalized mood from the loaded song', () => {
    getSong.mockReturnValueOnce(
      of({
        id: 'song-1',
        key: 'A minor',
        energy: 0.72,
        mood: 'party',
        valence: 0.405,
        danceability: 0.88,
        acousticness: 0.05,
        instrumental: 1,
      } as never),
    );
    const c = create();
    c.ngOnInit();
    const rows = Object.fromEntries(c.featureRows().map((r) => [r.label, r.value]));
    expect(rows['Key']).toBe('A minor');
    expect(rows['Energy']).toBe('72%');
    expect(rows['Mood']).toBe('Party');
    expect(rows['Valence']).toBe('41%');
    expect(rows['Dance']).toBe('88%');
    expect(rows['Acoustic']).toBe('5%');
    expect(rows['Instrumental']).toBe('100%');
  });

  it('featureRows() shows null values for an un-analyzed song', () => {
    const c = create(); // default getSong: only bpm + genre
    c.ngOnInit();
    for (const r of c.featureRows()) expect(r.value).toBeNull();
  });

  it('ngOnInit loads the identify availability flag for a curator', () => {
    const c = create();
    c.ngOnInit();
    expect(getIdentifyAvailable).toHaveBeenCalled();
    expect(c.identifyAvailable()).toBe(true);
  });

  it('identifyNow() stores the suggestion on a match', () => {
    const result = {
      acoustId: 'ac-1',
      score: 0.95,
      title: 'Real Title',
      artist: 'Real Artist',
      album: 'Real Album',
    };
    identifyLibrarySong.mockReturnValueOnce(
      of({ result, outcome: { kind: 'match' as const, result } } as never),
    );
    const c = create();
    c.identifyNow();
    expect(identifyLibrarySong).toHaveBeenCalledWith('song-1');
    expect(c.identifySuggestion()?.title).toBe('Real Title');
    expect(c.identifyFailure()).toBeNull();
    expect(c.identifying()).toBe(false);
  });

  it('identifyNow() stores a typed failure and clears the spinner', () => {
    identifyLibrarySong.mockReturnValueOnce(
      of({ result: null, outcome: { kind: 'undecodable' as const, detail: 'bad data' } } as never),
    );
    const c = create();
    c.identifyNow();
    expect(c.identifySuggestion()).toBeNull();
    expect(c.identifyFailure()).toEqual({ kind: 'undecodable', detail: 'bad data' });
    expect(c.identifyFailureLabel()).toBe('review.identifyUndecodable');
    expect(c.identifying()).toBe(false);
  });

  it('identifyNow() clears the spinner on transport error', () => {
    identifyLibrarySong.mockReturnValueOnce(throwError(() => new Error('boom')));
    const c = create();
    c.identifyNow();
    expect(c.identifying()).toBe(false);
    expect(c.identifyFailure()?.kind).toBe('source-error');
  });

  it('applyIdentifyNow() sends the suggestion fields, marks applied, and refetches the song', () => {
    const result = {
      acoustId: 'ac-1',
      score: 0.9,
      title: 'Real Title',
      artist: 'Real Artist',
      album: 'Real Album',
      albumArtist: 'Real Artist',
      year: 2001,
      trackNumber: 3,
      recordingId: 'rec-1',
      releaseId: 'rel-1',
    };
    identifyLibrarySong.mockReturnValueOnce(
      of({ result, outcome: { kind: 'match' as const, result } } as never),
    );
    getSong.mockReturnValue(of({ id: 'song-1', title: 'Real Title' } as never));
    const c = create();
    c.identifyNow();
    c.applyIdentifyNow();
    expect(applyIdentify).toHaveBeenCalledWith('song-1', {
      title: 'Real Title',
      artist: 'Real Artist',
      album: 'Real Album',
      albumArtist: 'Real Artist',
      year: 2001,
      trackNumber: 3,
      acoustId: 'ac-1',
      recordingId: 'rec-1',
      releaseId: 'rel-1',
    });
    expect(c.identifyApplied()).toBe(true);
    expect(c.identifySuggestion()).toBeNull();
    expect(getSong).toHaveBeenCalledWith('song-1');
    expect(c.effectiveSong()?.title).toBe('Real Title');
  });

  it('applyIdentifyNow() clears the busy flag on error', () => {
    const result = { acoustId: 'ac-1', score: 0.9, title: 'T' };
    identifyLibrarySong.mockReturnValueOnce(
      of({ result, outcome: { kind: 'match' as const, result } } as never),
    );
    applyIdentify.mockReturnValueOnce(throwError(() => new Error('boom')));
    const c = create();
    c.identifyNow();
    c.applyIdentifyNow();
    expect(c.applyingIdentify()).toBe(false);
    expect(c.identifyApplied()).toBe(false);
  });
});

describe('TrackInfoSheetComponent (multi-genre chips)', () => {
  const role = signal<string | null>('admin');
  const getSong = vi.fn(() => of({ id: 'song-1' } as never));

  beforeEach(async () => {
    getSong.mockClear();
    await TestBed.configureTestingModule({
      imports: [TrackInfoSheetComponent],
      providers: [
        {
          provide: LibraryApiService,
          useValue: {
            analyzeSong: vi.fn(() => of({ bpm: 120, source: 'analyzed' as const })),
            getGenreSuggestion: vi.fn(() => of(null)),
            applyGenre: vi.fn(() => of({ ok: true, genre: 'X' })),
            getSong,
            getSongProvenance: vi.fn(() => of([])),
            getSongAcquisition: vi.fn(() => of(null)),
            getLyrics: vi.fn(() => of(null)),
            getIdentifyAvailable: vi.fn(() => of({ available: false })),
            identifyLibrarySong: vi.fn(() => of({ result: null, outcome: { kind: 'no-match' } })),
            applyIdentify: vi.fn(() => of({ ok: true, rescanned: true })),
          },
        },
        { provide: TranslateService, useValue: { t: (k: string) => k } },
        {
          provide: AuthService,
          useValue: { role, canCurate: computed(() => canCurateRole(asRole(role()))) },
        },
        { provide: LikeService, useValue: { isLiked: () => false, toggle: vi.fn() } },
      ],
    }).compileComponents();
  });

  function create() {
    const c = TestBed.createComponent(TrackInfoSheetComponent).componentInstance;
    (c as unknown as { songId: () => string }).songId = () => 'song-1';
    return c;
  }

  it('genreList() prefers the full set (primary first) over the single genre', () => {
    getSong.mockReturnValue(
      of({ id: 'song-1', genre: 'Electronic', genres: ['Electronic', 'House', 'Techno'] } as never),
    );
    const c = create();
    c.ngOnInit();
    expect(c.genreList()).toEqual(['Electronic', 'House', 'Techno']);
  });

  it('genreList() falls back to the single genre, and empty when none', () => {
    getSong.mockReturnValue(of({ id: 'song-1', genre: 'Latin' } as never));
    const c = create();
    c.ngOnInit();
    expect(c.genreList()).toEqual(['Latin']);

    getSong.mockReturnValue(of({ id: 'song-2' } as never));
    const c2 = create();
    c2.ngOnInit();
    expect(c2.genreList()).toEqual([]);
  });

  it("genreList() splits an applied ';'-joined override into chips", () => {
    getSong.mockReturnValue(of({ id: 'song-1', genre: 'Old' } as never));
    const c = create();
    c.ngOnInit();
    c.genreOverride.set('Latin Rock; Latin Music');
    expect(c.genreList()).toEqual(['Latin Rock', 'Latin Music']);
  });
});

// Issue #684: the chips were read-only — a curator could add a genre (and even
// that rendered as a replace) but never remove or reorder one.
describe('TrackInfoSheetComponent (genre chip editor, issue #684)', () => {
  const role = signal<string | null>('admin');
  const applyGenre = vi.fn();
  const getSong = vi.fn(() =>
    of({ id: 'song-1', genres: ['House', 'Techno', 'Minimal'] } as never),
  );

  beforeEach(async () => {
    applyGenre.mockReset();
    applyGenre.mockReturnValue(of({ ok: true, genre: 'House', genres: ['House'] }));
    role.set('admin');
    await TestBed.configureTestingModule({
      imports: [TrackInfoSheetComponent],
      providers: [
        {
          provide: LibraryApiService,
          useValue: {
            analyzeSong: vi.fn(() => of({ bpm: 120, source: 'analyzed' as const })),
            getGenreSuggestion: vi.fn(() => of(null)),
            applyGenre,
            getSong,
            getSongProvenance: vi.fn(() => of([])),
            getSongAcquisition: vi.fn(() => of(null)),
            getLyrics: vi.fn(() => of(null)),
            getIdentifyAvailable: vi.fn(() => of({ available: false })),
            identifyLibrarySong: vi.fn(() => of({ result: null, outcome: { kind: 'no-match' } })),
            applyIdentify: vi.fn(() => of({ ok: true, rescanned: true })),
          },
        },
        { provide: TranslateService, useValue: { t: (k: string) => k } },
        {
          provide: AuthService,
          useValue: { role, canCurate: computed(() => canCurateRole(asRole(role()))) },
        },
        { provide: LikeService, useValue: { isLiked: () => false, toggle: vi.fn() } },
      ],
    }).compileComponents();
  });

  function create() {
    const c = TestBed.createComponent(TrackInfoSheetComponent).componentInstance;
    (c as unknown as { songId: () => string }).songId = () => 'song-1';
    c.ngOnInit();
    return c;
  }

  it('addGenre() appends the typed genre and clears the input', () => {
    applyGenre.mockReturnValue(
      of({ ok: true, genre: 'House', genres: ['House', 'Techno', 'Minimal', 'Deep House'] }),
    );
    const c = create();
    c.newGenre.set('  Deep House  ');
    c.addGenre();
    expect(applyGenre).toHaveBeenCalledWith('song-1', 'Deep House', 'append');
    expect(c.genreList()).toEqual(['House', 'Techno', 'Minimal', 'Deep House']);
    expect(c.newGenre()).toBe('');
    expect(c.addingGenre()).toBe(false);
  });

  it('addGenre() ignores an empty input', () => {
    const c = create();
    c.newGenre.set('   ');
    c.addGenre();
    expect(applyGenre).not.toHaveBeenCalled();
  });

  it('removeGenre() sends the remaining set as a replace', () => {
    const c = create();
    c.removeGenre(1);
    expect(applyGenre).toHaveBeenCalledWith('song-1', 'House;Minimal', 'replace');
  });

  it('removeGenre() refuses to remove the last remaining genre', () => {
    getSong.mockReturnValueOnce(of({ id: 'song-1', genres: ['House'] } as never));
    const c = create();
    c.removeGenre(0);
    expect(applyGenre).not.toHaveBeenCalled();
  });

  it('dropping a chip reorders the set and sends it as a replace', () => {
    const c = create();
    const evt = { preventDefault: () => {}, dataTransfer: null } as unknown as DragEvent;
    c.onGenreDragStart({ dataTransfer: null } as unknown as DragEvent, 2);
    c.onGenreDrop(evt, 0);
    // 'Minimal' becomes the primary; the drag state is cleared either way.
    expect(applyGenre).toHaveBeenCalledWith('song-1', 'Minimal;House;Techno', 'replace');
    expect(c.genreDragIndex()).toBeNull();
    expect(c.genreDropIndex()).toBeNull();
  });

  it('dropping a chip on itself writes nothing', () => {
    const c = create();
    c.onGenreDragStart({ dataTransfer: null } as unknown as DragEvent, 1);
    c.onGenreDrop({ preventDefault: () => {} } as unknown as DragEvent, 1);
    expect(applyGenre).not.toHaveBeenCalled();
  });

  it('a failed write leaves the chips untouched and clears the spinner', () => {
    applyGenre.mockReturnValueOnce(throwError(() => new Error('boom')));
    const c = create();
    c.removeGenre(1);
    expect(c.applyingGenre()).toBe(false);
    expect(c.genreList()).toEqual(['House', 'Techno', 'Minimal']);
  });
});
