import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { ArtistOriginComponent, type ArtistOriginValue } from './artist-origin.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { setInputValue } from '../../../testing/signal-input';

describe('ArtistOriginComponent', () => {
  function setup(overrides: { origin?: ArtistOriginValue | null; canCurate?: boolean } = {}) {
    TestBed.resetTestingModule();
    const setArtistOrigin = vi
      .fn()
      .mockReturnValue(of({ origin: { country: 'AR', source: 'user' } }));
    TestBed.configureTestingModule({
      imports: [ArtistOriginComponent],
      providers: [
        { provide: LibraryApiService, useValue: { setArtistOrigin } },
        { provide: AuthService, useValue: { canCurate: () => overrides.canCurate ?? true } },
      ],
    });
    const fixture = TestBed.createComponent(ArtistOriginComponent);
    const c = fixture.componentInstance;
    setInputValue(c.artistId, 'artist-1');
    setInputValue(c.origin, 'origin' in overrides ? (overrides.origin ?? null) : null);
    fixture.detectChanges();
    return { fixture, c, setArtistOrigin };
  }

  it('renders flag + localized country name from the input', () => {
    const { fixture } = setup({ origin: { country: 'AR', source: 'musicbrainz' } });
    const el = fixture.debugElement.query(By.css('[data-testid="artist-origin"]'));
    expect(el).not.toBeNull();
    expect(el.nativeElement.textContent).toContain('🇦🇷');
    expect(el.nativeElement.textContent).toContain('Argentina');
  });

  it('hides the set-origin affordance for a non-curator with no origin', () => {
    const { fixture } = setup({ origin: null, canCurate: false });
    expect(fixture.debugElement.query(By.css('[data-testid="artist-origin-set"]'))).toBeNull();
    expect(fixture.debugElement.query(By.css('[data-testid="artist-origin"]'))).toBeNull();
  });

  it('search matches by localized name, capped, and pick issues the PUT + emits changed', () => {
    const { fixture, c, setArtistOrigin } = setup({ origin: null, canCurate: true });
    let emitted: ArtistOriginValue | undefined;
    c.changed.subscribe((v) => (emitted = v));
    c.toggleEditor();
    c.query.set('argent');
    expect(c.matches()).toContain('AR');
    c.pick('AR');
    expect(setArtistOrigin).toHaveBeenCalledWith('artist-1', 'AR');
    expect(emitted).toEqual({ country: 'AR', source: 'user' });
    expect(c.editing()).toBe(false);
  });

  it('the clear pick sends null (a user tombstone)', () => {
    const { c, setArtistOrigin } = setup({ origin: { country: 'AR', source: 'user' } });
    c.pick(null);
    expect(setArtistOrigin).toHaveBeenCalledWith('artist-1', null);
  });
});
