import { ɵSIGNAL as SIGNAL } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ArtistInfoComponent } from './artist-info.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';

// The web JIT vitest harness can't drive signal input()s via componentRef.setInput
// (silently no-ops) — see artist-genre-modal.component.spec.ts / song-picker.component.spec.ts
// for the same escape hatch.
function setInputValue<T>(inputSignal: () => T, value: T): void {
  (inputSignal as unknown as Record<typeof SIGNAL, { value: T }>)[SIGNAL].value = value;
}

describe('ArtistInfoComponent', () => {
  function setup(
    overrides: {
      bio?: string | null;
      urls?: string[];
      canCurate?: boolean;
      refreshResult?: ReturnType<typeof of>;
    } = {},
  ) {
    TestBed.resetTestingModule();
    const refreshArtistInfo = vi
      .fn()
      .mockReturnValue(overrides.refreshResult ?? of({ bio: 'Refreshed bio', urls: [] }));
    const setArtistInfo = vi.fn().mockReturnValue(of({ bio: 'Edited bio', urls: [] }));
    const show = vi.fn();
    TestBed.configureTestingModule({
      imports: [ArtistInfoComponent],
      providers: [
        { provide: LibraryApiService, useValue: { refreshArtistInfo, setArtistInfo } },
        { provide: AuthService, useValue: { canCurate: () => overrides.canCurate ?? true } },
        { provide: ToastService, useValue: { show } },
      ],
    });
    const fixture = TestBed.createComponent(ArtistInfoComponent);
    const c = fixture.componentInstance;
    setInputValue(c.artistId, 'artist-1');
    setInputValue(c.bio, 'bio' in overrides ? (overrides.bio ?? null) : 'Existing bio');
    setInputValue(c.urls, overrides.urls ?? ['https://x.com']);
    fixture.detectChanges();
    return { fixture, refreshArtistInfo, setArtistInfo, show };
  }

  it('renders the bio and links', () => {
    const { fixture } = setup();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Existing bio');
    expect(el.querySelector('a[href="https://x.com"]')).toBeTruthy();
  });

  it('shows an empty state when there is no bio and no links', () => {
    const { fixture } = setup({ bio: null, urls: [] });
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('No bio available');
  });

  it('shows the refresh button only for a curator', () => {
    const { fixture } = setup({ canCurate: false });
    expect(fixture.nativeElement.querySelector('[data-testid="artist-info-refresh"]')).toBeNull();
  });

  it('calls refreshArtistInfo and updates the shown bio on click', () => {
    const { fixture, refreshArtistInfo } = setup();
    const el: HTMLElement = fixture.nativeElement;
    el.querySelector<HTMLButtonElement>('[data-testid="artist-info-refresh"]')?.click();
    fixture.detectChanges();
    expect(refreshArtistInfo).toHaveBeenCalledWith('artist-1');
    expect(el.textContent).toContain('Refreshed bio');
  });

  it('emits updated after a successful refresh', () => {
    const { fixture } = setup();
    const el: HTMLElement = fixture.nativeElement;
    const c = fixture.componentInstance;
    let emitted: { bio: string | null; urls: string[] } | undefined;
    c.updated.subscribe((v) => (emitted = v));
    el.querySelector<HTMLButtonElement>('[data-testid="artist-info-refresh"]')?.click();
    fixture.detectChanges();
    expect(emitted).toEqual({ bio: 'Refreshed bio', urls: [] });
  });

  it('shows no success toast when a bio is fetched (the inline bio is the confirmation)', () => {
    const { fixture, show } = setup();
    fixture.nativeElement
      .querySelector<HTMLButtonElement>('[data-testid="artist-info-refresh"]')
      ?.click();
    fixture.detectChanges();
    expect(show).not.toHaveBeenCalled();
  });

  it('surfaces an error toast when the refresh finds no bio or links', () => {
    const { fixture, show } = setup({
      bio: null,
      urls: [],
      refreshResult: of({ bio: null, urls: [] }),
    });
    fixture.nativeElement
      .querySelector<HTMLButtonElement>('[data-testid="artist-info-refresh"]')
      ?.click();
    fixture.detectChanges();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });

  it('surfaces an error toast when refresh fails', () => {
    const { fixture, show } = setup({
      refreshResult: throwError(() => new Error('boom')) as never,
    });
    const el: HTMLElement = fixture.nativeElement;
    el.querySelector<HTMLButtonElement>('[data-testid="artist-info-refresh"]')?.click();
    fixture.detectChanges();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });
});
