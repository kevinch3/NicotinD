import { TestBed } from '@angular/core/testing';
import { of, throwError, type Observable } from 'rxjs';
import { vi } from 'vitest';
import { ArtistInfoComponent } from './artist-info.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import type { ArtistInfoResponse } from '@nicotind/core';
import { setInputValue } from '../../../testing/signal-input';

// The web JIT vitest harness can't drive signal input()s via componentRef.setInput
// (silently no-ops) — see artist-genre-modal.component.spec.ts / song-picker.component.spec.ts
// for the same escape hatch.
describe('ArtistInfoComponent', () => {
  function setup(
    overrides: {
      bio?: string | null;
      urls?: string[];
      canCurate?: boolean;
      manualOverride?: boolean;
      refreshResult?: Observable<ArtistInfoResponse>;
    } = {},
  ) {
    TestBed.resetTestingModule();
    const refreshArtistInfo = vi
      .fn()
      .mockReturnValue(
        overrides.refreshResult ?? of<ArtistInfoResponse>({ bio: 'Refreshed bio', urls: [] }),
      );
    const setArtistInfo = vi
      .fn()
      .mockReturnValue(of<ArtistInfoResponse>({ bio: 'Edited bio', urls: [] }));
    const show = vi.fn();
    TestBed.configureTestingModule({
      imports: [ArtistInfoComponent],
      providers: [
        {
          provide: LibraryApiService,
          useValue: { refreshArtistInfo, setArtistInfo },
        },
        { provide: AuthService, useValue: { canCurate: () => overrides.canCurate ?? true } },
        { provide: ToastService, useValue: { show } },
      ],
    });
    const fixture = TestBed.createComponent(ArtistInfoComponent);
    const c = fixture.componentInstance;
    setInputValue(c.artistId, 'artist-1');
    setInputValue(c.bio, 'bio' in overrides ? (overrides.bio ?? null) : 'Existing bio');
    setInputValue(c.urls, overrides.urls ?? ['https://x.com']);
    setInputValue(c.manualOverride, overrides.manualOverride ?? false);
    fixture.detectChanges();
    return { fixture, c, refreshArtistInfo, setArtistInfo, show };
  }

  // ─── Existing behavior (preserved) ────────────────────────────────────────

  it('renders the bio and links', () => {
    const { fixture } = setup();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Existing bio');
    expect(el.textContent).toContain('Sources (1)');
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
    const { fixture, c } = setup();
    const el: HTMLElement = fixture.nativeElement;
    let emitted: { bio: string | null; urls: string[] } | undefined;
    c.updated.subscribe((v) => (emitted = v));
    el.querySelector<HTMLButtonElement>('[data-testid="artist-info-refresh"]')?.click();
    fixture.detectChanges();
    expect(emitted).toEqual({ bio: 'Refreshed bio', urls: [] });
  });

  it('shows no success toast when a bio is fetched (the inline bio is the confirmation)', () => {
    const { fixture, show } = setup();
    (fixture.nativeElement as HTMLElement)
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
    (fixture.nativeElement as HTMLElement)
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

  // ─── Formatter (issue #213 part 2) ────────────────────────────────────────

  it('strips Discogs BBCode from the rendered bio', () => {
    const { fixture } = setup({
      bio: 'A band called [a123] [l=Label] with [url=https://x.com]X[/url] and [m=456].',
      urls: [],
    });
    const el: HTMLElement = fixture.nativeElement;
    const bio = el.querySelector('[data-testid="artist-info-bio"]');
    expect(bio?.textContent).not.toContain('[a123]');
    expect(bio?.textContent).not.toContain('[l=Label]');
    expect(bio?.textContent).not.toContain('[url=');
    expect(bio?.textContent).not.toContain('[m=456]');
    // The URL-tag label is kept.
    expect(bio?.textContent).toContain('X');
  });

  it('extracts trailing bare URLs from the profile into Sources', () => {
    const { fixture } = setup({
      bio: 'A band.\n\nhttps://en.wikipedia.org/wiki/A\nhttps://x.com',
      urls: ['https://x.com'],
    });
    const el: HTMLElement = fixture.nativeElement;
    // 2 sources after dedup: wiki + x.com.
    expect(el.textContent).toContain('Sources (2)');
  });

  // ─── Sources disclosure (issue #213 part 3) ──────────────────────────────

  it('hides the source list behind a "Sources (N)" toggle', () => {
    const { fixture } = setup();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="artist-info-sources-list"]')).toBeNull();
    el.querySelector<HTMLButtonElement>('[data-testid="artist-info-sources-toggle"]')?.click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="artist-info-sources-list"]')).toBeTruthy();
  });

  it('dedupes the API urls and the profile-extracted urls', () => {
    const { fixture } = setup({
      bio: 'A band.\n\nhttps://x.com',
      urls: ['https://x.com', 'https://y.com'],
    });
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Sources (2)');
    el.querySelector<HTMLButtonElement>('[data-testid="artist-info-sources-toggle"]')?.click();
    fixture.detectChanges();
    const items = el.querySelectorAll('[data-testid="artist-info-sources-list"] a');
    expect(items.length).toBe(2);
    const hrefs = Array.from(items).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://x.com');
    expect(hrefs).toContain('https://y.com');
  });

  // ─── Show-more toggle (issue #213 part 4) ────────────────────────────────
  // The pure overflow logic (`isOverflowing`) is covered by artist-bio.spec.ts.
  // These tests verify the *template binding* — the show-more button is gated
  // on `hasOverflow()`, and clicking flips `expanded`.

  it('shows the show-more button when hasOverflow is true (template binding)', () => {
    // Bypass the DOM measurement: in jsdom the element is always 0×0, so the
    // real measurement would never report overflow. Setting the signal
    // directly exercises the template binding.
    const { fixture, c } = setup({ bio: 'A very long bio that overflows the clamp.' });
    c.hasOverflow.set(true);
    fixture.detectChanges();
    expect(c.hasOverflow()).toBe(true);
    expect(
      fixture.nativeElement.querySelector('[data-testid="artist-info-show-more"]'),
    ).toBeTruthy();
  });

  it('hides the show-more button when hasOverflow is false (Britney bug fix template side)', () => {
    const { fixture, c } = setup({ bio: 'Short bio.' });
    c.hasOverflow.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="artist-info-show-more"]')).toBeNull();
  });

  it('toggles between show-more and show-less on click', () => {
    const { fixture, c } = setup({ bio: 'Long bio that overflows.' });
    c.hasOverflow.set(true);
    fixture.detectChanges();
    const btn = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '[data-testid="artist-info-show-more"]',
    );
    btn?.click();
    fixture.detectChanges();
    expect(c.expanded()).toBe(true);
    expect(
      fixture.nativeElement.querySelector('[data-testid="artist-info-show-less"]'),
    ).toBeTruthy();
  });

  it('measureOverflow returns false when the bio element has no element (defensive)', () => {
    // Before the bio is set, the `#bio` element doesn't exist. The method
    // must no-op (returning false) so the toggle is hidden by default.
    const { c } = setup({ bio: null });
    c.hasOverflow.set(true); // pre-set
    (c as unknown as { measureOverflow: () => void }).measureOverflow();
    expect(c.hasOverflow()).toBe(false);
  });
});
