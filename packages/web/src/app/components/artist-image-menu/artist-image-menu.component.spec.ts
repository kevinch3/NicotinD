import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { ArtistImageMenuComponent } from './artist-image-menu.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { setInputValue } from '../../../testing/signal-input';

/**
 * These cases moved here from artist-detail.component.spec when the control was
 * extracted for the Artists grid (issue #250 gap 4) — the behaviour is the same,
 * it just has one home now instead of being reachable only from the artist page.
 */
interface Calls {
  upload: Array<{ id: string; file: File }>;
  fromAlbum: Array<{ id: string; albumId: string }>;
  reset: string[];
  autoFetch: string[];
  getArtist: string[];
}

function make(opts: { albums?: unknown[]; getArtistFails?: boolean; sources?: string[] } = {}) {
  const calls: Calls = { upload: [], fromAlbum: [], reset: [], autoFetch: [], getArtist: [] };
  const api = {
    uploadArtistImage: vi.fn((id: string, file: File) => {
      calls.upload.push({ id, file });
      return of({ ok: true });
    }),
    setArtistImageFromAlbum: vi.fn((id: string, albumId: string) => {
      calls.fromAlbum.push({ id, albumId });
      return of({ ok: true });
    }),
    resetArtistImage: vi.fn((id: string) => {
      calls.reset.push(id);
      return of({ ok: true });
    }),
    autoFetchArtistImage: vi.fn((id: string) => {
      calls.autoFetch.push(id);
      return of({ filled: true });
    }),
    // Live source availability (issue #422) — defaults to "lidarr available".
    artistImageSources: vi.fn(() => of({ sources: opts.sources ?? ['lidarr'] })),
    getArtist: vi.fn((id: string) => {
      calls.getArtist.push(id);
      return opts.getArtistFails
        ? throwError(() => new Error('boom'))
        : of({
            artist: { id, name: 'X', albumCount: 1 },
            albums: [{ id: 'lazy-1', name: 'Lazy', artist: 'X' }],
            singlesAndEps: [{ id: 'lazy-ep', name: 'LazyEP', artist: 'X' }],
          });
    }),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ArtistImageMenuComponent],
    providers: [
      { provide: LibraryApiService, useValue: api },
      { provide: AuthService, useValue: { token: () => 'tok', canCurate: () => true } },
    ],
  });
  const fixture = TestBed.createComponent(ArtistImageMenuComponent);
  const c = fixture.componentInstance;
  setInputValue(c.artistId, 'ar1');
  if (opts.albums) setInputValue(c.albums, opts.albums as never);
  // `fixture` is returned so a case can assert on the rendered DOM. Every case
  // here used to drive the component class only, which is exactly how a trigger
  // that never rendered survived a 14-case suite — see the projection test below.
  return { c, calls, fixture };
}

const fileEvent = (files: File[]) => ({ target: { files, value: 'x' } }) as unknown as Event;

