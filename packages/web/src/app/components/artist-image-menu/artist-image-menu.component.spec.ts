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

function make(opts: { albums?: unknown[]; getArtistFails?: boolean } = {}) {
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
  const c = TestBed.createComponent(ArtistImageMenuComponent).componentInstance;
  setInputValue(c.artistId, 'ar1');
  if (opts.albums) setInputValue(c.albums, opts.albums as never);
  return { c, calls };
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
});
