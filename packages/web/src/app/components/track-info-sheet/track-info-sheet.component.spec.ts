import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { TrackInfoSheetComponent } from './track-info-sheet.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';

// Instantiated without detectChanges so ngOnInit (which reads required inputs +
// fetches provenance) never runs; the analysis methods are exercised directly.
// The required `songId` signal input is stubbed on the instance because input
// binding is unreliable under the optimized test build CI runs.
describe('TrackInfoSheetComponent (analysis)', () => {
  const analyzeSong = vi.fn(() => of({ bpm: 122, source: 'analyzed' as const }));
  const getGenreSuggestion = vi.fn(() =>
    of({ current: 'IDM', suggested: 'Electronic', candidates: ['Electronic', 'IDM'], source: 'lidarr' as const }),
  );
  const applyGenre = vi.fn(() => of({ ok: true, genre: 'Electronic' }));
  const getSong = vi.fn(() => of({ id: 'song-1', bpm: 128, genre: 'Latin' } as never));
  const role = signal<string | null>('admin');

  beforeEach(async () => {
    analyzeSong.mockClear();
    analyzeSong.mockReturnValue(of({ bpm: 122, source: 'analyzed' as const }));
    getGenreSuggestion.mockClear();
    applyGenre.mockClear();
    applyGenre.mockReturnValue(of({ ok: true, genre: 'Electronic' }));
    getSong.mockClear();
    getSong.mockReturnValue(of({ id: 'song-1', bpm: 128, genre: 'Latin' } as never));
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
            getSong,
            getSongProvenance: vi.fn(() => of([])),
            getSongAcquisition: vi.fn(() => of(null)),
            getLyrics: vi.fn(() => of(null)),
          },
        },
        { provide: AuthService, useValue: { role } },
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

  it('applySuggestedGenre() overrides the current genre on success', () => {
    const c = create();
    c.applySuggestedGenre('Electronic');
    expect(applyGenre).toHaveBeenCalledWith('song-1', 'Electronic');
    expect(c.currentGenre()).toBe('Electronic');
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

  it('isAdmin() reflects the auth role', () => {
    const c = create();
    expect(c.isAdmin()).toBe(true);
    role.set('user');
    expect(c.isAdmin()).toBe(false);
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
});