describe('ArtistImageMenuComponent', () => {
  let m: ReturnType<typeof make>;
  beforeEach(() => {
    m = make({ albums: [{ id: 'a1', name: 'One', artist: 'X' }] });
  });

  it('uploads a selected file and reports the change', async () => {
    const changed = vi.fn();
    m.c.changed.subscribe(changed);
    const file = new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' });

    await m.c.onFileSelected(fileEvent([file]));

    expect(m.calls.upload).toHaveLength(1);
    expect(m.calls.upload[0].id).toBe('ar1');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(m.c.busy()).toBe(false);
  });

  it('does nothing when no file is selected', async () => {
    const changed = vi.fn();
    m.c.changed.subscribe(changed);
    await m.c.onFileSelected(fileEvent([]));
    expect(m.calls.upload).toHaveLength(0);
    expect(changed).not.toHaveBeenCalled();
  });

  it('copies a chosen album cover and closes the picker', async () => {
    await m.c.openAlbumPicker();
    expect(m.c.albumPickerOpen()).toBe(true);

    await m.c.pickAlbumCover('a2');

    expect(m.calls.fromAlbum).toEqual([{ id: 'ar1', albumId: 'a2' }]);
    expect(m.c.albumPickerOpen()).toBe(false);
  });

  it('resets the override', async () => {
    await m.c.reset();
    expect(m.calls.reset).toEqual(['ar1']);
  });

  it('auto-fetches a portrait from the provider chain', async () => {
    await m.c.autoFetch();
    expect(m.calls.autoFetch).toEqual(['ar1']);
  });

  it('uses the albums it was given without an extra request (artist page)', async () => {
    await m.c.openAlbumPicker();
    expect(m.calls.getArtist).toHaveLength(0);
    expect(m.c.pickable().map((a) => a.id)).toEqual(['a1']);
  });

  // The grid has only a tile, so the component fetches on demand rather than
  // making every tile pay for a request it will almost never need.
  it('lazily fetches albums when none were provided (grid tile)', async () => {
    const g = make();
    await g.c.openAlbumPicker();
    expect(g.calls.getArtist).toEqual(['ar1']);
    expect(g.c.pickable().map((a) => a.id)).toEqual(['lazy-1', 'lazy-ep']);
    expect(g.c.loadingAlbums()).toBe(false);
  });

  it('shows an empty picker rather than throwing when the lazy fetch fails', async () => {
    const g = make({ getArtistFails: true });
    await g.c.openAlbumPicker();
    expect(g.c.pickable()).toEqual([]);
    expect(g.c.albumPickerOpen()).toBe(true);
    expect(g.c.loadingAlbums()).toBe(false);
  });

  it('never emits a change when the request fails, so the cache-bust stays put', async () => {
    const failing = make({ albums: [] });
    failing.c['api'].resetArtistImage = vi.fn(() => throwError(() => new Error('nope')));
    const changed = vi.fn();
    failing.c.changed.subscribe(changed);

    await failing.c.reset();

    expect(changed).not.toHaveBeenCalled();
    expect(failing.c.busy()).toBe(false);
  });
  // Issue #422: "Fetch automatically" is gated on the server's live source list —
  // enabled when any provider (Lidarr / Spotify / Discogs) can serve a portrait,
  // disabled when none can.
  describe('auto-fetch availability gate (issue #422)', () => {
    it('reports unavailable and refuses to fetch when the server lists no sources', async () => {
      const g = make({ sources: [] });
      expect(g.c.imageSources.autoFetchUnavailable()).toBe(true);
      await g.c.autoFetch();
      expect(g.calls.autoFetch).toHaveLength(0);
    });

    it('stays enabled when a provider (e.g. discogs) is live', async () => {
      const g = make({ sources: ['discogs'] });
      expect(g.c.imageSources.autoFetchUnavailable()).toBe(false);
      await g.c.autoFetch();
      expect(g.calls.autoFetch).toEqual(['ar1']);
    });

    it('stays enabled while availability is still unknown (request not resolved)', () => {
      const g = make();
      // Force the not-yet-loaded state: a fresh service before any response.
      g.c.imageSources.sources.set(null);
      expect(g.c.imageSources.autoFetchUnavailable()).toBe(false);
    });
  });

  /**
   * The control is only useful if a user can reach it, and this suite could not
   * see that: every other case calls a method on the component class, so the
   * trigger was projected with the wrong attribute (`trigger` instead of
   * `menuTrigger`) and rendered nowhere on the artist page or the Artists grid
   * while all 14 cases stayed green.
   */
  describe('the trigger actually renders (regression)', () => {
    it('projects the trigger into the menu panel’s trigger slot', () => {
      const { fixture } = make({ albums: [{ id: 'a1', name: 'One', artist: 'X' }] });
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;

      const trigger = el.querySelector('[data-testid="artist-image-menu-trigger"]');
      expect(trigger).not.toBeNull();
      // The load-bearing assertion. The button is in this component's template
      // either way, so its mere existence proves nothing — what broke is that it
      // never landed inside MenuPanelComponent's `[menuTrigger]` slot, whose host
      // carries `data-menu-trigger` and owns the click that opens the panel.
      // MenuPanelComponent has no catch-all <ng-content>, so a mis-named
      // attribute is dropped silently rather than failing anywhere.
      expect(trigger!.closest('[data-menu-trigger]')).not.toBeNull();
    });

    it('opens the menu when that trigger is clicked', () => {
      const { fixture } = make({ albums: [{ id: 'a1', name: 'One', artist: 'X' }] });
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;

      expect(el.querySelector('[data-testid="artist-image-upload"]')).toBeNull();
      (el.querySelector('[data-testid="artist-image-menu-trigger"]') as HTMLElement).click();
      fixture.detectChanges();

      // Reached through the real click path, so the trigger is wired and not
      // merely present. Asserted on the projected button's own testid: the
      // panel's `panelTestId` is an `input()`, which never populates under this
      // project's JIT harness.
      expect(el.querySelector('[data-testid="artist-image-upload"]')).not.toBeNull();
    });
  });
});
