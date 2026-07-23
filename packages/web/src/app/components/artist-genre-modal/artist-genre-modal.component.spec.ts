import { ɵSIGNAL as SIGNAL } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ArtistGenreModalComponent } from './artist-genre-modal.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { ToastService } from '../../services/toast.service';

/** Same ɵSIGNAL escape hatch as artist-identity-modal.component.spec.ts (JIT input() limitation). */
function setInputValue<T>(inputSignal: () => T, value: T): void {
  (inputSignal as unknown as Record<typeof SIGNAL, { value: T }>)[SIGNAL].value = value;
}

describe('ArtistGenreModalComponent', () => {
  let setCalls: Array<{ id: string; genres: string }>;
  let clearCalls: string[];

  function make(
    override: { genres: string[]; source: string; note: string | null } | null = null,
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
            setArtistGenre: (id: string, genres: string) => {
              setCalls.push({ id, genres });
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
    expect(make({ genres: ['Folclore'], source: 'user', note: null }).provenance()).toBe('set by you');
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
    expect(setCalls).toEqual([{ id: 'art-lar', genres: 'Folclore;Chacarera' }]);
    expect(saved).toBe(1);
  });

  it('reset clears the override', () => {
    const c = make({ genres: ['Folclore'], source: 'user', note: null });
    c.reset();
    expect(clearCalls).toEqual(['art-lar']);
  });
});
