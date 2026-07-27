import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ArtistGenreModalComponent } from './artist-genre-modal.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { ToastService } from '../../services/toast.service';
import { setInputValue } from '../../../testing/signal-input';

describe('ArtistGenreModalComponent', () => {
  let setCalls: Array<{ id: string; genres: string; mode?: string }>;
  let clearCalls: string[];

  function make(
    override: {
      genres: string[];
      source: string;
      note: string | null;
      mode?: string | null;
    } | null = null,
    current: string[] = ['Latin', 'World'],
  ): ArtistGenreModalComponent {
    setCalls = [];
    clearCalls = [];
    // Some tests build several instances to compare provenance labels; the
    // TestBed must be torn down between them or configure() throws.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ArtistGenreModalComponent],
      providers: [
        {
          provide: LibraryApiService,
          useValue: {
            artistGenre: () => of({ artist: 'José Larralde', current, override }),
            // The modal also charts the genre spread (issue #222). It's a second,
            // independent fetch — the correction surface must keep working even
            // when it fails, which the "chart failure" case below asserts.
            artistGenreDistribution: () =>
              of({
                artist: 'José Larralde',
                trackCount: 10,
                genreCount: current.length,
                slices: current.map((g, i) => ({ genre: g, count: 10 - i, weight: (10 - i) / 10 })),
              }),
            setArtistGenre: (id: string, genres: string, mode?: string) => {
              setCalls.push({ id, genres, mode });
              return of({ ok: true, genres: genres.split(';'), resynced: true });
            },
            clearArtistGenre: (id: string) => {
              clearCalls.push(id);
              return of({ ok: true, removed: true });
            },
          },
        },
        { provide: ToastService, useValue: { show: () => 'id' } },
      ],
    });
    const c = TestBed.createComponent(ArtistGenreModalComponent).componentInstance;
    setInputValue(c.artistId, 'art-lar');
    setInputValue(c.artistName, 'José Larralde');
    TestBed.flushEffects();
    return c;
  }

  it('prefills the editor with the genres currently in effect', () => {
    expect(make().draft()).toBe('Latin; World');
  });

  it('prefills with the override when one exists, not the tag genres', () => {
    const c = make({ genres: ['Folclore', 'Chacarera'], source: 'user', note: null });
    expect(c.draft()).toBe('Folclore; Chacarera');
  });

  it('labels provenance so a wrong genre is obviously wrong', () => {
    expect(make().provenance()).toBe('from file tags');
    expect(make({ genres: ['Folclore'], source: 'user', note: null }).provenance()).toBe(
      'set by you',
    );
    expect(make({ genres: ['Latin'], source: 'musicbrainz', note: null }).provenance()).toBe(
      'from musicbrainz',
    );
  });

  it('parses the ";" list and treats the first entry as the primary', () => {
    const c = make();
    c.draft.set('Folclore; Chacarera ;  ');
    expect(c.parsed()).toEqual(['Folclore', 'Chacarera']);
  });

  it('gates save on a non-empty list', () => {
    const c = make();
    c.draft.set('   ;  ');
    expect(c.canSave()).toBe(false);
    c.draft.set('Folclore');
    expect(c.canSave()).toBe(true);
  });

  it('submits the parsed list ";"-joined and emits saved', () => {
    const c = make();
    let saved = 0;
    c.saved.subscribe(() => saved++);
    c.draft.set('Folclore; Chacarera');
    c.save();
    expect(setCalls).toEqual([{ id: 'art-lar', genres: 'Folclore;Chacarera', mode: 'append' }]);
    expect(saved).toBe(1);
  });

  it('defaults to append so a fix does not destroy per-song genres (issue #260)', () => {
    expect(make().mode()).toBe('append');
  });

  it('submits replace when the curator picks it', () => {
    const c = make();
    c.draft.set('Folclore; Chacarera');
    c.mode.set('replace');
    c.save();
    expect(setCalls).toEqual([{ id: 'art-lar', genres: 'Folclore;Chacarera', mode: 'replace' }]);
  });

  it('prefills the mode from an existing override, legacy null reading as replace', () => {
    // A row written before the mode column replaced; showing 'append' would
    // misrepresent what is actually in effect for that artist right now.
    expect(make({ genres: ['Folclore'], source: 'user', note: null }).mode()).toBe('replace');
    expect(make({ genres: ['Hip Hop'], source: 'user', note: null, mode: 'append' }).mode()).toBe(
      'append',
    );
  });

  it('reset clears the override', () => {
    const c = make({ genres: ['Folclore'], source: 'user', note: null });
    c.reset();
    expect(clearCalls).toEqual(['art-lar']);
  });

  it('loads the genre spread for the radar (issue #222)', () => {
    const c = make(null, ['Folclore', 'Chacarera']);
    expect(c.distribution().map((s) => s.genre)).toEqual(['Folclore', 'Chacarera']);
    expect(c.distributionTracks()).toBe(10);
  });

  it('keeps the correction surface usable when the spread fetch fails', () => {
    // The chart is a nice-to-have beside the edit form; an outage on that second
    // endpoint must hide it, never block the fix the user came here to make.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ArtistGenreModalComponent],
      providers: [
        {
          provide: LibraryApiService,
          useValue: {
            artistGenre: () => of({ artist: 'José Larralde', current: ['Latin'], override: null }),
            artistGenreDistribution: () => throwError(() => new Error('sidecar down')),
            setArtistGenre: () => of({ ok: true, genres: [], resynced: true }),
            clearArtistGenre: () => of({ ok: true, removed: true }),
          },
        },
        { provide: ToastService, useValue: { show: () => 'id' } },
      ],
    });
    const c = TestBed.createComponent(ArtistGenreModalComponent).componentInstance;
    setInputValue(c.artistId, 'art-lar');
    setInputValue(c.artistName, 'José Larralde');
    TestBed.flushEffects();

    expect(c.distribution()).toEqual([]);
    expect(c.draft()).toBe('Latin');
    c.draft.set('Folclore');
    expect(c.canSave()).toBe(true);
  });
});
